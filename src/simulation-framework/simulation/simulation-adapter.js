/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import {BaseEvent} from "../events/base-event.js";
import {HandlerEntry} from "../handlers.js";
import {Reducer} from "../reducers.js";
import {DateUtils} from "../date-utils.js";
import {OneOffEvent} from "../events/one-off-event.js";
import {EventSeries} from "../events/event-series.js";

/**
 * Interval functions used by SimulationSync to advance recurring event dates.
 * Exported so consumers can reuse them without re-deriving the same logic.
 */
export const intervalFns = {
  monthly:    d => DateUtils.addMonths(d, 1),
  quarterly:  d => DateUtils.addMonths(d, 3),
  annually:   d => DateUtils.addYears(d, 1),
  'month-end': d => DateUtils.endOfMonth(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1))),
  'year-end':  d => DateUtils.endOfYear(DateUtils.addYears(d, 1)),
  // Semi-annual, anchored to the two half-year ends (Jun 30 / Dec 31). Computed from
  // the calendar half rather than day-preserving addMonths (which overflows Jun 31 →
  // Jul 1) so firings land exactly on the period boundary every step. Design 66 §G10a.
  'semiannual': d => (d.getUTCMonth() <= 5
    ? new Date(Date.UTC(d.getUTCFullYear(), 11, 31))       // first half  → Dec 31 this year
    : new Date(Date.UTC(d.getUTCFullYear() + 1, 5, 30))),  // second half → Jun 30 next year
};

/** Snap the start date to the end of the period for period-end intervals. */
export const startSnapFns = {
  'month-end': d => DateUtils.endOfMonth(d),
  'year-end':  d => DateUtils.endOfYear(d),
  // Snap to the next half-year end (Jun 30 or Dec 31) at/after the start. Design 66 §G10a.
  'semiannual': d => {
    const y = d.getUTCFullYear();
    const jun30 = new Date(Date.UTC(y, 5, 30));
    const dec31 = new Date(Date.UTC(y, 11, 31));
    if (d <= jun30) return jun30;
    if (d <= dec31) return dec31;
    return new Date(Date.UTC(y + 1, 5, 30));
  },
};

/**
 * - accept inputs
 * - mutate the simulation
 */
export class SimulationAdapter {
  constructor({ sim, simStart }) {
    this.sim = sim;
    this.simStart = simStart;

    this._registeredRecurringTypes = new Map();
  }

  setSim(sim) {
    this.sim = sim;
  }

  /**
   * Clear per-run state. Called by SimulationSync on 'execution:reset' so that
   * a fresh Simulation gets all recurring-event handlers registered from scratch.
   * Without this, _registeredRecurringTypes retains entries from the previous run
   * and the recurring self-scheduling closures are never wired into the new sim,
   * causing each EventSeries to fire exactly once instead of throughout the run.
   */
  reset() {
    this._registeredRecurringTypes.clear();
  }

  /**
   * Must be called after the Simulation is created so recurring events can be
   * scheduled relative to the right start date.
   * @param {Date} simStart
   */
  setSimStart(simStart) {
    this.simStart = simStart;
  }

  // ─── PUBLIC API (called by outer layer) ─────────────────────────────

  onCreate(item) {
    if (!this.sim) return;

    if (this._isEvent(item)) {
      if (item.enabled) {
        item.date
            ? this._scheduleOneOffEvent(item)
            : this._scheduleEventSeries(item);
      }
    } else if (this._isHandler(item)) {
      this._wireHandler(item);
    } else if (this._isReducer(item)) {
      this._wireReducer(item);
    }
  }

  onUpdate(item) {
    if (!this.sim) return;

    if (this._isEvent(item)) {
      this._applyEventChange(item);
    } else if (this._isHandler(item)) {
      this._applyHandlerChange(item);
    } else if (this._isReducer(item)) {
      this._applyReducerChange(item);
    }
  }

