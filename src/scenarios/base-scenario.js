/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import {Simulation} from "../simulation-framework/simulation.js";

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
 * ConfigBuilder has its own bus subscription that handles graph node creation.
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
 *     handler.generatedActionTypes.push(action.type);
 *     handler.generatedActionDefinitions.push(ActionDefinition.fromAction(action));
 *     sr.handlerService.register(handler); // → sim wired + graph node added
 *   }
 */
export class BaseScenario {
  constructor({
      eventSchedulerUI,
      context,
      simStart =  new Date(Date.UTC(2026, 0, 1)),
      simEnd = new Date(Date.UTC(2041, 0, 1))} = {}) {

    this.eventSchedulerUI = eventSchedulerUI;
    this.context = context;
    this.simStart = simStart;
    this.simEnd = simEnd;

    // ── Wire up the "+" creation buttons in ConfigBuilder ────────────────────
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
    return this.context.simulationRegistry.getPrimary();
  }

  // ─── Build ────────────────────────────────────────────────────────────────

  /**
   * Create a fresh Simulation and register it as 'primary'.
   * Also configures SimulationSync with simStart so recurring events are
   * scheduled from the correct date.
   *
   * If `initialState` is absent or empty, calls `buildDefaultInitialState(params)`
   * so subclasses can supply a scenario-specific default without overriding this
   * method.  The resolved state (as a plain object) is stored on `this.initialState`
   * so it can be captured for serialization.
   */
  buildSim(params, initialState) {
    const isEmpty = !initialState || Object.keys(initialState).length === 0;
    const resolved = isEmpty ? (this.buildDefaultInitialState(params) ?? {}) : initialState;

    // Persist as a plain object so ScenarioTabPresenter can serialize it.
    this.initialState = typeof resolved?.toPlain === 'function' ? resolved.toPlain() : resolved;

    const { simulationRegistry, simulationSync } = this.context;
    simulationRegistry.unregister('primary');

    const sim = new Simulation(this.simStart, {
      initialState: resolved,
    });

    simulationRegistry.register('primary', sim);
    simulationSync.setSimStart(this.simStart);
  }

  /**
   * Override to supply a scenario-specific default initial state.
   * Called from buildSim() when no saved initialState is provided.
   * Return a SimulationState instance (with toPlain()) or a plain object.
   * @param {object} _params - Merged scenario params.
   * @returns {object|null}
   */
  // eslint-disable-next-line no-unused-vars
  buildDefaultInitialState(_params) {
    return null;
  }

  // ─── Creation handlers (called via ConfigBuilder "+" buttons) ───────────
  //
  // Each service create* call publishes CREATE on the bus.
  // SimulationSync's subscriber wires it into the sim.
  // ConfigBuilder's subscriber adds the node to the graph.
  // The only thing these handlers do explicitly is open the editor panel.

  eventCreationRequested(subtype) {
    const { eventService } = this.context;
    //TODO need a better way to generate unique names and ids outside of the EventService...
    const id = eventService._generateId('e');
    let event;
    if (subtype === 'OneOff') {
      event = eventService.createOneOffEvent({
        id: id,
        name: 'New One-Off Event',
        type: 'NEW_ONEOFF_' + id,
        date: new Date(), enabled: false,
        color: '#f87171'
      });
    } else {
      event = eventService.createEventSeries({
        id: id,
        name: 'New Event Series',
        type: 'NEW_SERIES_' + id,
        interval: 'month-end', enabled: false,
        color: '#60a5fa'
      });
    }
    this.eventSchedulerUI.editNode(event);
  }

  handlerCreationRequested() {
    const { handlerService } = this.context;
    // null fn → uses HandlerEntry.defaultFunction which instantiates from generatedActionDefinitions
    const handler = handlerService.createHandler(null, 'New Handler');
    this.eventSchedulerUI.editNode(handler);
  }

  actionCreationRequested() {
    const { actionService } = this.context;
    const action = actionService.createAmountAction('NEW_ACTION', 'New Action', 0);
    this.eventSchedulerUI.editNode(action);
  }

  reducerCreationRequested() {
    const { reducerService } = this.context;
    const reducer = reducerService.createFieldReducer('', 'New Reducer');
    this.eventSchedulerUI.editNode(reducer);
  }
}
