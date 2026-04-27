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
};

/** Snap the start date to the end of the period for period-end intervals. */
export const startSnapFns = {
  'month-end': d => DateUtils.endOfMonth(d),
  'year-end':  d => DateUtils.endOfYear(d),
};

/**
 * Base class for simulation scenarios.
 *
 * ### Responsibilities
 *
 * BaseScenario is now a thin UI coordinator:
 *   - Constructs the Simulation via buildSim().
 *   - Delegates UI button "+" creation events to the appropriate service
 *     create* methods (which publish CREATE on the bus).
 *   - Provides a convenience `sim` getter.
 *
 * ### What lives elsewhere
 *
 * All simulation-wiring logic (scheduling events, registering handlers,
 * wiring reducers, and the inverse operations on UPDATE / DELETE) lives in
 * ServiceRegistry.simulationSync (SimulationSync).  SimulationSync subscribes
 * to the shared bus and keeps the active Simulation in sync automatically.
 *
 * EventScheduler has its own bus subscription that handles graph node creation.
 *
 * ### CustomScenario pattern
 *
 * Subclasses implement loadDefaults() and populate the scenario by inserting
 * items directly into the services.  The bus takes care of the rest:
 *
 *   loadDefaults() {
 *     const sr = ServiceRegistry.getInstance();
 *     const event = new EventSeries({ name: 'Monthly', type: 'MONTH_END',
 *       interval: 'month-end', enabled: true, color: '#F44336' });
 *     sr.eventService.register(event);   // → sim scheduled + graph node added
 *
 *     const action = new AmountAction('PAY', 'Pay Salary', 1200);
 *     sr.actionService.register(action); // → graph node added
 *
 *     const handler = new HandlerEntry(fn, 'Month Handler');
 *     handler.handledEvents.push(event);
 *     handler.generatedActions.push(action);
 *     sr.handlerService.register(handler); // → sim wired + graph node added
 *   }
 */
export class BaseScenario {
  constructor({
      eventSchedulerUI,
      simStart =  new Date(Date.UTC(2026, 0, 1)),
      simEnd = new Date(Date.UTC(2041, 0, 1))} = {}) {

    this.eventSchedulerUI = eventSchedulerUI;
    this.simStart = simStart;
    this.simEnd = simEnd;

    // ── Wire up the "+" creation buttons in EventScheduler ────────────────────
    this.eventSchedulerUI.registerEventCreatedListener(subtype => this.eventCreationRequested(subtype));
    this.eventSchedulerUI.registerHandlerCreatedListener(() => this.handlerCreationRequested());
    this.eventSchedulerUI.registerActionCreatedListener(() => this.actionCreationRequested());
    this.eventSchedulerUI.registerReducerCreatedListener(() => this.reducerCreationRequested());
  }

  // ─── Simulation accessor ──────────────────────────────────────────────────

  /**
   * The active simulation.  Delegates to SimulationRegistry so the sim object
   * is not tightly held by the scenario.
   * @returns {import('../simulation-framework/simulation.js').Simulation|null}
   */
  get sim() {
    return ServiceRegistry.getInstance().simulationRegistry.getPrimary();
  }

  // ─── Build ────────────────────────────────────────────────────────────────

  /**
   * Create a fresh Simulation and register it as 'primary'.
   * Also configures SimulationSync with simStart so recurring events are
   * scheduled from the correct date.
   */
  buildSim(params, initialState) {
    const sr = ServiceRegistry.getInstance();
    sr.simulationRegistry.unregister('primary');
    sr.simulationRegistry.register('primary', new FinSimLib.Core.Simulation(this.simStart, { initialState }));
    sr.simulationSync.setSimStart(this.simStart);
  }

  // ─── Creation handlers (called via EventScheduler "+" buttons) ───────────
  //
  // Each service create* call publishes CREATE on the bus.
  // SimulationSync's subscriber wires it into the sim.
  // EventScheduler's subscriber adds the node to the graph.
  // The only thing these handlers do explicitly is open the editor panel.

  eventCreationRequested(subtype) {
    const { eventService } = ServiceRegistry.getInstance();
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
    this.eventSchedulerUI.editNode(event);
  }

  handlerCreationRequested() {
    const { handlerService } = ServiceRegistry.getInstance();
    const handler = handlerService.createHandler(
      function({ data, date, state }) { return [...this.generatedActions]; },
      'New Handler'
    );
    this.eventSchedulerUI.editNode(handler);
  }

  actionCreationRequested() {
    const { actionService } = ServiceRegistry.getInstance();
    const action = actionService.createAmountAction('NEW_ACTION', 'New Action', 0);
    this.eventSchedulerUI.editNode(action);
  }

  reducerCreationRequested() {
    const { reducerService } = ServiceRegistry.getInstance();
    const reducer = reducerService.createMetricReducer('', 'New Reducer');
    this.eventSchedulerUI.editNode(reducer);
  }
}
