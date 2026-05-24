/*
 * Copyright (c) 2026 Terry Packer.
 *
 * This file is part of Terry Packer's Work.
 * See www.terrypacker.com for further info.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { IndexedMinHeap } from './indexed-min-heap.js';
import { EventBus }  from './event-bus.js';
import { ActionNode, SimulationEventGraph } from './simulation-event-graph.js'
import { JournalEntry, Journal } from './journal.js'
import { ReducerPipeline } from './reducers.js'
import { HandlerRegistry } from './handlers.js'
import { DateUtils } from "./date-utils.js";
import {
  EventStartBusMessage,
  EventEndBusMessage,
  EventHandledMessage,
  ActionResultMessage,
  ReducerResultMessage
} from "./bus-messages.js";
import { SimulationHistory } from "./simulation-history.js";
import { SimulationState } from "./simulation-state.js";

const INTERNAL_SCHEDULING_HANDLER_NAME = 'INTERNAL_SCHEDULING_HANDLER_NAME';

/**
 * Thrown (not as a real error) when the simulation hits a breakpoint.
 * Caught inside stepTo() — never surfaces to user code.
 */
export class BreakpointSignal extends Error {
  constructor(context) {
    super('Simulation paused at breakpoint');
    this.name = 'BreakpointSignal';
    this.context = context;
  }
}

/**
 *
 * // run baseline
 * sim.stepTo(midPoint);
 *
 * // branch
 * const simA = sim.branch();
 * const simB = sim.branch();
 *
 * // try different strategies
 * simA.applyStrategy("conservative");
 * simB.applyStrategy("aggressive");
 *
 * simA.stepTo(end);
 * simB.stepTo(end);
 *
 */
export class Simulation {
  constructor(startDate, { seed = 1, initialState = {}, opts = {} } = {}) {
    this.currentDate = this.normalizeDate(startDate);

    this.queue = new IndexedMinHeap((a, b) => a.date - b.date,
            item => item.instanceId, item => item.type);
    this.bus = new EventBus();

    this.handlers = new HandlerRegistry();   // eventType -> [HandlerEntry]
    this.reducers = new ReducerPipeline();   // actionType -> reducer

    this.state = structuredClone(
      initialState instanceof SimulationState ? initialState.toPlain() : initialState
    );

    this.rng = this.createRNG(seed);

    this.history = new SimulationHistory(this);
    this.history.enableSnapshots = opts.enableSnapshots ?? true;
    this.history.snapshotInterval = opts.snapshotInterval ?? 1; // every N events

    this.journal = new Journal({enabled: true});

    this.nextActionId = 0;
    this.nextEventInstanceId = 0;
    this.actionGraph = new SimulationEventGraph();

    // ── Breakpoint / pause control ─────────────────────────────────────────
    //
    // paused:             true when execution has stopped at a breakpoint
    // breakpointHit:      context object describing what triggered the pause
    // resuming:           skip the NEXT breakpoint check (so we step past the
    //                     node we're currently paused on)
    // breakpointsEnabled: disabled during rewind/replay to avoid false triggers
    // pendingExecution:   saved mid-event state so stepTo() can resume exactly
    //                     where it paused (handler/action/reducer level)
    // breakpointNodeIds:  Set of config-graph node IDs that have breakpoints;
    //                     managed by the UI layer (base-app._syncBreakpointsToSim)
    this.control = {
      paused: false,
      breakpointHit: null,
      resuming: false,
      breakpointsEnabled: true,
      pendingExecution: null,
      breakpointNodeIds: new Set(),
    };
  }

  // Backward-compat accessors so existing code and tests can still use sim.snapshots etc.
  get snapshots()        { return this.history.snapshots; }
  get snapshotCursor()   { return this.history.snapshotCursor; }
  set snapshotCursor(v)  { this.history.snapshotCursor = v; }
  get enableSnapshots()  { return this.history.enableSnapshots; }
  set enableSnapshots(v) { this.history.enableSnapshots = v; }
  get snapshotInterval() { return this.history.snapshotInterval; }
  set snapshotInterval(v){ this.history.snapshotInterval = v; }
  get eventCounter()     { return this.history.eventCounter; }
  set eventCounter(v)    { this.history.eventCounter = v; }

  deepClone(obj) {
    return structuredClone(obj);
  }

  unschedule(type) {
    return this.queue.removeAllByType(type);
  }

