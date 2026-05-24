/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { DateUtils } from '../simulation-framework/date-utils.js';
import { intervalFns, startSnapFns } from '../scenarios/base-scenario.js';

/**
 * Bridges the service layer (configuration) and the Simulation (execution).
 *
 * SimulationSync subscribes to SERVICE_ACTION events on the shared bus and
 * keeps the active Simulation in sync with the service maps:
 *
 *   CREATE  — schedules / registers / wires the new item into the sim.
 *   UPDATE  — unregisters the old wiring, re-wires with the new values.
 *   DELETE  — removes the item from the sim, cleans up cross-references.
 *
 * One instance lives in ServiceRegistry and is replaced on every
 * ServiceRegistry.reset().  Callers do not need to manage its lifecycle.
 *
 * simStart must be set by calling setSimStart(date) once the Simulation is
 * created (i.e., from BaseScenario.buildSim()).
 */
export class SimulationSync {
  /**
   * @param {{ bus, handlerService, reducerService }} registry
   *   The ServiceRegistry that owns this instance.  Passed so we can reach
   *   the bus and sibling services without importing ServiceRegistry (avoids
   *   a circular dependency).
   */
  constructor(registry) {
    this._registry = registry;

    /** Date from which recurring event series are scheduled. Set by buildSim. */
    this.simStart = null;

    /**
     * Tracks which event types already have the auto-rescheduling handler
     * registered in the sim so we never register a second one on re-enable.
     * @type {Map<string, object>}
     */
    this._registeredRecurringTypes = new Map();

    registry.bus.subscribe('SERVICE_ACTION', (msg) => {
      this._handleServiceAction(msg);
    });
  }

  // ─── Configuration ────────────────────────────────────────────────────────

  /**
   * Must be called after the Simulation is created so recurring events can be
   * scheduled relative to the right start date.
   * @param {Date} simStart
   */
  setSimStart(simStart) {
    this.simStart = simStart;
  }

  // ─── Sim accessor ─────────────────────────────────────────────────────────

  /** @returns {import('../simulation-framework/simulation.js').Simulation|null} */
  get sim() {
    return this._registry.simulationRegistry.getPrimary();
  }

  // ─── Bus dispatch ─────────────────────────────────────────────────────────

  /** @private */
  _handleServiceAction(msg) {
    if (!this.sim) return; // sim not yet built

    const { actionType, classType, item } = msg;

    if (actionType === 'CREATE') {
      if (classType === 'EventSeries' || classType === 'OneOffEvent') {
        if (item.enabled) {
          item.date ? this._scheduleOneOffEvent(item) : this._scheduleEventSeries(item);
        }
      } else if (item.kind === 'handler') {
        item.handledEvents.forEach(e => this.sim.register(e.type, item, item.name));
      } else if (item.kind === 'reducer') {
        this._wireReducer(item);
      }
      // Actions: no sim wiring needed on CREATE

    } else if (actionType === 'UPDATE') {
      if (classType === 'EventSeries' || classType === 'OneOffEvent') {
        this._applyEventChange(item);
      } else if (item.kind === 'handler') {
        this._applyHandlerChange(item);
      } else if (item.kind === 'action') {
        this._applyActionChange(item);
      } else if (item.kind === 'reducer') {
        this._applyReducerChange(item);
      }

    } else if (actionType === 'DELETE') {
      if (classType === 'EventSeries' || classType === 'OneOffEvent') {
        this._applyEventDelete(item);
      } else if (item.kind === 'handler') {
        this._applyHandlerDelete(item);
      } else if (item.kind === 'action') {
        this._applyActionDelete(item);
      } else if (item.kind === 'reducer') {
        this._applyReducerDelete(item);
      }
    }
  }

  // ─── Scheduling helpers ───────────────────────────────────────────────────

