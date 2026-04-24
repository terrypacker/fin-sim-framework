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
  constructor({ eventSeries, customEvents = [],
      simStart =  new Date(Date.UTC(2026, 0, 1)),
      simEnd = new Date(Date.UTC(2041, 0, 1))} = {}) {

    this.eventSeries  = eventSeries;
    this.customEvents = customEvents;

    //TODO need to move these from the superclasses into here
    this.sim = null;
    this.simStart = simStart;
    this.simEnd = simEnd;
    //ID used for all things to be unique
    this._nextHandlerId = 1;
    this._nextReducerId = 1;
    this._nextEventId = 1;
    // Tracks which event types already have a recurring auto-rescheduling handler
    // registered, so we never register a second one on re-enable.
    this._registeredRecurringTypes = new Set();
  }

  /**
   * Schedules all enabled recurring event series onto `this.sim`, then schedules
   * any one-off custom events. Relies on `this.sim` and `this.simStart` being set.
   */
  _scheduleEvents() {
    for (const series of this.eventSeries) {
      this._scheduleEventSeries(series);
    }

    for (const ev of this.customEvents) {
      this._scheduleOneOffEvent(ev);
    }
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
  }

  unscheduleEvent(event) {
    this.sim.unschedule(event.type);
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
      this._registeredRecurringTypes.add(series.type);
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

  _registerReducer(reducer) {
    //Set a unique id
    reducer.id = 'r' + this._nextReducerId++;
    reducer.reducedActions.forEach(action => {
      reducer.registerWith(this.sim.reducers, action.type);
    });
  }

  _registerHandler(handler) {
    handler.id = 'h' + this._nextHandlerId;
    handler.handledEvents.forEach(e => {
      this.sim.register(e.type, handler, handler.name);
    })
  }
}
