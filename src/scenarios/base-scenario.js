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

export const intervalFns = {
  monthly:    d => DateUtils.addMonths(d, 1),
  quarterly:  d => DateUtils.addMonths(d, 3),
  annually:   d => DateUtils.addYears(d, 1),
  'month-end': d => DateUtils.endOfMonth(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1))),
  'year-end':  d => DateUtils.endOfYear(DateUtils.addYears(d, 1)),
};

// Snap the start date to the end of the period for period-end intervals
export const startSnapFns = {
  'month-end': d => DateUtils.endOfMonth(d),
  'year-end':  d => DateUtils.endOfYear(d),
};

/**
 * Base class for simulation scenarios.
 *
 * Subclasses must set `this.sim` and `this.simStart` before calling `_scheduleEvents()`.
 * They must also set `this.customEvents` (default []) if they want one-off event support.
 */
export class BaseScenario {
  constructor({
      eventSchedulerUI,
      simStart =  new Date(Date.UTC(2026, 0, 1)),
      simEnd = new Date(Date.UTC(2041, 0, 1))} = {}) {

    this.eventSchedulerUI = eventSchedulerUI;
    this.sim = null;
    this.simStart = simStart;
    this.simEnd = simEnd;

    //ID used for all things to be unique
    this._nextHandlerId = 1;
    this._nextReducerId = 1;
    this._nextEventId = 1;
    // Tracks which event types already have a recurring auto-rescheduling handler
    // registered, so we never register a second one on re-enable.
    this._registeredRecurringTypes = new Map();

    //Register the scenario
    this.eventSchedulerUI.registerEventChangeListener(e => this.eventChanged(e));
    this.eventSchedulerUI.registerHandlerChangeListener(h => this.handlerChanged(h));
    this.eventSchedulerUI.registerActionChangeListener(a => this.actionChanged(a));
    this.eventSchedulerUI.registerReducerChangeListener(r => this.reducerChanged(r));
  }

  buildSim(params, initialState) {
    this.sim = new FinSimLib.Core.Simulation(this.simStart, { initialState });
  }

  scheduleEvent(event) {
    if(!event.enabled) {
      throw new Error('Do not schedule a disabled event');
    }
    if(!event.id) {
      event.id = 'e' + this._nextEventId++;
    }
    //TODO Better way to test type
    if(event.date) {
      this._scheduleOneOffEvent(event);
    }else {
      this._scheduleEventSeries(event);
    }
    this.eventSchedulerUI.addEvent(event);
  }

  unscheduleEvent(event) {
    this.sim.unschedule(event.type);
  }

  getRegisteredRecurringEvents() {
    return [ ...this._registeredRecurringTypes.values()];
  }
  /**
   * Schedule a single event series.
   *
   * Safe to call multiple times for the same type (e.g. after unschedule +
   * re-enable): the auto-rescheduling handler is registered only once, and
   * the start date is advanced past the simulation's current date so no
   * already-processed dates are re-fired.
   * @param series
   * @private
   */
  _scheduleEventSeries(series) {
    if (!series.enabled) return;

    const intervalFn = intervalFns[series.interval];

    // Register the auto-rescheduling handler exactly once per event type.
    // scheduleRecurring() would register a new one on every call, causing
    // duplicate events after re-enable.
    if (!this._registeredRecurringTypes.has(series.type)) {
      this.sim.register(series.type, ({ sim, date, data, meta }) => {
        sim.schedule({ date: intervalFn(date), type: series.type, data, meta });
      });
      this._registeredRecurringTypes.put(series.type, series);
    }

    // Compute the nominal first occurrence from simStart
    let start = series.startOffset
        ? DateUtils.addYears(this.simStart, series.startOffset)
        : this.simStart;
    const snapFn = startSnapFns[series.interval];
    if (snapFn) start = snapFn(start);

    // After a rewind + re-enable, currentDate may be ahead of simStart.
    // Advance start until it is strictly after currentDate so we don't
    // re-fire dates that have already been processed.
    while (start <= this.sim.currentDate) {
      start = intervalFn(start);
    }

    this.sim.schedule({ date: start, type: series.type });
  }

  _scheduleOneOffEvent(event) {
    if (event.enabled) {
      this.sim.schedule({
        id: event.id,
        date: new Date(event.date),
        type: event.type
      });
    }
  }

  /**
   * Remove all pipeline entries for this reducer then re-register it.
   * Called after a UI-driven property change (priority, action type, etc.).
   */
  registerReducer(reducer) {
    // Assign a stable id only on first registration
    if (!reducer.id) {
      reducer.id = 'r' + this._nextReducerId++;
    }
    reducer.reducedActions.forEach(action => {
      reducer.registerWith(this.sim.reducers, action.type);
    });
    this.eventSchedulerUI.addReducer(reducer);
  }


  reregisterReducer(reducer) {
    this.sim.reducers.unregisterAllForReducer(reducer);
    this.registerReducer(reducer);
  }

  registerHandler(handler) {
    handler.id = 'h' + this._nextHandlerId;
    handler.handledEvents.forEach(e => {
      this.sim.register(e.type, handler, handler.name);
    })
    this.eventSchedulerUI.addHandler(handler);
  }

  //Change listeners
  eventChanged(event) {
    //Remove from sim
    this.unscheduleEvent(event);
    if(event.enabled) {
      //Don't add to graph 2x so call super
      this.scheduleEvent(event);
    }
  }

  handlerChanged(handler) {
    // The HandlerEntry object is registered by reference, so name and
    // generatedActions mutations are already live in the sim.
    // Re-sync only the event-type → handler mapping, which changes when the
    // user links or unlinks events via the chip UI.
    this.sim.handlers.unregisterFromAll(handler);
    handler.handledEvents.forEach(e => {
      this.sim.register(e.type, handler);
    });
  }

  actionChanged(action) {
    // Action properties (name, value, fieldName) are on the shared object so
    // they are already live everywhere that references the action.
    // If action.type changed, any reducer registered for the old type key will
    // no longer fire. Find every reducer that holds this action in its
    // reducedActions list and re-register it so it picks up the current type.
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

  reducerChanged(reducer) {
    // Priority is captured in the pipeline entry at registration time and
    // does not update automatically — re-registration picks up the current
    // value. fieldName, name, and other properties are accessed via closure
    // so they are already live, but re-registering is harmless and keeps the
    // pipeline consistent.
    this.reregisterReducer(reducer);
  }
}
