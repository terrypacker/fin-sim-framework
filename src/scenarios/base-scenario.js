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
    this._nextActionId = 1;
    // Tracks which event types already have a recurring auto-rescheduling handler
    // registered, so we never register a second one on re-enable.
    this._registeredRecurringTypes = new Map();

    //Register the scenario for change events
    this.eventSchedulerUI.registerEventChangeListener(e => this.eventChanged(e));
    this.eventSchedulerUI.registerHandlerChangeListener(h => this.handlerChanged(h));
    this.eventSchedulerUI.registerActionChangeListener(a => this.actionChanged(a));
    this.eventSchedulerUI.registerReducerChangeListener(r => this.reducerChanged(r));

    //Register the scenario for creation events
    this.eventSchedulerUI.registerEventCreatedListener(subtype => this.eventCreationRequested(subtype));
    this.eventSchedulerUI.registerHandlerCreatedListener(() => this.handlerCreationRequested());
    this.eventSchedulerUI.registerActionCreatedListener(() => this.actionCreationRequested());
    this.eventSchedulerUI.registerReducerCreatedListener(() => this.reducerCreationRequested());

    //Register the scenario for deletion events
    this.eventSchedulerUI.registerEventDeletedListener(e => this.eventDeleted(e));
    this.eventSchedulerUI.registerHandlerDeletedListener(h => this.handlerDeleted(h));
    this.eventSchedulerUI.registerActionDeletedListener(a => this.actionDeleted(a));
    this.eventSchedulerUI.registerReducerDeletedListener(r => this.reducerDeleted(r));
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
      this.sim.register(series.type, ({ sim, date }) => {
        sim.schedule({ ...series, date: intervalFn(date) });
      });
      this._registeredRecurringTypes.set(series.type, series);
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

    this.sim.schedule({ ...series, date: start });
  }

  _scheduleOneOffEvent(event) {
    if (event.enabled) {
      this.sim.schedule({ ...event, date: new Date(event.date) });
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
    handler.id = 'h' + this._nextHandlerId++;
    handler.handledEvents.forEach(e => {
      this.sim.register(e.type, handler, handler.name);
    })
    this.eventSchedulerUI.addHandler(handler);
  }

  //Creation listeners
  eventCreationRequested(subtype) {
    const id = 'e' + this._nextEventId++;
    let event;
    if (subtype === 'OneOff') {
      event = new FinSimLib.Core.OneOffEvent({
        id, name: 'New One-Off Event', type: 'NEW_ONEOFF_' + id, date: new Date(), enabled: false, color: '#f87171'
      });
    } else {
      event = new FinSimLib.Core.EventSeries({
        id, name: 'New Event Series', type: 'NEW_SERIES_' + id,
        interval: 'month-end', enabled: false, color: '#60a5fa'
      });
    }
    this.eventSchedulerUI.addEvent(event);
    this.eventSchedulerUI.editNode(event);
  }

  handlerCreationRequested() {
    const handler = new FinSimLib.Core.HandlerEntry(function({ data, date, state }) {
      return [...this.generatedActions];
    }, 'New Handler');
    this.registerHandler(handler);
    this.eventSchedulerUI.editNode(handler);
  }

  actionCreationRequested() {
    const id = 'a' + this._nextActionId++;
    const action = new FinSimLib.Core.AmountAction('NEW_ACTION_' + id, 'New Action', 0);
    this.eventSchedulerUI.addAction(action);
    this.eventSchedulerUI.editNode(action);
  }

  reducerCreationRequested() {
    const reducer = FinSimLib.Core.MetricReducer.fromMetric('').withName('New Reducer');
    this.registerReducer(reducer);
    this.eventSchedulerUI.editNode(reducer);
  }

  //Deletion listeners
  eventDeleted(event) {
    if (event.enabled) {
      this.unscheduleEvent(event);
    }
    this._registeredRecurringTypes.delete(event.type);
  }

  handlerDeleted(handler) {
    this.sim.handlers.unregisterFromAll(handler);
  }

  actionDeleted(action) {
    // Remove from any handler's generatedActions
    for (const handler of this.eventSchedulerUI.graph.getKind('handler')) {
      if (handler.generatedActions) {
        const i = handler.generatedActions.findIndex(a => a.id === action.id);
        if (i >= 0) handler.generatedActions.splice(i, 1);
      }
    }
    // Remove from any reducer's reducedActions / generatedActions and re-register
    for (const reducer of this.eventSchedulerUI.graph.getKind('reducer')) {
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

  reducerDeleted(reducer) {
    this.sim.reducers.unregisterAllForReducer(reducer);
  }

  //Change listeners
  eventChanged(event) {
    this.unscheduleEvent(event);
    if (event.enabled) {
      if (event.date) {
        this._scheduleOneOffEvent(event);
      } else {
        this._scheduleEventSeries(event);
      }
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
