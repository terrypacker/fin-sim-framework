/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import {ScenarioSerializer} from "../scenarios/scenario-serializer.js";

/**
 * Scenario id format:
 *   `'<id>'`  — a pre-built scenario (shipped with the app, not in localStorage)
 *   `'u:<N>'`   — a user-saved scenario at index N in `_scenarios`
 */
export class ScenarioService {
  constructor(bus = {}, scenarioRegistry = {}) {
    this._bus = bus;
    this._registry = scenarioRegistry;
  }

  getAll() {
    return this._registry.getAll();
  }
  /**
   * Instantiate the correct scenario class for the current selection.
   * @returns {BaseScenario}
   */
  get(id) {
    return this._registry.get(id);
  }

  save(scenario, active = false) {
    this._registry.save(scenario, active);
  }

  delete(id) {
    this._registry.delete(id);
  }

  /**
   * Get the active scenario
   */
  getActive() {
    return this._registry.getActive();
  }

  /**
   * Base the new scenario on whatever prebuilt is currently active (or the first one).
   * @return {*|null}
   */
  newScenario(fromScenario) {
    const newId = `u:${this._registry.getNextUserScenarioId()}`;
    //TODO Use BaseScenario here
    const scenario = {
      id: newId,
      name:         'New Scenario',
      order: 100,
      prebuilt: false,
      scenarioId:   fromScenario?.id ?? null,
      simStart:     fromScenario?.simStart ?? '2026-01-01',
      simEnd:       fromScenario?.simEnd   ?? '2041-01-01',
      events:       [],
      handlers:     [],
      actions:      [],
      reducers:     [],
      initialState: {},
      params:       [],
    };
    this._registry.save(scenario, true);
  }

  getUserScenarios() {
    return this._registry.getUserScenarios();
  }

  /**
   * Instantiate the correct scenario class for the current selection.
   *
   * Resolution order:
   *  1. Active pre-built → use its factory directly.
   *  2. Active user scenario with a `scenarioId` → use the matching prebuilt factory.
   *  3. Active user scenario without `scenarioId` → use the first prebuilt factory.
   *
   */
  createScenario(simStartIn, simEndIn) {

    const active = this.getActive();
    const simStart = active == null ? simStartIn : new Date(active.simStart);
    const simEnd = active == null ? simEndIn : new Date(active.simEnd);

    if (active.prebuilt) return active.factory(this.getParams(), this.getInitialState(), simStart, simEnd);

    if (active) {
      // Try to find the prebuilt this user scenario was derived from.
      const preBuiltParent = this.get(active.scenarioId);
      const factory = preBuiltParent?.factory;
      if (factory) return factory(this.getParams(), this.getInitialState(),
          (active.simStart) ? new Date(active.simStart) : undefined,
          (active.simEnd) ? new Date(active.simEnd) : undefined);
    }
    throw new Error('ScenarioTabPresenter: no scenario factory available');
  }

  replaceUserScenarios(data) {
    this._registry.replaceUserScenarios(data);
  }

  /** Restore saved config or call loadDefaults(). Called after scenario.buildSim(). */
  afterBuildSim(scenario) {
    // Store so _saveCurrentScenario() can capture the resolved initialState.
    //TODO Was this important?  this._scenario = scenario;

    const cfg = this.getActive();
    if (cfg) {
      ScenarioSerializer.deserialize(cfg, ServiceRegistry.getInstance());
    } else if (typeof scenario.loadDefaults === 'function') {
      scenario.loadDefaults();
    }
  }

  getParams() {
    const params = this._activeUserScenario()?.params;
    if (!params?.length) return {};
    return Object.fromEntries(params.map(p => [p.name, p.value]));
  }

  getInitialState() {
    return this.getActive()?.initialState ?? {};
  }

  _saveCurrentScenario(name, uiInitialState, simStart, simEnd) {
    const pb = this._activePrebuilt();

    if (pb || !this._activeValue?.startsWith('u:')) {
      // Saving from a pre-built baseline → create a new user scenario.


      // Prefer the scenario's resolved initialState (set by buildSim / buildDefaultInitialState)
      // so that the full default state is captured in the config rather than an empty object.
      // Fall back to the UI textarea only if the scenario hasn't been built yet.
      const scenarioInitialState = this._scenario?.initialState ?? {};
      let initialState = Object.keys(scenarioInitialState).length > 0 ? scenarioInitialState : {};
      if (Object.keys(initialState).length === 0) {
        initialState = uiInitialState;
      }
      const usersScenarios = this.getUserScenarios();
      const newId = `u:${usersScenarios.length}`;
      const newScenario = {
        id: newId,
        name,
        scenarioId:   pb?.id ?? null,
        order: 100,
        prebuilt: false,
        simStart:     simStart,
        simEnd:       simEnd,
        events: [], handlers: [], actions: [], reducers: [],
        initialState,
        params: [],
      };
      this._scenarios.set(newId, newScenario);
      this._activeValue = newId;
    }

    const cfg = this._activeUserScenario();
    const serialized = ScenarioSerializer.serialize(
        ServiceRegistry.getInstance(),
        cfg.id,
        cfg.name,
        cfg.order,
        cfg.active,
        cfg.simStart,
        cfg.simEnd,
        cfg.initialState,
        cfg.params,
    );
    Object.assign(cfg, serialized);
    this._persistUserScenarios();
    this._persistLastUsed();
  }

}
