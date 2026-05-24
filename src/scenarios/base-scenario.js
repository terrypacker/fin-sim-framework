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
 * BaseScenario is a thin UI coordinator:
 *   - Constructs the Simulation via buildSim().
 *   - Provides a convenience `sim` getter.
 *
 * All simulation-wiring logic (scheduling events, registering handlers,
 * wiring reducers, and the inverse operations on UPDATE / DELETE) lives in
 * ServiceRegistry.simulationSync (SimulationSync). SimulationSync subscribes
 * to the shared bus and keeps the active Simulation in sync automatically.
 *
 * Scenario population is owned by ScenarioLoader, which dispatches between
 * graph deserialization (saved snapshot) and toolset compilation (declarative
 * inputs). Subclasses declare toolsets via `getToolsets()` + `buildDefaultConfig()`.
 */
export class BaseScenario {
  /**
   * Declare the typed parameters this scenario exposes for UI editing,
   * MonteCarlo sampling, and optimization.
   *
   * Each entry: { key, label, type, group, defaultValue, description }
   *   type: 'Number' | 'Date' | 'Boolean' | 'String'
   *
   * Subclasses override this to describe their specific param surface.
   * @returns {Array<{key:string, label:string, type:string, group:string, defaultValue:*, description:string}>}
   */
  static getParamSchema() { return []; }
  getParamSchema() { return this.constructor.getParamSchema(); }

  /**
   * Return the toolset IDs this scenario declares. Non-empty means the
   * scenario routes through ScenarioCompiler on first load.
   * @returns {string[]}
   */
  static getToolsets() { return []; }
  getToolsets() { return this.constructor.getToolsets(); }

  /**
   * Produce the declarative config that WorkbenchApp merges into activeConfig for a
   * fresh prebuilt scenario.  Must return an object with at minimum:
   *   { toolsets, parameters, persons, accounts, realProperties, collectibles }
   * Returns null for scenarios that don't use the toolset path.
   *
   * @param {object}  _params   - merged params plain object
   * @param {Date}    _simStart
   * @param {Date}    _simEnd
   * @returns {object|null}
   */
  // eslint-disable-next-line no-unused-vars
  static buildDefaultConfig(_params, _simStart, _simEnd) { return null; }

  constructor({
      id,
      order = 100,
      prebuilt =  false,
      context,
      initialState = {},
      params = [],
      simStart =  new Date(Date.UTC(2026, 0, 1)),
      simEnd = new Date(Date.UTC(2041, 0, 1))} = {}) {
    this.id = id;
    this.order = order;
    this.prebuilt = prebuilt;
    this.context = context;
    this.initialState = initialState;
    this.params = params;
    //Validate the inputs to be dates
    if(!this._isDate(simStart)) {
      throw new Error('Must supply simStart Date to scenario');
    }
    if(!this._isDate(simEnd)) {
      throw new Error('Must supply simEnd Date to scenario');
    }
    this.simStart = simStart;
    this.simEnd = simEnd;
  }

  _isDate(date) {
    return date instanceof Date && !isNaN(date);
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
  buildSim() {
    const isEmpty = !this.initialState || Object.keys(this.initialState).length === 0;
    const resolved = isEmpty ? (this.buildDefaultInitialState(this.params) ?? {}) : this.initialState;

    // Persist as a plain object so ScenarioTabPresenter can serialize it.
    this.initialState = typeof resolved?.toPlain === 'function' ? resolved.toPlain() : resolved;

    const { simulationRegistry, simulationSync } = this.context;
    simulationRegistry.unregister('primary');

    const sim = new Simulation(this.simStart, {
      bus:          ServiceRegistry.getInstance().bus,
      graph:        ServiceRegistry.getInstance().graph,
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