  /** @private */
  _scheduleEventSeries(series) {
    if (!series.enabled) return;

    const intervalFn = intervalFns[series.interval];

    if (!this._registeredRecurringTypes.has(series.type)) {
      this.sim.register(series.type, ({ sim, date }) => {
        sim.schedule({ ...series, date: intervalFn(date) });
      });
      this._registeredRecurringTypes.set(series.type, series);
    }

    let start = series.startOffset
        ? DateUtils.addYears(this.simStart, series.startOffset)
        : this.simStart;
    const snapFn = startSnapFns[series.interval];
    if (snapFn) start = snapFn(start);

    while (start <= this.sim.currentDate) {
      start = intervalFn(start);
    }

    this.sim.schedule({ ...series, date: start });
  }

  /** @private */
  _scheduleOneOffEvent(event) {
    if (event.enabled) {
      this.sim.schedule({ ...event, date: new Date(event.date) });
    }
  }

  /** @private */
  _unscheduleEvent(event) {
    this.sim.unschedule(event.type);
  }

  // ─── Apply methods (UPDATE / DELETE) ─────────────────────────────────────

  /** @private */
  _applyEventChange(event) {
    this._unscheduleEvent(event);
    if (event.enabled) {
      event.date ? this._scheduleOneOffEvent(event) : this._scheduleEventSeries(event);
    }
  }

  /** @private */
  _applyHandlerChange(handler) {
    this.sim.handlers.unregisterFromAll(handler);
    handler.handledEvents.forEach(e => this.sim.register(e.type, handler));
  }

  /** @private */
  _applyActionChange(action) {
    // If action.type changed, reducers registered under the old type key will
    // no longer fire.  Re-register all reducers that reference this action.
    const affected = new Set();
    for (const entries of this.sim.reducers.map.values()) {
      for (const entry of entries) {
        if (entry.reducer?.reducedActions.includes(action)) {
          affected.add(entry.reducer);
        }
      }
    }
    for (const reducer of affected) {
      this.reregisterReducer(reducer);
    }
  }

  /** @private */
  _applyReducerChange(reducer) {
    this.reregisterReducer(reducer);
  }

  /** @private */
  _applyEventDelete(event) {
    if (event.enabled) {
      this._unscheduleEvent(event);
    }
    this._registeredRecurringTypes.delete(event.type);
  }

  /** @private */
  _applyHandlerDelete(handler) {
    this.sim.handlers.unregisterFromAll(handler);
  }

  /** @private */
  _applyActionDelete(action) {
    const { handlerService, reducerService } = this._registry;

    // Remove from any handler's generatedActions
    for (const handler of handlerService.getAll()) {
      if (handler.generatedActions) {
        const i = handler.generatedActions.findIndex(a => a.id === action.id);
        if (i >= 0) handler.generatedActions.splice(i, 1);
      }
    }

    // Remove from any reducer's reducedActions / generatedActions and re-wire
    for (const reducer of reducerService.getAll()) {
      let changed = false;
      for (const arr of ['reducedActions', 'generatedActions']) {
        if (reducer[arr]) {
          const i = reducer[arr].findIndex(a => a.id === action.id);
          if (i >= 0) { reducer[arr].splice(i, 1); changed = true; }
        }
      }
      if (changed) this.reregisterReducer(reducer);
    }
  }

  /** @private */
  _applyReducerDelete(reducer) {
    this.sim.reducers.unregisterAllForReducer(reducer);
  }

  // ─── Public helpers ───────────────────────────────────────────────────────

  /**
   * Wire a reducer into the simulation pipeline.
   *
   * Supports two registration styles:
   *   1. Service-graph style: reducer.reducedActions[] holds Action references;
   *      each action's type is the pipeline key.
   *   2. Direct-wired style: reducer class declares a static actionType string;
   *      used for finance-domain reducers whose action type is fixed by design.
   *
   * @private
   */
  _wireReducer(reducer) {
    if (reducer.reducedActions.length > 0) {
      reducer.reducedActions.forEach(a => reducer.registerWith(this.sim.reducers, a.type));
    } else if (reducer.constructor.actionType) {
      reducer.registerWith(this.sim.reducers, reducer.constructor.actionType);
    }
  }

  /**
   * Remove all sim registrations for a reducer then re-wire it based on its
   * current reducedActions array (or static actionType).
   * Called after type changes or action deletes.
   */
  reregisterReducer(reducer) {
    this.sim.reducers.unregisterAllForReducer(reducer);
    this._wireReducer(reducer);
  }
}
