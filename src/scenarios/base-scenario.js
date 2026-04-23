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

  /**
   * Schedule a single event series
   * @param series
   * @private
   */
  _scheduleEventSeries(series) {
    if(series.enabled) {
      //Prep the series for schedule
      let start = series.startOffset
          ? DateUtils.addYears(this.simStart, series.startOffset)
          : this.simStart;
      const snapFn = startSnapFns[series.interval];
      if (snapFn) start = snapFn(start);
      this.sim.scheduleRecurring({
        startDate: start,
        type: series.type,
        intervalFn: intervalFns[series.interval]
      });
    }
  }

  _scheduleOneOffEvent(event) {
    if (event.enabled) {
      this.sim.schedule({
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
