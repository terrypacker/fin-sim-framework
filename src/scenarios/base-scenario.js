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
import { ServiceRegistry } from '../services/service-registry.js';

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
 * ### Architecture (Parts 1–3)
 *
 * The scenario no longer bridges EventScheduler change/delete events to the
 * simulation.  Instead it subscribes directly to the ServiceRegistry's shared
 * EventBus and reacts to ServiceActionEvents.  This means:
 *
 * - No change/delete listeners are registered with EventScheduler.
 * - The Simulation lives in ServiceRegistry.simulationRegistry (Part 3).
 *   `this.sim` is a getter that delegates there.
 * - scheduleEvent / registerHandler / registerReducer call service.load() so
 *   that items created outside the service (fluent builders, ScenarioSerializer)
 *   are still findable via service.get(id) for subsequent editor updates.
 *
 * Creation listeners remain registered with EventScheduler for now.
 */
export class BaseScenario {
  constructor({
      eventSchedulerUI,
      simStart =  new Date(Date.UTC(2026, 0, 1)),
      simEnd = new Date(Date.UTC(2041, 0, 1))} = {}) {

    // Kept for programmatic graph management (loadDefaults, ScenarioSerializer)
    this.eventSchedulerUI = eventSchedulerUI;
    this.simStart = simStart;
    this.simEnd = simEnd;

    // ID counters — still used by ScenarioSerializer to avoid collision with
    // pre-saved IDs.  Service ID counters auto-advance separately.
    this._nextHandlerId = 1;
    this._nextReducerId = 1;
    this._nextEventId = 1;
    this._nextActionId = 1;

    // Tracks which event types already have a recurring auto-rescheduling
    // handler registered so we never register a second one on re-enable.
    this._registeredRecurringTypes = new Map();

    // ── Subscribe to service bus for change / delete routing ──────────────
    // (replaces the 8 change+delete listener registrations that used to live here)
    ServiceRegistry.getInstance().bus.subscribe('SERVICE_ACTION', (msg) => {
      this._handleServiceAction(msg);
    });

    // ── Creation listeners remain (EventScheduler still notifies on + buttons) ──
    this.eventSchedulerUI.registerEventCreatedListener(subtype => this.eventCreationRequested(subtype));
    this.eventSchedulerUI.registerHandlerCreatedListener(() => this.handlerCreationRequested());
    this.eventSchedulerUI.registerActionCreatedListener(() => this.actionCreationRequested());
    this.eventSchedulerUI.registerReducerCreatedListener(() => this.reducerCreationRequested());
  }

  // ─── Simulation accessor (Part 3) ─────────────────────────────────────────

  /**
   * The active simulation.  Delegates to SimulationRegistry so the sim object
   * is not tightly held by the scenario.
   * @returns {import('../simulation-framework/simulation.js').Simulation|null}
   */
  get sim() {
    return ServiceRegistry.getInstance().simulationRegistry.getPrimary();
  }

  // ─── Build ────────────────────────────────────────────────────────────────

  buildSim(params, initialState) {
    const { simulationRegistry } = ServiceRegistry.getInstance();
    // Clear any previous simulation so the registry always holds the current one
    simulationRegistry.unregister('primary');
    simulationRegistry.register('primary', new FinSimLib.Core.Simulation(this.simStart, { initialState }));
  }

  // ─── Event scheduling ─────────────────────────────────────────────────────

  scheduleEvent(event) {
    if (!event.enabled) {
      throw new Error('Do not schedule a disabled event');
    }
    if (!event.id) {
      event.id = 'e' + this._nextEventId++;
    }

    // Ensure the item is in the service map so editor updates can find it
    const { eventService } = ServiceRegistry.getInstance();
    if (!eventService.get(event.id)) {
      eventService.load(event);
    }

    if (event.date) {
      this._scheduleOneOffEvent(event);
    } else {
      this._scheduleEventSeries(event);
    }
    this.eventSchedulerUI.addEvent(event);
  }

