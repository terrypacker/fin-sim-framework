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
      : schema.map(s => {
          const entry = { name: s.key, label: s.label, type: s.type, group: s.group, value: s.defaultValue };
          if (s.node) entry.node = s.node;
          return entry;
        });
    const scenario = {
      id:             newId,
      name:           'New Scenario',
      order:          100,
      prebuilt:       false,
      scenarioId:     fromScenario?.id ?? null,
      simStart:       ScenarioSerializer.toDateStr(fromScenario?.simStart ?? new Date(Date.UTC(2026, 0, 1))),
      simEnd:         ScenarioSerializer.toDateStr(fromScenario?.simEnd   ?? new Date(Date.UTC(2041, 0, 1))),
      events:         structuredClone(fromScenario?.events         ?? []),
      handlers:       structuredClone(fromScenario?.handlers       ?? []),
      actions:        structuredClone(fromScenario?.actions        ?? []),
      reducers:       structuredClone(fromScenario?.reducers       ?? []),
      initialState:   structuredClone(fromScenario?.initialState   ?? {}),
      toolsets:       structuredClone(fromScenario?.toolsets        ?? []),
      scenarioClass:  fromScenario?.scenarioClass ?? null,
      persons:        structuredClone(fromScenario?.persons         ?? []),
      accounts:       structuredClone(fromScenario?.accounts        ?? []),
      realProperties: structuredClone(fromScenario?.realProperties  ?? []),
      collectibles:   structuredClone(fromScenario?.collectibles    ?? []),
      params,
    };
    this._registry.save(scenario, true);
    return scenario;
  }

  /**
   * Reset each param's value to the schema's defaultValue for that key.
   * Params not present in the schema (user-added) are left untouched.
   */
  resetParamsFromSchema(scenario) {
    const schema = scenario?.scenarioClass?.getParamSchema?.() ?? [];
    if (!schema.length || !Array.isArray(scenario?.params)) return;
    const schemaMap = new Map(schema.map(s => [s.key, s]));
    for (const p of scenario.params) {
      const s = schemaMap.get(p.name);
      if (s !== undefined) p.value = s.defaultValue;
    }
  }

  /**
   * Design 15 §2.4: "Reset to Defaults" — explicit user-triggered restoration
   * of the prebuilt's reference scenario. Replaces the cfg's top-level domain
   * data (persons / accounts / realProperties / collectibles / toolsets /
   * parameters) with buildDefaultConfig() output and resets all params to
   * schema defaults. The scenario record itself (id, name, parent reference)
   * is preserved. Clears any saved graph snapshot so the next load takes the
   * compile branch.
   *
   * No-op when the scenario's scenarioClass cannot produce defaults.
   */
  resetToDefaults(scenario) {
    const ScenarioCls = scenario?.scenarioClass;
    if (typeof ScenarioCls?.buildDefaultConfig !== 'function') return;

    this.resetParamsFromSchema(scenario);

    const schema = ScenarioCls.getParamSchema?.() ?? [];
    const defaultParams = Object.fromEntries(schema.map(s => [s.key, s.defaultValue]));
    const defaults = ScenarioCls.buildDefaultConfig(defaultParams, scenario.simStart, scenario.simEnd);
    if (!defaults) return;

    scenario.toolsets       = structuredClone(defaults.toolsets       ?? []);
    scenario.parameters     = structuredClone(defaults.parameters     ?? {});
    scenario.persons        = structuredClone(defaults.persons        ?? []);
    scenario.accounts       = structuredClone(defaults.accounts       ?? []);
    scenario.realProperties = structuredClone(defaults.realProperties ?? []);
    scenario.collectibles   = structuredClone(defaults.collectibles   ?? []);

    // Drop the saved compiled graph so the next ScenarioLoader.load() takes the
    // compile branch and rebuilds events/handlers/reducers from the toolsets.
    scenario.events   = [];
    scenario.handlers = [];
    scenario.actions  = [];
    scenario.reducers = [];
    scenario.initialState = {};
  }

  getUserScenarios() {
    return this._registry.getUserScenarios();
  }

  upsertUserScenarios(data) {
    this._registry.upsertUserScenarios(data);
  }

  /**
   * Instantiate the correct scenario class for the current selection.
   *
   * Resolution order:
   *  1. Active scenario carries scenarioClass directly.
   *  2. Active user scenario with a matching scenarioId → use that prebuilt's scenarioClass.
   *  3. Fall back to the first prebuilt's scenarioClass.
   */
  createActiveScenario() {
    const active = this.getActive();
    if (!active) throw new Error('No active scenario');

    const cls =
      active.scenarioClass
      ?? this._registry.get(active.scenarioId)?.scenarioClass
      ?? this._registry.getPrebuiltScenarios()[0]?.scenarioClass;
    if (!cls) throw new Error('No scenario class available');

    return cls.instantiate(
      this._getParams(active),
      new Date(active.simStart),
      new Date(active.simEnd),
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

}