  schedule(event) {
    this.queue.push({
      data: {},
      meta: {},
      ...event,
      instanceId: this.nextEventInstanceId++,
      date: this.normalizeDate(event.date),
    });
  }

  scheduleRecurring({startDate, type, intervalFn, ...eventFields}) {
    this.register(type, ({ sim, date }) => {
      sim.schedule({ type, ...eventFields, date: intervalFn(date) });
    });

    // Initial event
    this.schedule({ type, ...eventFields, date: startDate });
  }

  scheduleQuarterly(opts) {
    return this.scheduleRecurring({
      ...opts,
      intervalFn: (d) => DateUtils.addMonths(d, 3)
    });
  };

  scheduleAnnually(opts) {
    return this.scheduleRecurring({
      ...opts,
      intervalFn: (d) => DateUtils.addYears(d, 1)
    });
  };

  normalizeDate(d) {
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  }

  createRNG(seed) {
    this.rngState = seed;

    return () => {
      let s = Math.trunc(this.rngState);
      s = Math.trunc(s + 0x6D2B79F5);
      let t = Math.imul(s ^ s >>> 15, 1 | s);
      t ^= t + Math.imul(t ^ t >>> 7, 61 | t);

      this.rngState = s;

      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }

  register(type, handlerOrEntry) {
    this.handlers.register(type, handlerOrEntry, INTERNAL_SCHEDULING_HANDLER_NAME);
  }

  // ── Breakpoint helpers ─────────────────────────────────────────────────────

  /**
   * Returns true if node `id` has a breakpoint set, breakpoints are enabled,
   * and we are not currently in "resuming" mode (stepping past the current node).
   */
  _shouldPause(id) {
    if (!this.control.breakpointsEnabled) return false;
    if (this.control.resuming) return false;
    if (id == null) return false;
    return this.control.breakpointNodeIds.has(id);
  }

  // ── Core execution ─────────────────────────────────────────────────────────

  /**
   * Execute one event.  Supports mid-event resume by accepting a startHandlerIdx
   * (skip handlers that already ran) and the original stateBefore snapshot
   * (needed to publish a correct EVENT_OCCURRENCE_END message).
   *
   * Throws BreakpointSignal when it hits a handler breakpoint; saves resume
   * context in this.control.pendingExecution before throwing.
   *
   * @param {object}  event
   * @param {object}  [opts]
   * @param {number}  [opts.startHandlerIdx=0]  Resume from this handler index.
   * @param {object}  [opts.stateBefore=null]   Pre-event state snapshot (from prior partial run).
   */
  execute(event, { startHandlerIdx = 0, stateBefore: savedStateBefore = null } = {}) {
    const handlers = this.handlers.get(event.type) || [];

    // Capture state-before once (at true event start, not on resume).
    const stateBefore = savedStateBefore ?? structuredClone(this.state);

    if (startHandlerIdx === 0) {
      this.bus.publish(new EventStartBusMessage({
        date: new Date(this.currentDate),
        sim: this,
        payload: { event },
        stateSnapshot: stateBefore
      }));
    }

    for (let i = startHandlerIdx; i < handlers.length; i++) {
      const entry = handlers[i];

      // ── Handler breakpoint ──────────────────────────────────────────────
      if (this._shouldPause(entry.id)) {
        this.control.pendingExecution = {
          type: 'handler',
          event,
          handlerIdx: i,
          stateBefore
        };
        this.control.breakpointHit = { stage: 'handler:before', handler: entry };
        this.control.paused = true;
        throw new BreakpointSignal({ stage: 'handler:before', handler: entry });
      }
      // Past this handler's breakpoint check — clear resuming flag so subsequent
      // handlers (and their nested action/reducer loops) get checked normally.
      this.control.resuming = false;

      const actions = entry.call({
        sim: this,
        date: this.currentDate,
        data: event.data,
        meta: event.meta,
        state: this.state
      });

      if (entry.name !== INTERNAL_SCHEDULING_HANDLER_NAME) {
        this.bus.publish(new EventHandledMessage({
          date: new Date(this.currentDate),
          sim: this,
          stateSnapshot: stateBefore,
          payload: { handler: entry, event }
        }));
      }

      // Pass handlerContext so that if applyActions pauses mid-queue we know
      // which handler to resume from (the NEXT one: i + 1).
      this.applyActions(actions, event, {
        handlerContext: { event, handlerIdx: i + 1, stateBefore }
      });

      // snapshot logic
      this.history.eventCounter++;
      if (
        this.history.enableSnapshots &&
        this.history.eventCounter % this.history.snapshotInterval === 0
      ) {
        this.history.takeSnapshot();
      }
    }

    // Publish the EVENT_OCCURRENCE_END message.
    const stateSnapshot = structuredClone(this.state);
    this.bus.publish(new EventEndBusMessage({
      date: new Date(this.currentDate),
      sim: this,
      stateSnapshot: stateSnapshot,
      payload: {
        event,
        stateBefore,
        stateAfter: stateSnapshot,
        sourceEvent: event
      }
    }));

    this.control.pendingExecution = null; // Completed cleanly
  }

  /**
   * Apply a list of actions produced by a handler.
   *
   * @param {Array|object|null} actions       Actions to apply (may be null).
   * @param {object}            sourceEvent   The originating simulation event.
   * @param {object}            [opts]
   * @param {Array}             [opts.existingQueue]  Pre-built action queue for resume.
   * @param {object}            [opts.handlerContext] { event, handlerIdx, stateBefore } —
   *                            saved so a mid-queue pause can resume the right handler.
   */
  applyActions(actions, sourceEvent, { existingQueue = null, handlerContext = null } = {}) {
    if (!actions && !existingQueue) return;

    let queue;
    if (existingQueue) {
      queue = existingQueue;
    } else {
      const rawActions = Array.isArray(actions) ? [...actions] : [actions];
      queue = [];
      let prev = null;
      for (const a of rawActions) {
        const tagged = this.tagAction(a, prev);
        queue.push(tagged);
        prev = tagged;
      }
    }

    this._processActionQueue(queue, sourceEvent, handlerContext);
  }

  /**
   * Inner loop: process all actions in `queue`, running their reducers.
   * May throw BreakpointSignal — saves pendingExecution before doing so.
   *
   * @param {Array}  queue           Mutable action queue (shifted from front).
   * @param {object} sourceEvent
   * @param {object} handlerContext  { event, handlerIdx, stateBefore } for resume.
   */
  _processActionQueue(queue, sourceEvent, handlerContext) {
    const sourceEventType = sourceEvent.type;
    const MAX_ACTIONS = 10000;
    let processed = 0;

    while (queue.length > 0) {
      if (processed++ > MAX_ACTIONS) {
        throw new Error("Infinite action loop detected");
      }

      const action = queue.shift();

      // ── Action breakpoint ─────────────────────────────────────────────
      if (this._shouldPause(action.id)) {
        this.control.pendingExecution = {
          type: 'action',
          actionQueue: [action, ...queue],  // put action back so it runs on resume
          sourceEvent,
          handlerContext
        };
        this.control.breakpointHit = { stage: 'action', action };
        this.control.paused = true;
        throw new BreakpointSignal({ stage: 'action', action });
      }
      this.control.resuming = false;

      const reducers = this.reducers.get(action.type);

      //Emit Action Result Message
      const unwrappedReducers = [];
      if (!reducers || reducers.length === 0) {
        reducers.forEach(r => {
          unwrappedReducers.push(r.reducer);
        })
      }
      const prevState = structuredClone(this.state);
      //TODO This is where we would add the call to the ScriptAction to mutate it
      this.bus.publish(new ActionResultMessage({
        date: new Date(this.currentDate),
        sim: this,
        payload: {
          action: action,
          reducers: unwrappedReducers,
          sourceEvent: sourceEvent
        },
        stateSnapshot: prevState
      }));

      if (!reducers || reducers.length === 0) continue;

      // Run all reducers for this action.  Emitted actions are unshifted onto
      // `queue` so they execute before the remaining queued actions.
      this._processReducers(action, 0, reducers, queue, sourceEvent, sourceEventType, handlerContext);
    }
  }

  /**
   * Run reducers for `action` starting at `startIdx`.
   * Emits new actions by unshifting them onto the shared `actionQueue`.
   * May throw BreakpointSignal — saves pendingExecution before doing so.
   *
   * @param {object} action
   * @param {number} startIdx       First reducer index to run.
   * @param {Array}  reducers       All reducers registered for this action type.
   * @param {Array}  actionQueue    Shared queue (mutated — emitted actions prepended).
   * @param {object} sourceEvent
   * @param {string} sourceEventType
   * @param {object} handlerContext
   */
  _processReducers(action, startIdx, reducers, actionQueue, sourceEvent, sourceEventType, handlerContext) {
    for (let j = startIdx; j < reducers.length; j++) {
      const reducerWrapper = reducers[j];

      // ── Reducer breakpoint ──────────────────────────────────────────
      if (this._shouldPause(reducerWrapper.reducer?.id)) {
        this.control.pendingExecution = {
          type: 'reducer',
          action,
          reducerIdx: j,
          reducers,
          actionQueue: [...actionQueue],  // snapshot of remaining queue
          sourceEvent,
          sourceEventType,
          handlerContext
        };
        this.control.breakpointHit = { stage: 'reducer:before', reducer: reducerWrapper.reducer };
        this.control.paused = true;
        throw new BreakpointSignal({ stage: 'reducer:before', reducer: reducerWrapper.reducer });
      }
      this.control.resuming = false;

      const prevState = structuredClone(this.state);
      const result = reducerWrapper.fn(this.state, action, this.currentDate);

      // Publish the REDUCER_RESULT message.
      let stateSnapshot;
      if (!result) {
        stateSnapshot = prevState;
      } else if (result.state) {
        stateSnapshot = structuredClone(result.state);
      } else {
        stateSnapshot = structuredClone(result);
      }

      this.bus.publish(new ReducerResultMessage({
        date: new Date(this.currentDate),
        sim: this,
        stateSnapshot: stateSnapshot,
        payload: {
          reducer: reducerWrapper.reducer,
          action: action,
          stateBefore: prevState,
          sourceEvent: sourceEvent
        }
      }));

      if (!result) continue;

      let nextState;
      let emitted = [];

      if (result.state) {
        nextState = result.state;
      } else {
        nextState = result;
      }

      if (result.next) {
        emitted = (Array.isArray(result.next)
            ? result.next
            : [result.next]).map(a => this.tagAction(a, action));

        // Prepend emitted actions so they run before remaining queued actions.
        actionQueue.unshift(...emitted);
      }

      this.state = nextState;

      const parentId = action._parent ?? null;
      this.addActionNode({
        action,
        parentId,
        reducerName: reducerWrapper.name,
        prevState,
        nextState,
        sourceEvent
      });

      if (this.journal.enabled) {
        this.journal.addEntry(new JournalEntry({
          date: new Date(this.currentDate),
          eventType: sourceEventType,
          action: structuredClone(action),
          reducer: reducerWrapper.name,
          prevState,
          nextState: structuredClone(this.state),
          emittedActions: structuredClone(emitted),
          sourceEvent
        }));
      }
    }
  }

  // ── Breakpoint resume ──────────────────────────────────────────────────────

  /**
   * Re-enter execution from wherever we paused (handler, action, or reducer).
   *
   * The resume strategy per pause type:
   *   handler  → call execute() from the saved handler index
   *   action   → process the saved action queue, then continue remaining handlers
   *   reducer  → finish reducers for the current action, process remaining
   *               action queue, then continue remaining handlers
   *
   * Sets control.resuming = true before re-entering so the node we paused ON
   * (the one with the breakpoint) is not re-triggered immediately.
   *
   * May throw BreakpointSignal if another breakpoint is hit during the resume.
   */
  _resumeFromPendingExecution() {
    const pe = this.control.pendingExecution;
    this.control.pendingExecution = null;
    this.control.resuming = true;

    if (pe.type === 'handler') {
      // Re-enter execute() starting from the handler that triggered the break.
      // resuming=true skips its breakpoint check, then clears itself.
      this.execute(pe.event, {
        startHandlerIdx: pe.handlerIdx,
        stateBefore: pe.stateBefore
      });

    } else if (pe.type === 'action') {
      // Process the action queue (first entry is the one with the breakpoint).
      // After the queue drains, continue the handler loop.
      this._processActionQueue(pe.actionQueue, pe.sourceEvent, pe.handlerContext);
      if (pe.handlerContext) {
        this.execute(pe.handlerContext.event, {
          startHandlerIdx: pe.handlerContext.handlerIdx,
          stateBefore: pe.handlerContext.stateBefore
        });
      }

    } else if (pe.type === 'reducer') {
      // 1. Finish reducers for the current action starting from the saved index.
      //    Emitted actions are prepended to pe.actionQueue for step 2.
      const liveQueue = [...pe.actionQueue];
      this._processReducers(
        pe.action, pe.reducerIdx, pe.reducers,
        liveQueue, pe.sourceEvent, pe.sourceEventType, pe.handlerContext
      );
      // 2. Process remaining actions (including anything emitted in step 1).
      this._processActionQueue(liveQueue, pe.sourceEvent, pe.handlerContext);
      // 3. Continue remaining handlers.
      if (pe.handlerContext) {
        this.execute(pe.handlerContext.event, {
          startHandlerIdx: pe.handlerContext.handlerIdx,
          stateBefore: pe.handlerContext.stateBefore
        });
      }
    }
  }

  /*  SNAPSHOT SUPPORT — delegated to SimulationHistory */
  takeSnapshot()            { return this.history.takeSnapshot(); }
  cloneQueue()              { return this.queue.data.map(e => ({ ...e, date: new Date(e.date) })); }
  restoreSnapshot(i)        { return this.history.restoreSnapshot(i); }
  rewind(steps)             { return this.history.rewind(steps); }
  rewindToStart()           { return this.history.rewindToStart(); }
  rewindToDate(date)        { return this.history.rewindToDate(date); }
  replayTo(date)            { return this.history.replayTo(date); }

  stepTo(targetDate) {
    const end = this.normalizeDate(targetDate);

    // ── Resume from a mid-event pause (handler / action / reducer) ─────────
    if (this.control.pendingExecution) {
      try {
        this._resumeFromPendingExecution();
      } catch (e) {
        if (e instanceof BreakpointSignal) return; // paused again, control.paused set by thrower
        throw e;
      }
      if (this.control.paused) return;
    }

    while (this.queue.size() > 0) {
      const next = this.queue.peek();
      if (next.date > end) break;

      // Take the initial snapshot before the first event fires so that
      // rewindToStart() + stepTo() replays ALL events (queue still contains this event).
      if (this.history.enableSnapshots && this.history.snapshots.length === 0) {
        this.history.takeSnapshot();
      }

      // ── Event-level breakpoint ────────────────────────────────────────
      if (
        this.control.breakpointsEnabled &&
        !this.control.resuming &&
        this.control.breakpointNodeIds.has(next.id ?? '')
      ) {
        this.control.paused = true;
        this.control.breakpointHit = { stage: 'event:start', event: next };
        return; // Leave event in the queue — resume will execute it
      }

      // Past the event-level check — clear resuming for the rest of this cycle.
      this.control.resuming = false;

      this.queue.pop();
      this.currentDate = next.date;

      try {
        this.execute(next);
      } catch (e) {
        if (e instanceof BreakpointSignal) return; // control.paused set by _shouldPause path
        throw e;
      }
    }

    this.currentDate = end;
  }

  findSnapshotIndex(target) { return this.history.findSnapshotIndex(target); }

  branch() {
    const clone = new Simulation(this.currentDate);

    const snap = this.history.snapshots[this.history.snapshotCursor];

    clone.currentDate = new Date(snap.date);
    clone.state = this.deepClone(snap.state);
    clone.rngState = snap.rngState;

    clone.queue.restoreData(snap.queue.map(e => ({
      ...e,
      date: new Date(e.date)
    })));

    return clone;
  }

  /**
   * Tagging for Action Graph
   * @param action
   * @param parent
   * @returns {*&{_id: number, _parent, _root}}
   */
  tagAction(action, parent = null) {
    return {
      ...action,
      _id: this.nextActionId++,
      _parent: parent?._id ?? null,
      _root: parent?._root ?? parent?._id ?? null
    };
  }

  /** Action Graph **/
  addActionNode({
                  action,
                  parentId,
                  reducerName,
                  prevState,
                  nextState,
                  sourceEvent
                }) {
    const actionClone = structuredClone(action)
    const stateSnapshot = structuredClone(nextState);
    const node = new ActionNode({
      id: action._id,
      type: action.type,
      date: new Date(this.currentDate),

      parent: parentId,
      children: [],

      action: actionClone,
      reducer: reducerName,

      stateBefore: prevState,
      stateAfter: stateSnapshot,
      sourceEvent: sourceEvent
    });
    this.actionGraph.addActionNode(node);
  }
}