  unscheduleEvent(event) {
    this.sim.unschedule(event.type);
  }

  getRegisteredRecurringEvents() {
    return [...this._registeredRecurringTypes.values()];
  }

  /**
   * Schedule a single event series against the sim.
   * Safe to call multiple times for the same type (re-enable after unschedule).
   * @private
   */
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

  _scheduleOneOffEvent(event) {
    if (event.enabled) {
      this.sim.schedule({ ...event, date: new Date(event.date) });
    }
  }

  // ─── Handler / Reducer registration ───────────────────────────────────────

  /**
   * Wire a reducer into the sim and add it to the graph.
   * Calls service.load() so the reducer is findable via reducerService.get(id)
   * for subsequent editor updates (handles fluent-built reducers and
   * deserialized reducers that were constructed outside the service).
   */
  registerReducer(reducer) {
    if (!reducer.id) {
      reducer.id = 'r' + this._nextReducerId++;
    }

    const { reducerService } = ServiceRegistry.getInstance();
    if (!reducerService.get(reducer.id)) {
      reducerService.load(reducer);
    }

    reducer.reducedActions.forEach(action => {
      reducer.registerWith(this.sim.reducers, action.type);
    });
    this.eventSchedulerUI.addReducer(reducer);
  }

  reregisterReducer(reducer) {
    this.sim.reducers.unregisterAllForReducer(reducer);
    reducer.reducedActions.forEach(action => {
      reducer.registerWith(this.sim.reducers, action.type);
    });
  }

  /**
   * Wire a handler into the sim and add it to the graph.
   * Calls service.load() so the handler is findable via handlerService.get(id).
   */
  registerHandler(handler) {
    if (!handler.id) {
      handler.id = 'h' + this._nextHandlerId++;
    }

    const { handlerService } = ServiceRegistry.getInstance();
    if (!handlerService.get(handler.id)) {
      handlerService.load(handler);
    }

    handler.handledEvents.forEach(e => {
      this.sim.register(e.type, handler, handler.name);
    });
    this.eventSchedulerUI.addHandler(handler);
  }

  // ─── Service bus subscriber ────────────────────────────────────────────────

  /**
   * Dispatch incoming ServiceActionEvents to the appropriate apply method.
   * This replaces the 8 listener registrations that previously lived in the
   * constructor (4 change + 4 delete listeners on EventScheduler).
   * @private
   */
  _handleServiceAction(msg) {
    if (!this.sim) return; // sim not yet built

    const { actionType, classType, item } = msg;

    if (actionType === 'UPDATE') {
      if (classType === 'EventSeries' || classType === 'OneOffEvent') {
        this._applyEventChange(item);
      } else if (classType === 'HandlerEntry') {
        this._applyHandlerChange(item);
      } else if (this._isActionClass(classType)) {
        this._applyActionChange(item);
      } else if (this._isReducerClass(classType)) {
        this._applyReducerChange(item);
      }
    } else if (actionType === 'DELETE') {
      if (classType === 'EventSeries' || classType === 'OneOffEvent') {
        this._applyEventDelete(item);
      } else if (classType === 'HandlerEntry') {
        this._applyHandlerDelete(item);
      } else if (this._isActionClass(classType)) {
        this._applyActionDelete(item);
      } else if (this._isReducerClass(classType)) {
        this._applyReducerDelete(item);
      }
    }
  }

  _isActionClass(classType) {
    return ['AmountAction', 'RecordMetricAction', 'RecordArrayMetricAction',
            'RecordNumericSumMetricAction', 'RecordMultiplicativeMetricAction',
            'RecordBalanceAction'].includes(classType);
  }

  _isReducerClass(classType) {
    return ['MetricReducer', 'ArrayMetricReducer', 'NumericSumMetricReducer',
            'MultiplicativeMetricReducer', 'NoOpReducer', 'FieldReducer',
            'StateFieldReducer', 'AccountTransactionReducer'].includes(classType);
  }

