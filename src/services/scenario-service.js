/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Scenario id format:
 *   'p:<id>'  — a pre-built scenario
 *   'u:<N>'   — a user-saved scenario at index N
 */
export class ScenarioService {
  constructor(bus = {}, scenarioRegistry = {}) {
    this._bus = bus;
    this._registry = scenarioRegistry;
  }

  getAll() {
    return this._registry.getAll();
  }

  get(id) {
    return this._registry.get(id);
  }

  save(scenario, active = false) {
    this._registry.save(scenario, active);
  }

  delete(id) {
    this._registry.delete(id);
  }

  getActive() {
    return this._registry.getActive();
  }

  setActiveById(id) {
    this._registry.setActiveById(id);
  }

  /**
   * Create a new user scenario based on fromScenario (copies dates and scenarioId).
   */
  newScenario(fromScenario) {
    const newId = `u:${this._registry.getNextUserScenarioId()}`;
    const scenario = {
      id:           newId,
      name:         'New Scenario',
      order:        100,
      prebuilt:     false,
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
    return scenario;
  }

  getUserScenarios() {
    return this._registry.getUserScenarios();
  }

  replaceUserScenarios(data) {
    this._registry.replaceUserScenarios(data);
  }

  /**
   * Instantiate the correct scenario class for the current selection.
   *
   * Resolution order:
   *  1. Active pre-built → use its factory directly.
   *  2. Active user scenario with a scenarioId → use the matching prebuilt factory.
   *  3. Active user scenario without scenarioId → use the first prebuilt factory.
   */
  createScenario(simStartIn, simEndIn) {
    const active = this.getActive();
    const simStart = active == null ? simStartIn : new Date(active.simStart);
    const simEnd   = active == null ? simEndIn   : new Date(active.simEnd);

    if (active?.prebuilt) return active.factory(this.getParams(), this.getInitialState(), simStart, simEnd);

    if (active) {
      const preBuiltParent = this._registry.get(active.scenarioId);
      const factory = preBuiltParent?.factory;
      if (factory) return factory(
        this.getParams(), this.getInitialState(),
        active.simStart ? new Date(active.simStart) : undefined,
        active.simEnd   ? new Date(active.simEnd)   : undefined
      );

      const firstPrebuilt = this._registry.getPrebuiltScenarios()[0];
      if (firstPrebuilt?.factory) return firstPrebuilt.factory(
        this.getParams(), this.getInitialState(),
        active.simStart ? new Date(active.simStart) : undefined,
        active.simEnd   ? new Date(active.simEnd)   : undefined
      );
    }
    throw new Error('No scenario factory available');
  }

  getParams() {
    const params = this._activeUserScenario()?.params;
    if (!params?.length) return {};
    return Object.fromEntries(params.map(p => [p.name, p.value]));
  }

  getInitialState() {
    return this.getActive()?.initialState ?? {};
  }

  _activePrebuilt() {
    const active = this.getActive();
    return active?.prebuilt ? active : null;
  }

  _activeUserScenario() {
    const active = this.getActive();
    return active && !active.prebuilt ? active : null;
  }
}
