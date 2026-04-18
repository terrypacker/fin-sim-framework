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

import { MinHeap } from './min-heap.js';
import { EventBus }  from './event-bus.js';
import { ActionNode, SimulationEventGraph } from './simulation-event-graph.js'
import { JournalEntry, Journal } from './journal.js'
import { ReducerPipeline } from './reducers.js'
import { HandlerRegistry } from './handlers.js'
import { DateUtils } from "./date-utils.js";
import { SimulationBusMessage, DebugActionBusMessage } from "./bus-messages.js";
import { SimulationHistory } from "./simulation-history.js";

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

    this.queue = new MinHeap((a, b) => a.date - b.date);
    this.bus = new EventBus();

    this.handlers = new HandlerRegistry();   // eventType -> [HandlerEntry]
    this.reducers = new ReducerPipeline();   // actionType -> reducer

    this.state = structuredClone(initialState);

    this.rng = this.createRNG(seed);

    this.history = new SimulationHistory(this);
    this.history.enableSnapshots = opts.enableSnapshots ?? true;
    this.history.snapshotInterval = opts.snapshotInterval ?? 1; // every N events

    this.journal = new Journal({enabled: true});

    this.nextActionId = 0;
    this.actionGraph = new SimulationEventGraph();
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

  schedule({ date, type, data = {}, meta = {} }) {
    this.queue.push({
      date: this.normalizeDate(date),
      type,
      data,
      meta
    });
  }

  scheduleRecurring({ startDate, type, intervalFn, data, meta }) {
    this.register(type, ({ sim, date, data, meta }) => {
      const nextDate = intervalFn(date);

      sim.schedule({
        date: nextDate,
        type,
        data,
        meta
      });
    });

    // Initial event
    this.schedule({ date: startDate, type, data, meta });
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
    return new Date(d.getFullYear(), d.getMonth(), d.getDate());
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
    this.handlers.register(type, handlerOrEntry);
  }

  execute(event) {
    const handlers = this.handlers.get(event.type) || [];

    //Send out on the bus
    this.bus.publish(new SimulationBusMessage({
      type: event.type,
      date: this.currentDate,
      sim: this,
      payload: event,
      stateSnapshot: this.state
    }));

    for (const entry of handlers) {
      const actions = entry.call({
        sim: this,
        date: this.currentDate,
        data: event.data,
        meta: event.meta,
        state: this.state
      });

      this.applyActions(actions, event);

      // snapshot logic
      this.history.eventCounter++;

      if (
          this.history.enableSnapshots &&
          this.history.eventCounter % this.history.snapshotInterval === 0
      ) {
        this.history.takeSnapshot();
      }
    }
  }

  applyActions(actions, sourceEvent) {
    if (!actions) return;

    const sourceEventType = sourceEvent.type;
    const rawActions = Array.isArray(actions) ? [...actions] : [actions];
    const queue = [];
    let prev = null;
    for (const a of rawActions) {
      const tagged = this.tagAction(a, prev);
      queue.push(tagged);
      prev = tagged;
    }

    const MAX_ACTIONS = 10000;
    let processed = 0;

    while (queue.length > 0) {
      if (processed++ > MAX_ACTIONS) {
        throw new Error("Infinite action loop detected");
      }

      const action = queue.shift();

      const reducers = this.reducers.get(action.type);

      if (!reducers || reducers.length === 0) continue;

      for (const { fn, name } of reducers) {
        const prevState = structuredClone(this.state);

        const result = fn(this.state, action);

        // Support multiple reducer return styles
        if (!result) continue;

        let nextState;
        let emitted = [];

        // Normalize result
        if (result.state) {
          nextState = result.state;
        } else {
          nextState = result;
        }

        if (result.next) {
          emitted = (Array.isArray(result.next)
              ? result.next
              : [result.next]).map(a => this.tagAction(a, action));

          queue.unshift(...emitted);
        }

        // Apply state
        this.state = nextState;

        const parentId = action._parent ?? null;
        // Add to graph
        this.addActionNode({
          action,
          parentId: parentId,
          reducerName: name,
          prevState,
          nextState,
          sourceEvent
        });

        // Journal entry
        if (this.journal.enabled) {
          this.journal.addEntry(new JournalEntry({
            date: new Date(this.currentDate),
            eventType: sourceEventType,
            action: structuredClone(action),
            reducer: name,
            prevState: prevState,
            nextState: structuredClone(this.state),
            emittedActions: structuredClone(emitted),
            sourceEvent: sourceEvent
          }));
        }
      }

      // Publish to bus after full pipeline
      this.bus.publish(new SimulationBusMessage({
        type: sourceEventType,
        date: this.currentDate,
        sim: this,
        payload: action,
        stateSnapshot: this.state
      }));
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

    while (this.queue.size() > 0) {
      const next = this.queue.peek();
      if (next.date > end) break;

      // Take the initial snapshot before the first event fires so that
      // rewindToStart() + stepTo() replays ALL events (queue still contains this event).
      if (this.history.enableSnapshots && this.history.snapshots.length === 0) {
        this.history.takeSnapshot();
      }

      this.queue.pop();
      this.currentDate = next.date;

      this.execute(next);
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

    clone.queue.data = snap.queue.map(e => ({
      ...e,
      date: new Date(e.date)
    }));

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
    const node = new ActionNode({
      id: action._id,
      type: action.type,
      date: new Date(this.currentDate),

      parent: parentId,
      children: [],

      action: structuredClone(action),
      reducer: reducerName,

      stateBefore: prevState,
      stateAfter: structuredClone(nextState),
      sourceEvent: sourceEvent
    });
    this.actionGraph.addActionNode(node);

    //Emit debug actions to track nodes
    this.bus.publish(new DebugActionBusMessage({
      date: new Date(this.currentDate),
      payload: node
    }));
  }
}