  // ─── Apply methods (called from bus subscriber) ────────────────────────────

  _applyEventChange(event) {
    this.unscheduleEvent(event);
    if (event.enabled) {
      if (event.date) {
        this._scheduleOneOffEvent(event);
      } else {
        this._scheduleEventSeries(event);
      }
    }
  }

  _applyHandlerChange(handler) {
    this.sim.handlers.unregisterFromAll(handler);
    handler.handledEvents.forEach(e => {
      this.sim.register(e.type, handler);
    });
  }

  _applyActionChange(action) {
    // If action.type changed, any reducer registered for the old type key will
    // no longer fire.  Re-register all reducers that hold this action.
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

  _applyReducerChange(reducer) {
    this.reregisterReducer(reducer);
  }

  _applyEventDelete(event) {
    if (event.enabled) {
      this.unscheduleEvent(event);
    }
    this._registeredRecurringTypes.delete(event.type);
  }

  _applyHandlerDelete(handler) {
    this.sim.handlers.unregisterFromAll(handler);
  }

  _applyActionDelete(action) {
    const { handlerService, reducerService } = ServiceRegistry.getInstance();

    // Remove from any handler's generatedActions
    for (const handler of handlerService.getAll()) {
      if (handler.generatedActions) {
        const i = handler.generatedActions.findIndex(a => a.id === action.id);
        if (i >= 0) handler.generatedActions.splice(i, 1);
      }
    }

    // Remove from any reducer's reducedActions / generatedActions and re-register
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

  _applyReducerDelete(reducer) {
    this.sim.reducers.unregisterAllForReducer(reducer);
  }

  // ─── Creation handlers (still called via EventScheduler creation listeners) ─

  eventCreationRequested(subtype) {
    const { eventService } = ServiceRegistry.getInstance();
    // Pre-generate the ID once so it can be used in both the id field and the
    // type string without double-consuming the service counter.
    const id = eventService._generateId('e');
    let event;
    if (subtype === 'OneOff') {
      event = eventService.createOneOffEvent({
        id,
        name: 'New One-Off Event', type: 'NEW_ONEOFF_' + id,
        date: new Date(), enabled: false, color: '#f87171'
      });
    } else {
      event = eventService.createEventSeries({
        id,
        name: 'New Event Series', type: 'NEW_SERIES_' + id,
        interval: 'month-end', enabled: false, color: '#60a5fa'
      });
    }
    this.eventSchedulerUI.addEvent(event);
    this.eventSchedulerUI.editNode(event);
  }

  // ─── Backward-compat aliases ───────────────────────────────────────────────
  // These were previously the EventScheduler change-listener callbacks.  They
  // now delegate to the internal _apply* methods so existing tests and any
  // external code that still calls them directly continue to work.

  eventChanged(event)   { this._applyEventChange(event); }
  handlerChanged(h)     { this._applyHandlerChange(h); }
  actionChanged(action) { this._applyActionChange(action); }
  reducerChanged(r)     { this._applyReducerChange(r); }

  handlerCreationRequested() {
    const { handlerService } = ServiceRegistry.getInstance();
    const handler = handlerService.createHandler(
      function({ data, date, state }) { return [...this.generatedActions]; },
      'New Handler'
    );
    this.registerHandler(handler);
    this.eventSchedulerUI.editNode(handler);
  }

  actionCreationRequested() {
    const { actionService } = ServiceRegistry.getInstance();
    const action = actionService.createAmountAction(
      'NEW_ACTION_' + actionService._generateId('a'), 'New Action', 0
    );
    this.eventSchedulerUI.addAction(action);
    this.eventSchedulerUI.editNode(action);
  }

  reducerCreationRequested() {
    const { reducerService } = ServiceRegistry.getInstance();
    const reducer = reducerService.createMetricReducer('').withName('New Reducer');
    this.registerReducer(reducer);
    this.eventSchedulerUI.editNode(reducer);
  }
}
