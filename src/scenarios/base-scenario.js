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
import {ServiceRegistry} from "../services/service-registry.js";

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
      context,
      simStart =  new Date(Date.UTC(2026, 0, 1)),
      simEnd = new Date(Date.UTC(2041, 0, 1))} = {}) {

    this.context = context;
    this.simStart = simStart;
    this.simEnd = simEnd;
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
      bus: ServiceRegistry.getInstance().bus,
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

}
