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
    this._fallbackFactory = null;
  }

  /**
   * Register a factory used when a user scenario has no matching scenarioId.
   * Call this once at app startup before createActiveScenario() is first invoked.
   * @param {Function} factory (params, initialState, simStart, simEnd) => BaseScenario
   */
  setFallbackFactory(factory) {
    this._fallbackFactory = factory;
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
   * If the parent prebuilt scenario exposes a param schema, the new scenario's
   * params array is pre-populated with schema defaults so they are immediately
   * available for editing, saving, and MonteCarlo use.
   */
  newScenario(fromScenario) {
    const newId = `u:${this._registry.getNextUserScenarioId()}`;
    const schema = fromScenario?.scenarioClass?.getParamSchema?.() ?? [];
    const params = schema.map(s => ({ name: s.key, label: s.label, type: s.type, group: s.group, value: s.defaultValue }));
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
      params,
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
  createActiveScenario() {
    const active = this.getActive();

    if (active?.prebuilt) return active.factory(
        this._getParams(active),
        this._getInitialState(active),
        new Date(active.simStart), new Date(active.simEnd));

    if (active) {
      const preBuiltParent = this._registry.get(active.scenarioId);
      const factory = preBuiltParent?.factory;
      if (factory) return factory(
        this._getParams(active), this._getInitialState(active),
          new Date(active.simStart), new Date(active.simEnd)
      );

      if (this._fallbackFactory) return this._fallbackFactory(
        this._getParams(active), this._getInitialState(active),
        new Date(active.simStart), new Date(active.simEnd)
      );
    }
    throw new Error('No scenario factory available — register a fallbackFactory via setFallbackFactory()');
  }

  _getParams(scenario) {
    const params = scenario?.params;
    if (!params?.length) return {};
    return Object.fromEntries(params.map(p => {
      const value = p.type === 'Date' && p.value ? new Date(p.value) : p.value;
      return [p.name, value];
    }));
  }

   _getInitialState(scenario) {
    return scenario?.initialState ?? {};
  }

}
