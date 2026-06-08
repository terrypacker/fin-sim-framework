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
import { JournalEntry, Journal } from './journal.js'
import { ReducerPipeline, FieldReducer, AccountTransactionReducer } from './reducers.js'
import { HandlerRegistry } from './handlers.js'
import { DateUtils } from "./date-utils.js";
import {
  ExecutionBusMessage, BreakpointHitMessage,
  EXECUTION_KINDS, EXECUTION_PHASES,
} from "./bus-messages.js";
import { generateActionId } from "./actions.js";
import { SimulationHistory } from "./simulation-history.js";
import { SimulationState } from "./simulation-state.js";
import { diffStates, MutationTracker } from "./state-utils.js";
import { buildExecutionId } from "./execution-utils.js";
import { ExecutionGraph } from "./execution-graph.js";
import { GraphRecorder } from "./graph-recorder.js";

const INTERNAL_SCHEDULING_HANDLER_NAME = 'INTERNAL_SCHEDULING_HANDLER_NAME';

// Fallback framework-field block-list used when no TypeRegistry is available
// (e.g. bare Simulation created without a ServiceRegistry in test fixtures).
const _FRAMEWORK_FIELDS = new Set(['id', 'type', 'name', 'kind', 'layer']);

function _heuristicPickPayload(action) {
  const out = {};
  for (const k of Object.keys(action)) {
    if (_FRAMEWORK_FIELDS.has(k)) continue;
    if (k.startsWith('_'))       continue;
    if (action[k] != null)       out[k] = action[k];
  }
  return out;
}

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
  constructor(startDate, { bus = new EventBus(), seed = 1, initialState = {}, opts = {}, graph = null } = {}) {
    this.currentDate = this.normalizeDate(startDate);

    this.queue = new IndexedMinHeap((a, b) => a.date - b.date,
            item => item.instanceId, item => item.type);
    this.bus = bus;

    this.handlers = new HandlerRegistry();   // eventType -> [HandlerEntry]
    this.reducers = new ReducerPipeline();   // actionType -> reducer

    this.state = structuredClone(
      initialState instanceof SimulationState ? initialState.toPlain() : initialState
    );

    this.rng = this.createRNG(seed);

    this.history = new SimulationHistory(this);
    this.history.enableSnapshots = opts.enableSnapshots ?? true;
    this.history.snapshotInterval = opts.snapshotInterval ?? 12; // every N events (~1/year)
    this.debug = opts.debug ?? false;
    this.silent = opts.silent ?? false; // when true: skip bus, clones, diffs (MC/batch mode)
    this.journal = new Journal({enabled: true});

    this.nextEventInstanceId = 0;

    if (graph && !this.silent) {
      this.executionGraph = new ExecutionGraph(graph);
      this.graphRecorder  = new GraphRecorder(this.executionGraph);
    } else {
      this.executionGraph = null;
      this.graphRecorder  = null;
    }

    this.eventExecutions = 0;
    this.handlerExecutions = 0;
    this.actionExecutions = 0;
    this.reducerExecutions = 0;

    // Hierarchical execution ID tracking — reset on rewind.
    // _executionCounts: configNodeId → number of times that node has executed this run.
    // _executionStack:  ancestry stack of full executionIds for the current call frame.
    this._executionCounts = new Map();
    this._executionStack  = [];

    // ── Breakpoint / pause control ─────────────────────────────────────────
    //
    // paused:             true when execution has stopped at a breakpoint
    // breakpointHit:      context object describing what triggered the pause
    // resuming:           skip the NEXT breakpoint check (so we step past the
    //                     node we're currently paused on)
    // breakpointsEnabled: disabled during rewind/replay to avoid false triggers
    // pendingExecution:   saved mid-event state so stepTo() can resume exactly
    //                     where it paused (handler/action/reducer level)
    // breakpointNodes:  Map of config-graph node IDs that have breakpoints;
    //                     managed by the UI layer (workbench-app)
    this.control = {
      paused: false,
      breakpointHit: null,
      resuming: false,
      breakpointsEnabled: true,
      pendingExecution: null,
      breakpointNodes: new Map(),
    };
  }

  _pickPayload(action) {
    const reg = this.bus.serviceRegistry?.typeRegistry;
    if (reg) return reg.pickPayload(action);
    return _heuristicPickPayload(action);
  }

  deepClone(obj) {
    return structuredClone(obj);
  }

  unschedule(type) {
    return this.queue.removeAllByType(type);
  }

  clearAllBreakpoints() {
    for (const node of this.control.breakpointNodes.values()) {
      if (node.data) node.data = { ...node.data, breakpoint: false };
    }
    this.control.breakpointNodes.clear();
  }

  toggleNodeBreakpoint(node) {
    if (this.control.breakpointNodes.has(node.id)) {
      this.control.breakpointNodes.delete(node.id);
      node.data = { ...node.data, breakpoint: false };
    } else {
      this.control.breakpointNodes.set(node.id, node);
      node.data = { ...node.data, breakpoint: true };
    }
  }

  schedule(event) {
    // Guarantee id and name are always present in the queued event so the
    // journal and execution graph always have stable references.
    const id   = event.id   ?? crypto.randomUUID();
    const name = event.name ?? event.type;

    if (this.graphRecorder) {
      this.graphRecorder.recordPendingSchedule({
        targetDefinitionId: id,
        scheduledFor: event.date,
      });
    }
    this.queue.push({
      data: {},
      meta: {},
      ...event,
      id,
      name,
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
    return this.control.breakpointNodes.has(id);
  }

  // ── Hierarchical execution ID helpers ──────────────────────────────────────

  /**
   * Increment the execution counter for `nodeId`, build the next hierarchical
   * execution ID using the current stack top as parent, push it onto the stack,
   * and return it.  Call _popExecutionId() when the node finishes.
   */
  _nextExecutionId(nodeId) {
    const index = (this._executionCounts.get(nodeId) ?? 0) + 1;
    this._executionCounts.set(nodeId, index);
    const parentId   = this._executionStack.at(-1) ?? null;
    const executionId = buildExecutionId(parentId, nodeId, index);
    this._executionStack.push(executionId);
    return executionId;
  }

  /** Pop and return the top execution ID when the current node finishes. */
  _popExecutionId() {
    return this._executionStack.pop() ?? null;
  }

  /** Peek at the current execution ID without removing it. */
  _currentExecutionId() {
    return this._executionStack.at(-1) ?? null;
  }

  /**
   * Increment the per-node execution counter and return a new hierarchical ID.
   * Does NOT touch _executionStack — safe to call from breakpoint-resume paths.
   *
   * @param {string|null} nodeId    Config-graph node ID (e.g. 'e1', 'h2').
   * @param {string|null} parentId  Full execution path of the parent, or null.
   * @returns {string|null}  null when nodeId is falsy (anonymous nodes skipped).
   */
  _makeExecutionId(nodeId, parentId) {
    if (!nodeId) return null;
    const index = (this._executionCounts.get(nodeId) ?? 0) + 1;
    this._executionCounts.set(nodeId, index);
    return buildExecutionId(parentId, nodeId, index);
  }

  // ── Core execution ─────────────────────────────────────────────────────────

  /**
   * Execute one event.  Supports mid-event resume by accepting a startHandlerIdx
   * (skip handlers that already ran) and the original stateBefore snapshot.
   *
   * Throws BreakpointSignal when it hits a handler breakpoint; saves resume
   * context in this.control.pendingExecution before throwing.
   *
   * @param {object}  event
   * @param {object}  [opts]
   * @param {number}  [opts.startHandlerIdx=0]   Resume from this handler index.
   * @param {object}  [opts.stateBefore=null]    Pre-event state snapshot (from prior partial run).
   * @param {string}  [opts.eventExecId=null]    Saved execution ID for resume paths.
   */
  execute(event, { startHandlerIdx = 0, stateBefore: savedStateBefore = null, eventExecId: savedEventExecId = null, eventNodeId: savedEventNodeId = null } = {}) {
    const handlers = this.handlers.get(event.type) || [];

    // Capture state-before once (at true event start, not on resume).
    const stateBefore = this.silent ? null : (savedStateBefore ?? structuredClone(this.state));

    let eventExecId;
    let eventNodeId;
    if (startHandlerIdx === 0) {
      this.eventExecutions++;
      eventExecId = this._makeExecutionId(event.id ?? event.type, null);
      if (!this.silent) {
        const now = new Date(this.currentDate);
        this.bus.publish(new ExecutionBusMessage({
          phase:       EXECUTION_PHASES.BEGIN,
          kind:        EXECUTION_KINDS.EVENT,
          executionId: eventExecId,
          parentId:    null,
          nodeId:      event.id ?? null,
          date:        now,
          sim:         this,
          data:        { event, eventCount: this.eventExecutions }
        }));
        if (this.graphRecorder) {
          eventNodeId = this.graphRecorder.beginNode({
            kind:         'event',
            name:         event.type,
            definitionId: event.id ?? null,
            parentNodeId: null,
            date:         now,
          });
          this.graphRecorder.resolvePendingSchedules(event.id ?? event.type, eventNodeId);
        }
      }
    } else {
      eventExecId  = savedEventExecId;
      eventNodeId  = savedEventNodeId;
    }

    for (let i = startHandlerIdx; i < handlers.length; i++) {
      const entry = handlers[i];

      // ── Handler breakpoint ──────────────────────────────────────────────
      if (this._shouldPause(entry.id)) {
        this.control.pendingExecution = {
          type: 'handler',
          event,
          handlerIdx: i,
          stateBefore,
          eventExecId,
          eventNodeId,
        };
        this.control.breakpointHit = { stage: 'handler:before', node: entry };
        this.control.paused = true;
        throw new BreakpointSignal({ stage: 'handler:before', node: entry });
      }
      // Past this handler's breakpoint check — clear resuming flag so subsequent
      // handlers (and their nested action/reducer loops) get checked normally.
      this.control.resuming = false;

      const isInternal = entry.name === INTERNAL_SCHEDULING_HANDLER_NAME;
      const handlerExecId = isInternal
        ? null
        : this._makeExecutionId(entry.id ?? entry.name, eventExecId);

      let handlerNodeId = null;
      if (!isInternal) {
        this.handlerExecutions++;
        if (!this.silent) {
          const hDate = new Date(this.currentDate);
          this.bus.publish(new ExecutionBusMessage({
            phase:       EXECUTION_PHASES.BEGIN,
            kind:        EXECUTION_KINDS.HANDLER,
            executionId: handlerExecId,
            parentId:    eventExecId,
            nodeId:      entry.id ?? null,
            date:        hDate,
            sim:         this,
            data:        { handler: entry, event }
          }));
          if (this.graphRecorder) {
            handlerNodeId = this.graphRecorder.beginNode({
              kind:         'handler',
              name:         entry.name ?? entry.id ?? 'handler',
              definitionId: entry.id ?? null,
              parentNodeId: eventNodeId,
              date:         hDate,
            });
          }
        }
      }

      const actions = entry.call({
        sim: this,
        date: this.currentDate,
        data: event.data,
        meta: event.meta,
        state: this.state
      });

      if (!isInternal && !this.silent) {
        this.bus.publish(new ExecutionBusMessage({
          phase:       EXECUTION_PHASES.END,
          kind:        EXECUTION_KINDS.HANDLER,
          executionId: handlerExecId,
          parentId:    eventExecId,
          nodeId:      entry.id ?? null,
          date:        new Date(this.currentDate),
          sim:         this,
          data:        { handler: entry, event, handlerCount: this.handlerExecutions }
        }));
        if (this.graphRecorder && handlerNodeId) {
          this.graphRecorder.endNode(handlerNodeId);
        }
      }

      // Pass handlerContext so that if applyActions pauses mid-queue we know
      // which handler to resume from (the NEXT one: i + 1).
      this.applyActions(actions, event, {
        handlerContext: { event, handlerIdx: i + 1, stateBefore, eventExecId, eventNodeId },
        handlerExecId:  handlerExecId ?? eventExecId, // anonymous handlers use event as parent
        eventNodeId,
        handlerNodeId,
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

    // Publish EXECUTION_END(EVENT) with full state snapshot + diff.
    if (!this.silent) {
      const stateSnapshot = structuredClone(this.state);
      const now = new Date(this.currentDate);
      this.bus.publish(new ExecutionBusMessage({
        phase:         EXECUTION_PHASES.END,
        kind:          EXECUTION_KINDS.EVENT,
        executionId:   eventExecId,
        parentId:      null,
        nodeId:        event.id ?? null,
        date:          now,
        sim:           this,
        data:          { event, stateBefore, stateAfter: stateSnapshot, sourceEvent: event },
        stateSnapshot,
        stateDiff:     stateBefore ? diffStates(stateBefore, stateSnapshot) : null
      }));
      if (this.graphRecorder && eventNodeId) {
        this.graphRecorder.endNode(eventNodeId);
      }

      if (this.journal.enabled) {
        this.journal.addSnapshot(new Date(this.currentDate), this.state);
      }
    }

    if(this.debug) {
      const execNodes = this.executionGraph?.getExecutionNodes().length ?? 0;
      console.log(`
         Date: ${this.currentDate}
         Queue: ${this.queue.size()}
         Journal: ${this.journal.journal.length}
         ExecutionNodes: ${execNodes}
         History Snapshots: ${this.history.enableSnapshots}
         History Size: ${this.history.snapshots.length}
         Bus History: ${this.bus.history.length}
         Handler Registry: (${this.handlers.map.size}): ${this.handlers.getStats(5).map(e => `${e.type}: ${e.count}`).join(' ')}
         Reducer Pipeline: (${this.reducers.map.size}): ${this.reducers.getStats(5).map(e => `${e.type}: ${e.count}`).join(' ')}
      `)
    }

    this.control.pendingExecution = null; // Completed cleanly
  }

  /**
   * Apply a list of actions produced by a handler.
   *
   * @param {Array|object|null} actions        Actions to apply (may be null).
   * @param {object}            sourceEvent    The originating simulation event.
   * @param {object}            [opts]
   * @param {Array}             [opts.existingQueue]   Pre-built action queue for resume.
   * @param {object}            [opts.handlerContext]  { event, handlerIdx, stateBefore, eventExecId }.
   * @param {string|null}       [opts.handlerExecId]   Execution ID of the producing handler.
   */
  applyActions(actions, sourceEvent, { existingQueue = null, handlerContext = null, handlerExecId = null, eventNodeId = null, handlerNodeId = null } = {}) {
    if (!actions && !existingQueue) return;

    let queue;
    if (existingQueue) {
      queue = existingQueue;
    } else {
      const rawActions = Array.isArray(actions) ? [...actions] : [actions];
      // Handler-generated actions are siblings — they all share parent=null.
      // (Using the previous action as parent was wrong: it implied A emitted B.)
      queue = rawActions.map((a, i) => {
        const decorated = this.decorateAction(a, null);
        decorated.siblingIndex = i;
        return decorated;
      });
    }

    this._processActionQueue(queue, sourceEvent, handlerContext, handlerExecId, eventNodeId, handlerNodeId);
  }

  /**
   * Inner loop: process all actions in `queue`, running their reducers.
   * May throw BreakpointSignal — saves pendingExecution before doing so.
   *
   * @param {Array}       queue          Mutable action queue (shifted from front).
   * @param {object}      sourceEvent
   * @param {object}      handlerContext { event, handlerIdx, stateBefore, eventExecId } for resume.
   * @param {string|null} handlerExecId  Execution ID of the producing handler.
   */
  _processActionQueue(queue, sourceEvent, handlerContext, handlerExecId, eventNodeId = null, handlerNodeId = null) {
    const sourceEventType = sourceEvent.type;
    const MAX_ACTIONS = 10000;
    let processed = 0;

    while (queue.length > 0) {
      if (processed++ > MAX_ACTIONS) {
        throw new Error("Infinite action loop detected");
      }

      const action = queue.shift();

      // ── Action breakpoint ─────────────────────────────────────────────
      if (this._shouldPause(action._actionId)) {
        this.control.pendingExecution = {
          type: 'action',
          actionQueue: [action, ...queue],  // put action back so it runs on resume
          sourceEvent,
          handlerContext,
          handlerExecId,
          eventNodeId,
          handlerNodeId,
        };
        this.control.breakpointHit = { stage: 'action', node: action };
        this.control.paused = true;
        throw new BreakpointSignal({ stage: 'action', node: action });
      }
      this.control.resuming = false;

      const reducers = this.reducers.get(action.type);

      const unwrappedReducers = [];
      if (reducers && reducers.length > 0) {
        reducers.forEach(r => unwrappedReducers.push(r.reducer));
      }

      if (action.transform) {
        const newActions = action.transform(this.state, {
          date: this.currentDate,
          sourceEvent,
          handlerContext
        });
        if (newActions?.length) {
          queue.unshift(...newActions.map((a, i) => {
            const decorated = this.decorateAction(a, action);
            decorated.siblingIndex = i;
            return decorated;
          }));
        }
      }

      this.actionExecutions++;
      const actionExecId = this._makeExecutionId(action._actionId ?? action.type, handlerExecId);

      let actionNodeId = null;
      if (!this.silent) {
        const now = new Date(this.currentDate);
        this.bus.publish(new ExecutionBusMessage({
          phase:       EXECUTION_PHASES.BEGIN,
          kind:        EXECUTION_KINDS.ACTION,
          executionId: actionExecId,
          parentId:    handlerExecId ?? null,
          nodeId:      action._actionId ?? null,
          date:        now,
          sim:         this,
          data:        { action, reducers: unwrappedReducers, sourceEvent, actionCount: this.actionExecutions }
        }));
        if (this.graphRecorder) {
          actionNodeId = this.graphRecorder.beginNode({
            uuid:         action._instanceId,
            kind:         'action',
            name:         action.type,
            definitionId: action._actionId ?? null,
            parentNodeId: handlerNodeId ?? eventNodeId,
            date:         now,
          });
          if (action._emittedByNodeId) {
            this.graphRecorder.addEmitsEdge(action._emittedByNodeId, actionNodeId);
          }
        }
      }

      if (!reducers || reducers.length === 0) {
        if (!this.silent) {
          this.bus.publish(new ExecutionBusMessage({
            phase:       EXECUTION_PHASES.END,
            kind:        EXECUTION_KINDS.ACTION,
            executionId: actionExecId,
            parentId:    handlerExecId ?? null,
            nodeId:      action._actionId ?? null,
            date:        new Date(this.currentDate),
            sim:         this,
            data:        { action, sourceEvent }
          }));
          if (this.graphRecorder && actionNodeId) {
            this.graphRecorder.endNode(actionNodeId);
          }
        }
        continue;
      }

      // Run all reducers for this action.  Emitted actions are unshifted onto
      // `queue` so they execute before the remaining queued actions.
      this._processReducers(action, 0, reducers, queue, sourceEvent, sourceEventType, handlerContext, actionExecId, handlerExecId, actionNodeId);

      if (!this.silent) {
        this.bus.publish(new ExecutionBusMessage({
          phase:       EXECUTION_PHASES.END,
          kind:        EXECUTION_KINDS.ACTION,
          executionId: actionExecId,
          parentId:    handlerExecId ?? null,
          nodeId:      action.actionId ?? null,
          date:        new Date(this.currentDate),
          sim:         this,
          data:        { action, sourceEvent }
        }));
        if (this.graphRecorder && actionNodeId) {
          this.graphRecorder.endNode(actionNodeId);
        }
      }
    }
  }

  /**
   * Run reducers for `action` starting at `startIdx`.
   * Emits new actions by unshifting them onto the shared `actionQueue`.
   * May throw BreakpointSignal — saves pendingExecution before doing so.
   *
   * @param {object}      action
   * @param {number}      startIdx        First reducer index to run.
   * @param {Array}       reducers        All reducers registered for this action type.
   * @param {Array}       actionQueue     Shared queue (mutated — emitted actions prepended).
   * @param {object}      sourceEvent
   * @param {string}      sourceEventType
   * @param {object}      handlerContext
   * @param {string|null} actionExecId    Execution ID of the owning action.
   * @param {string|null} handlerExecId   Execution ID of the owning handler (for resume).
   */
  _processReducers(action, startIdx, reducers, actionQueue, sourceEvent, sourceEventType, handlerContext, actionExecId, handlerExecId, actionNodeId = null) {
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
          handlerContext,
          actionExecId,
          handlerExecId,
          actionNodeId,
        };
        this.control.breakpointHit = { stage: 'reducer:before', node: reducerWrapper.reducer };
        this.control.paused = true;
        throw new BreakpointSignal({ stage: 'reducer:before', node: reducerWrapper.reducer });
      }
      this.control.resuming = false;

      // Use MutationTracker for FieldReducer/AccountTransactionReducer (avoids structuredClone).
      // Fall back to clone for other reducer types (account-rules, plain fns) that mutate directly.
      const r = reducerWrapper.reducer;
      const useTracker = !this.silent && (
        r instanceof FieldReducer || r instanceof AccountTransactionReducer
      );
      if (useTracker) MutationTracker.begin();
      const prevState = (!this.silent && !useTracker) ? structuredClone(this.state) : null;
      const reducerExecId = this._makeExecutionId(reducerWrapper.reducer?.id ?? null, actionExecId);

      let reducerNodeId = null;
      const rDate = new Date(this.currentDate);
      if (!this.silent && reducerExecId) {
        this.bus.publish(new ExecutionBusMessage({
          phase:       EXECUTION_PHASES.BEGIN,
          kind:        EXECUTION_KINDS.REDUCER,
          executionId: reducerExecId,
          parentId:    actionExecId ?? null,
          nodeId:      reducerWrapper.reducer?.id ?? null,
          date:        rDate,
          sim:         this,
          data:        { reducer: reducerWrapper.reducer, action, sourceEvent }
        }));
      }
      if (!this.silent && this.graphRecorder) {
        reducerNodeId = this.graphRecorder.beginNode({
          kind:         'reducer',
          name:         reducerWrapper.reducer?.id ?? reducerWrapper.name ?? 'reducer',
          definitionId: reducerWrapper.reducer?.id ?? null,
          parentNodeId: actionNodeId,
          date:         rDate,
        });
      }

      const result = reducerWrapper.fn(this.state, action, this.currentDate);
      this.reducerExecutions++;

      if (!result) {
        if (useTracker) MutationTracker.flush(); // discard — no state change
        if (!this.silent && reducerExecId) {
          this.bus.publish(new ExecutionBusMessage({
            phase:       EXECUTION_PHASES.END,
            kind:        EXECUTION_KINDS.REDUCER,
            executionId: reducerExecId,
            parentId:    actionExecId ?? null,
            nodeId:      reducerWrapper.reducer?.id ?? null,
            date:        new Date(this.currentDate),
            sim:         this,
            data:        { reducer: reducerWrapper.reducer, action, sourceEvent, reducerCount: this.reducerExecutions },
            stateDiff:   null
          }));
        }
        if (!this.silent && this.graphRecorder && reducerNodeId) {
          this.graphRecorder.endNode(reducerNodeId);
        }
        continue;
      }

      let nextState;
      let emitted = [];

      if (result.state) {
        nextState = result.state;
      } else {
        nextState = result;
      }

      if (result.next) {
        const nextArr = Array.isArray(result.next) ? result.next : [result.next];
        emitted = nextArr.map((a, i) => {
          const decorated = this.decorateAction(a, action);
          decorated.siblingIndex = i;
          return decorated;
        });
        // Tag each emitted action so _processActionQueue can add the EMITS edge
        // once the action node exists in the graph.
        if (reducerNodeId) {
          for (const a of emitted) { a._emittedByNodeId = reducerNodeId; }
        }
        actionQueue.unshift(...emitted);
      }

      // Strip the `next` key so it never pollutes this.state.
      if ('next' in nextState) {
        const { next: _discarded, ...cleanState } = nextState;
        nextState = cleanState;
      }

      this.state = nextState;

      let sd = null;
      if (!this.silent) {
        sd = useTracker ? MutationTracker.flush() : diffStates(prevState, this.state);
        if (reducerExecId) {
          this.bus.publish(new ExecutionBusMessage({
            phase:       EXECUTION_PHASES.END,
            kind:        EXECUTION_KINDS.REDUCER,
            executionId: reducerExecId,
            parentId:    actionExecId ?? null,
            nodeId:      reducerWrapper.reducer?.id ?? null,
            date:        new Date(this.currentDate),
            sim:         this,
            data:        { reducer: reducerWrapper.reducer, action, sourceEvent, reducerCount: this.reducerExecutions },
            stateDiff:   sd
          }));
        }
        if (this.graphRecorder && reducerNodeId) {
          this.graphRecorder.endNode(reducerNodeId, { stateDiff: sd });
        }
      }

      // Journal is recorded regardless of silent so that batch/MC-isolated runs
      // (e.g. ScenarioCompareRunner) can still read journal entries. stateDiff is
      // null in silent mode (state cloning is skipped for performance).
      if (this.journal.enabled) {
        this.journal.addEntry(new JournalEntry({
          id:          crypto.randomUUID(),
          date:        new Date(this.currentDate),
          executionId: reducerExecId ?? null,
          event: {
            nodeId: sourceEvent?.id    ?? null,
            type:   sourceEventType,
            name:   sourceEvent?.name  ?? sourceEventType,
            color:  sourceEvent?.color ?? null,
          },
          action: {
            instanceId:   action._instanceId,
            parentId:     action._parentInstanceId ?? null,
            rootId:       action._rootInstanceId   ?? null,
            siblingIndex: action.siblingIndex      ?? 0,
            nodeId:       action._actionId         ?? null,
            type:         action.type,
            name:         action.name              ?? action.type,
            data:         this._pickPayload(action),
          },
          reducer: {
            nodeId: reducerWrapper.reducer?.id   ?? null,
            name:   reducerWrapper.reducer?.name ?? reducerWrapper.reducer?.id ?? 'unknown',
          },
          stateDiff:          sd,
          emittedInstanceIds: emitted.map(a => a._instanceId),
          emittedTypes:       emitted.map(a => a.type),
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
        stateBefore:     pe.stateBefore,
        eventExecId:     pe.eventExecId,
        eventNodeId:     pe.eventNodeId,
      });

    } else if (pe.type === 'action') {
      // Process the action queue (first entry is the one with the breakpoint).
      // After the queue drains, continue the handler loop.
      this._processActionQueue(pe.actionQueue, pe.sourceEvent, pe.handlerContext, pe.handlerExecId, pe.eventNodeId, pe.handlerNodeId);
      if (pe.handlerContext) {
        this.execute(pe.handlerContext.event, {
          startHandlerIdx: pe.handlerContext.handlerIdx,
          stateBefore:     pe.handlerContext.stateBefore,
          eventExecId:     pe.handlerContext.eventExecId,
          eventNodeId:     pe.handlerContext.eventNodeId,
        });
      }

    } else if (pe.type === 'reducer') {
      // 1. Finish reducers for the current action starting from the saved index.
      //    Emitted actions are prepended to pe.actionQueue for step 2.
      const liveQueue = [...pe.actionQueue];
      this._processReducers(
        pe.action, pe.reducerIdx, pe.reducers,
        liveQueue, pe.sourceEvent, pe.sourceEventType, pe.handlerContext,
        pe.actionExecId, pe.handlerExecId, pe.actionNodeId
      );
      // Publish EXECUTION_END(ACTION) now that all its reducers have completed.
      if (!this.silent) {
        this.bus.publish(new ExecutionBusMessage({
          phase:       EXECUTION_PHASES.END,
          kind:        EXECUTION_KINDS.ACTION,
          executionId: pe.actionExecId,
          parentId:    pe.handlerExecId ?? null,
          nodeId:      pe.action._actionId ?? null,
          date:        new Date(this.currentDate),
          sim:         this,
          data:        { action: pe.action, sourceEvent: pe.sourceEvent }
        }));
        if (this.graphRecorder && pe.actionNodeId) {
          this.graphRecorder.endNode(pe.actionNodeId);
        }
      }
      // 2. Process remaining actions (including anything emitted in step 1).
      this._processActionQueue(liveQueue, pe.sourceEvent, pe.handlerContext, pe.handlerExecId, pe.eventNodeId, pe.handlerNodeId);
      // 3. Continue remaining handlers.
      if (pe.handlerContext) {
        this.execute(pe.handlerContext.event, {
          startHandlerIdx: pe.handlerContext.handlerIdx,
          stateBefore:     pe.handlerContext.stateBefore,
          eventExecId:     pe.handlerContext.eventExecId,
          eventNodeId:     pe.handlerContext.eventNodeId,
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
        this.control.breakpointNodes.has(next.id ?? '')
      ) {
        this.control.paused = true;
        this.control.breakpointHit = { stage: 'event:start', node: next };
        this.bus.publish(new BreakpointHitMessage({
          date:   new Date(this.currentDate),
          nodeId: next.id,
          kind:   next.kind ?? 'event',
          stage:  'event:start'
        }));
        return; // Leave event in the queue — resume will execute it
      }

      // Past the event-level check — clear resuming for the rest of this cycle.
      this.control.resuming = false;

      this.queue.pop();
      this.currentDate = next.date;

      try {
        this.execute(next);
      } catch (e) {
        if (e instanceof BreakpointSignal) {
          const node = e.context.node;
          // ActionDefinition workaround: actions use _actionId, others use id. See #134
          const nodeId = node.kind === 'action' ? node._actionId : node.id;
          this.bus.publish(new BreakpointHitMessage({
            date:   new Date(this.currentDate),
            nodeId: nodeId,
            kind:   node.kind ?? 'unknown',
            stage:  e.context.stage
          }));
          return; // control.paused set by _shouldPause path
        }
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
   * Prepare an Action instance for the queue: assign a UUID instanceId if not
   * already set (e.g. legacy manually-constructed actions), then record
   * parentage and broadcast the instance on the simulation bus.
   *
   * @param {Action} action
   * @param {Action|null} parent
   * @returns {Action}
   */
  decorateAction(action, parent = null) {
    const clone = Object.create(Object.getPrototypeOf(action));
    Object.assign(clone, action);

    if (!clone._instanceId) {
      clone._instanceId = generateActionId();
    }
    clone._parentInstanceId = parent?._instanceId ?? null;
    clone._rootInstanceId   = parent?._rootInstanceId ?? parent?._instanceId ?? null;

    return clone;
  }

  /**
   * Extract the field information for the graph, must become a structuredClonable object
   * @param action
   * @param parent
   * @returns {*&{_id: number, _parent, _root}}
   */
  cloneObjectFields(action) {
    return {...action };
  }

}

