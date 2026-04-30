/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { SimulationEventGraph } from './simulation-event-graph.js';

/**
 * Manages snapshot, replay, and branching state for a Simulation.
 *
 * Holds the snapshots array and all navigation logic, keeping it separate
 * from the event/action processing in Simulation. Requires a reference to
 * the owning sim in order to read and write currentDate, state, rngState,
 * queue, actionGraph, and nextActionId.
 */
export class SimulationHistory {
  constructor(sim) {
    this._sim = sim;
    this.snapshots = [];
    this.snapshotCursor = -1;
    this.enableSnapshots = true;
    this.snapshotInterval = 1;
    this.eventCounter = 0;
  }

  takeSnapshot() {
    const snap = {
      date: new Date(this._sim.currentDate),
      state: structuredClone(this._sim.state),
      rngState: this._sim.rngState,
      queue: this._sim.queue.data.map(e => ({ ...e, date: new Date(e.date) }))
    };
    this.snapshots.push(snap);
    this.snapshotCursor = this.snapshots.length - 1;
  }

  restoreSnapshot(index) {
    const snap = this.snapshots[index];
    if (!snap) return;
    this._sim.currentDate = new Date(snap.date);
    this._sim.state = structuredClone(snap.state);
    this._sim.rngState = snap.rngState;
    this._sim.queue.restoreData(snap.queue.map(e => ({ ...e, date: new Date(e.date) })));
    this.snapshotCursor = index;
  }

  rewindToStart() {
    if (!this.snapshots[0]) {
      // No valid initial snapshot yet (stepTo has not been called, or was called
      // to a date before the first event).  Reset counters so the next stepTo
      // creates a fresh snap0 before the first event fires.
      this.snapshots.length = 0;
      this.snapshotCursor = -1;
      this.eventCounter = 0;
      return;
    }
    this.restoreSnapshot(0);
    this.eventCounter = 0;
    this.snapshots.length = 1;   // prevent unbounded growth on repeated rewinds
    this.snapshotCursor = 0;
    this._resetExecutionCounters();
  }

  rewind(steps = 1) {
    const target = Math.max(0, this.snapshotCursor - steps);
    this.restoreSnapshot(target);
  }

  rewindToDate(targetDate) {
    const target = this._sim.normalizeDate(targetDate);
    const index = this.findSnapshotIndex(target);
    this.restoreSnapshot(index);
    this._sim.stepTo(target);
  }

  replayTo(targetDate) {
    this._sim.stepTo(targetDate);
  }

  findSnapshotIndex(target) {
    let lo = 0;
    let hi = this.snapshots.length - 1;
    let best = 0;
    while (lo <= hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (this.snapshots[mid].date <= target) {
        best = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return best;
  }

  /**
   * Reset the action graph, action ID counter, and execution counters before a replay.
   * Called by TimeControls.rewindTo() alongside journal and view resets.
   */
  resetForReplay() {
    this._sim.actionGraph = new SimulationEventGraph();
    this._sim.nextActionId = 0;
    this._resetExecutionCounters();
  }

  _resetExecutionCounters() {
    this._sim.eventExecutions = 0;
    this._sim.handlerExecutions = 0;
    this._sim.actionExecutions = 0;
    this._sim.reducerExecutions = 0;
  }
}
