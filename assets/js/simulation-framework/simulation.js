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
import { ReducerPipeline } from './reducers.js'
import { DateUtils } from "./date-utils.js";

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

    this.handlers = new Map();   // eventType -> [handlers]
    this.reducers = new ReducerPipeline();   // actionType -> reducer

    this.state = structuredClone(initialState);

    this.rng = this.createRNG(seed);

    this.snapshots = [];
    this.snapshotCursor = -1;

    this.enableSnapshots = opts.enableSnapshots ?? true;
    this.snapshotInterval = opts.snapshotInterval ?? 1; // every N events

    this.journal = [];
    this.enableJournal = true;

    this.eventCounter = 0;
  }

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

  register(type, handler) {
    if (!this.handlers.has(type)) this.handlers.set(type, []);
    this.handlers.get(type).push(handler);
  }

  execute(event) {
    const handlers = this.handlers.get(event.type) || [];

    //Send out on the bus
    this.bus.publish({
      sim: this,
      date: this.currentDate,
      type: event.type,
      payload: event,
      stateSnapshot: this.state
    });

    for (const handler of handlers) {
      const actions = handler({
        sim: this,
        date: this.currentDate,
        data: event.data,
        meta: event.meta,
        state: this.state
      });

      this.applyActions(actions, event.type);

      // snapshot logic
      this.eventCounter++;

      if (
          this.enableSnapshots &&
          this.eventCounter % this.snapshotInterval === 0
      ) {
        this.takeSnapshot();
      }
    }
  }

  applyActions(actions, sourceEventType) {
    if (!actions) return;

    const queue = Array.isArray(actions) ? [...actions] : [actions].map(a => this.tagAction(a));

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
        const prevState = this.enableJournal
            ? structuredClone(this.state)
            : null;

        const result = fn(this.state, action);

        // Support multiple reducer return styles
        if (!result) continue;

        let nextState = this.state;
        let emitted = [];

        // Normalize result
        if (result.state) {
          nextState = result.state;
        } else {
          nextState = result;
        }

        if (result.next) {
          emitted = Array.isArray(result.next)
              ? result.next
              : [result.next];

          queue.push(...emitted);
        }

        // Apply state
        this.state = nextState;

        // Journal entry
        if (this.enableJournal) {
          this.journal.push({
            date: new Date(this.currentDate),
            eventType: sourceEventType,
            action: structuredClone(action),
            reducer: name,
            prevState,
            nextState: structuredClone(this.state),
            emittedActions: structuredClone(emitted)
          });
        }
      }

      // Publish to bus after full pipeline
      this.bus.publish({
        sim: this,
        date: this.currentDate,
        type: sourceEventType,
        payload: action,
        stateSnapshot: this.state
      });
    }
  }

  /*  SNAPSHOT SUPPORT */
  takeSnapshot() {
    const snapshot = {
      date: new Date(this.currentDate),
      state: this.deepClone(this.state),

      // capture RNG state (important!)
      rngState: this.rngState,

      // optional but powerful:
      queue: this.cloneQueue()
    };

    this.snapshots.push(snapshot);
    this.snapshotCursor = this.snapshots.length - 1;
  }

  cloneQueue() {
    return this.queue.data.map(e => ({
      ...e,
      date: new Date(e.date)
    }));
  }

  restoreSnapshot(index) {
    const snap = this.snapshots[index];
    if (!snap) return;

    this.currentDate = new Date(snap.date);
    this.state = this.deepClone(snap.state);
    this.rngState = snap.rngState;

    // restore queue
    this.queue.data = snap.queue.map(e => ({
      ...e,
      date: new Date(e.date)
    }));

    this.snapshotCursor = index;
  }

  rewind(steps = 1) {
    const target = Math.max(0, this.snapshotCursor - steps);
    this.restoreSnapshot(target);
  }

  rewindToStart() {
    this.restoreSnapshot(0);
  }

  rewindToDate(targetDate) {
    const target = this.normalizeDate(targetDate);

    const index = this.findSnapshotIndex(target);

    this.restoreSnapshot(index);
    this.stepTo(target);
  }

  replayTo(targetDate) {
    this.stepTo(targetDate);
  }

  stepTo(targetDate) {
    const end = this.normalizeDate(targetDate);

    while (this.queue.size() > 0) {
      const next = this.queue.peek();
      if (next.date > end) break;

      this.queue.pop();
      this.currentDate = next.date;

      this.execute(next);
    }

    this.currentDate = end;
  }

  findSnapshotIndex(target) {
    let lo = 0;
    let hi = this.snapshots.length - 1;
    let best = 0;

    while (lo <= hi) {
      const mid = Math.floor((lo + hi) / 2);
      const d = this.snapshots[mid].date;

      if (d <= target) {
        best = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }

    return best;
  }

  branch() {
    const clone = new Simulation(this.currentDate);

    const snap = this.snapshots[this.snapshotCursor];

    clone.currentDate = new Date(snap.date);
    clone.state = this.deepClone(snap.state);
    clone.rngState = snap.rngState;

    clone.queue.data = snap.queue.map(e => ({
      ...e,
      date: new Date(e.date)
    }));

    return clone;
  }

  /*  Journal API */
  tagAction(action, parent = null) {
    return {
      ...action,
      _id: this.nextActionId++,
      _parent: parent?._id ?? null,
      _root: parent?._root ?? parent?._id ?? null
    };
  }

  getActions(type) {
    return this.journal.filter(j => j.action.type === type);
  }
  getStateTimeline(field) {
    return this.journal.map(j => ({
      date: j.date,
      value: j.nextState[field]
    }));
  }

  /**
   * Trace a single event on a date
   * @param date
   * @returns {*[]}
   */
  traceEvent(date) {
    return this.journal.filter(j =>
        j.date.getTime() === date.getTime()
    );
  }

}