  onDelete(item) {
    if (!this.sim) return;

    if (this._isEvent(item)) {
      this._applyEventDelete(item);
    } else if (this._isHandler(item)) {
      this._applyHandlerDelete(item);
    } else if (this._isReducer(item)) {
      this._applyReducerDelete(item);
    }
  }

  // ─── TYPE GUARDS (no imports from services) ─────────────────────────

  _isEvent(item) {
    return item instanceof BaseEvent;
  }

  _isHandler(item) {
    return item instanceof HandlerEntry;
  }

  _isReducer(item) {
    return item instanceof Reducer;
  }

  // ─── EXISTING LOGIC (mostly unchanged) ──────────────────────────────

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

    if (series.month != null && series.day != null) {
      // Anchor to a fixed calendar date each year (e.g. Jun 30, Dec 31).
      // Normalize via sim.normalizeDate so we stay in UTC-midnight space,
      // consistent with how the simulation queues and compares all dates.
      const normed = this.sim.normalizeDate(start);
      start = new Date(Date.UTC(normed.getUTCFullYear(), series.month - 1, series.day));
    } else {
      const snapFn = startSnapFns[series.interval];
      if (snapFn) start = snapFn(start);
    }

    while (start <= this.sim.currentDate) {
      start = intervalFn(start);
    }

    this.sim.schedule({ ...series, date: start });
  }

  _scheduleOneOffEvent(event) {
    if(!event.enabled) return;
    this.sim.schedule({ ...event, date: new Date(event.date) });
  }

  _applyEventChange(event) {
    this.sim.unschedule(event.type);
    if (event.enabled) {
      if(event instanceof OneOffEvent) {
        this._scheduleOneOffEvent(event)
      }else if(event instanceof EventSeries) {
        this._scheduleEventSeries(event);
      }else {
        throw new Error(`Unsupported event type ${event.prototype.constructor}`);
      }
    }
  }

  _applyEventDelete(event) {
    this.sim.unschedule(event.type);
    this._registeredRecurringTypes.delete(event.type);
  }

  /**
   * Wire a handler into the simulation's HandlerRegistry.
   *
   * Supports two registration styles:
   *   1. Event-linked style: handler.handledEvents[] holds EventSeries objects;
   *      each series.type is used as the registry key.
   *   2. Direct-wired style: handler class declares a static eventType string;
   *      used for finance-domain handlers whose event type is fixed by design
   *      (e.g. CHANGE_RESIDENCY, OUT_OF_FUNDS, INTL_TRANSFER_TO_US/AU).
   *
   * @private
   */
  _wireHandler(handler) {
    if (handler.handledEvents.length > 0) {
      const types = new Set(handler.handledEvents.map(e => e.type));
      types.forEach(type => this.sim.register(type, handler, handler.name));
    } else if (handler.constructor.eventType) {
      this.sim.register(handler.constructor.eventType, handler, handler.name);
    }
  }

  _applyHandlerChange(handler) {
    this.sim.handlers.unregisterFromAll(handler);
    this._wireHandler(handler);
  }

  _applyHandlerDelete(handler) {
    this.sim.handlers.unregisterFromAll(handler);
  }

  /**
   * Wire a reducer into the simulation pipeline.
   *
   * Supports two registration styles:
   *   1. Service-graph style: reducer.reducedActionTypes[] holds type strings;
   *      each string is used directly as the pipeline key.
   *   2. Direct-wired style: reducer class declares a static actionType string;
   *      used for finance-domain reducers whose action type is fixed by design.
   *
   * @private
   */
  _wireReducer(reducer) {
    if (reducer.reducedActionTypes.length > 0) {
      reducer.reducedActionTypes.forEach(type => reducer.registerWith(this.sim.reducers, type));
    } else if (reducer.constructor.actionType) {
      reducer.registerWith(this.sim.reducers, reducer.constructor.actionType);
    }
  }

  _applyReducerChange(reducer) {
    this.sim.reducers.unregisterAllForReducer(reducer);
    this._wireReducer(reducer);
  }

  _applyReducerDelete(reducer) {
    this.sim.reducers.unregisterAllForReducer(reducer);
  }


}
