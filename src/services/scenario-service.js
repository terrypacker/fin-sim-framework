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
   * If the parent prebuilt scenario exposes a param schema, the new scenario's
   * params array is pre-populated with schema defaults so they are immediately
   * available for editing, saving, and MonteCarlo use.
   */
  newScenario(fromScenario) {
    const newId = `u:${this._registry.getNextUserScenarioId()}`;
    const schema = fromScenario?.scenarioClass?.getParamSchema?.() ?? [];
    // Prefer the pre-populated params array from fromScenario (set by ScenarioLoader after
    // compilation) over recomputing from schema defaults, so edits are preserved.
    const params = Array.isArray(fromScenario?.params)
      ? structuredClone(fromScenario.params)
      : schema.map(s => ({ name: s.key, label: s.label, type: s.type, group: s.group, value: s.defaultValue }));
    const scenario = {
      id:             newId,
      name:           'New Scenario',
      order:          100,
      prebuilt:       false,
      scenarioId:     fromScenario?.id ?? null,
      simStart:       fromScenario?.simStart ?? new Date(Date.UTC(2026, 0, 1)),
      simEnd:         fromScenario?.simEnd   ?? new Date(Date.UTC(2041, 0, 1)),
      events:         structuredClone(fromScenario?.events         ?? []),
      handlers:       structuredClone(fromScenario?.handlers       ?? []),
      actions:        structuredClone(fromScenario?.actions        ?? []),
      reducers:       structuredClone(fromScenario?.reducers       ?? []),
      initialState:   structuredClone(fromScenario?.initialState   ?? {}),
      toolsets:       structuredClone(fromScenario?.toolsets        ?? []),
      persons:        structuredClone(fromScenario?.persons         ?? []),
      accounts:       structuredClone(fromScenario?.accounts        ?? []),
      realProperties: structuredClone(fromScenario?.realProperties  ?? []),
      collectibles:   structuredClone(fromScenario?.collectibles    ?? []),
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
   *  2. Active user scenario with a matching scenarioId → use that prebuilt's factory.
   *  3. Active user scenario without a match → fall back to the first prebuilt's factory.
   */
  createActiveScenario() {
    const active = this.getActive();
    if (!active) throw new Error('No active scenario');

    if (active.prebuilt) return active.factory(
        this._getParams(active),
        this._getInitialState(active),
        new Date(active.simStart), new Date(active.simEnd));

    const parent  = this._registry.get(active.scenarioId);
    const factory = parent?.factory ?? this._registry.getPrebuiltScenarios()[0]?.factory;
    if (!factory) throw new Error('No prebuilt scenario factory available');

    return factory(
      this._getParams(active), this._getInitialState(active),
      new Date(active.simStart), new Date(active.simEnd),
    );
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
