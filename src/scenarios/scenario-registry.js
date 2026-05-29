/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { ScenarioSerializer } from './scenario-serializer.js';

/**
 * Storage to track and manage Scenarios, including the current active one.
 *
 * ### Date representation
 *
 * Every registry entry's `simStart` / `simEnd` is a **full ISO 8601 string**
 * (e.g. `'2026-01-01T00:00:00.000Z'`), regardless of where it came from
 * (prebuilt descriptor with a `Date`, JSON-deserialized user scenario,
 * uploaded JSON file). This is the single canonical representation; conversion
 * to `Date` happens only when the scenario instance is constructed for the
 * Simulation, and to `YYYY-MM-DD` only when populating UI inputs.
 *
 * ID scheme:
 *   'p:<id>'  — prebuilt scenario (e.g. 'p:intl-retirement')
 *   'u:<N>'   — user-saved scenario at index N
 */
export class ScenarioRegistry {
  constructor(scenarioStorage) {
    this._scenarioStorage = scenarioStorage;
    this._scenarios = new Map();
    this._scenarioData = {};
    this._init();
  }

  /**
   * Load user scenarios from storage and assign u:<N> IDs.
   * If lastUsed refers to a user scenario, mark it active immediately.
   * Storage round-trips simStart/simEnd as strings already, but older payloads
   * may have truncated dates — re-canonicalize through ScenarioSerializer.toDateStr.
   */
  _init() {
    this._scenarioData = this._scenarioStorage.load();
    this._scenarioData.scenarios.forEach((s, i) => {
      s.id = 'u:' + i;
      s.prebuilt = false;
      s.simStart = ScenarioSerializer.toDateStr(s.simStart);
      s.simEnd   = ScenarioSerializer.toDateStr(s.simEnd);
      this._scenarios.set(s.id, s);
    });
    const lastUsed = this._scenarioData.lastUsed;
    if (lastUsed?.startsWith('u:') && this._scenarios.has(lastUsed)) {
      this._scenarios.get(lastUsed).active = true;
    }
  }

  /**
   * Load prebuilt scenarios from class entries, storing them under 'p:<id>' keys.
   *
   * Each entry: { cls, order, active, simStart, simEnd }
   * where cls is the scenario subclass with static scenarioId(), scenarioName(),
   * getParamSchema(), buildDefaultConfig(), and instantiate().
   *
   * After adding all prebuilts, sets the active scenario if not already set:
   *   1. lastUsed from storage (if it maps to a loaded prebuilt)
   *   2. The prebuilt with active: true (designated by the caller)
   *   3. The first prebuilt by order
   */
  loadPrebuilt(entries = []) {
    const active = this.getActive();
    entries.forEach(({ cls, order, active: entryActive, simStart, simEnd }) => {
      const id = 'p:' + cls.scenarioId();
      // Preserve existing entries so param edits survive Rebuild.
      if (this._scenarios.has(id)) return;
      const schema = cls.getParamSchema?.() ?? [];
      // Keep this entry shape in sync with ScenarioLoader._toEntry — both produce
      // cfg.params records that the UI consumes (label, group, description for
      // tooltips, node for the param→field cascade). Toolset-owned params are
      // appended by the loader on first compile.
      const params = schema.map(s => {
        const entry = { name: s.key, label: s.label, type: s.type, group: s.group };
        if (s.defaultValue !== undefined) entry.value = s.defaultValue;
        if (s.description) entry.description = s.description;
        if (s.node) entry.node = s.node;
        return entry;
      });
      // Canonicalize prebuilt sim window to ISO strings up-front so the registry
      // entry matches the storage / JSON / serialized representation.
      const simStartStr = ScenarioSerializer.toDateStr(simStart);
      const simEndStr   = ScenarioSerializer.toDateStr(simEnd);
      // Design 15 §2.1: materialize buildDefaultConfig once at registration so the
      // registry entry carries persons/accounts/realProperties/collectibles/toolsets
      // up-front. Subsequent Rebuilds read straight from the entry — defaults never
      // fire again unless explicitly requested via resetToDefaults.
      const defaultParams = Object.fromEntries(schema.map(s => [s.key, s.defaultValue]));
      const defaultCfg = cls.buildDefaultConfig?.(defaultParams, simStartStr, simEndStr) ?? {};
      // If another scenario is already active, force active:false so the prebuilt's
      // active:true flag doesn't create two active scenarios.
      const pbActive = active ? false : entryActive;
      this._scenarios.set(id, {
        id,
        name:          cls.scenarioName(),
        order,
        prebuilt:      true,
        active:        pbActive,
        simStart:      simStartStr,
        simEnd:        simEndStr,
        params,
        initialState:  {},
        scenarioClass: cls,
        ...defaultCfg,
      });
    });

    if (active) return;

    const lastUsed = this._scenarioData.lastUsed;
    if (lastUsed?.startsWith('p:') && this._scenarios.has(lastUsed)) {
      this.save(this._scenarios.get(lastUsed), true);
      return;
    }
    const prebuilts = this.getPrebuiltScenarios();
    const defaultActive = prebuilts.find(p => p.active) ?? prebuilts[0];
    if (defaultActive) this.save(defaultActive, true);
  }

  /**
   * Get all scenarios ordered by order (ascending).
   */
  getAll() {
    return [...this._scenarios.values()].sort((a, b) => a.order - b.order);
  }

  get(id) {
    return this._scenarios.get(id);
  }

  /**
   * Save a scenario. When active=true, marks it as the sole active scenario
   * and persists lastUsed. When active=false, just updates storage.
   */
  save(scenario, active) {
    if (active) {
      this._scenarios.forEach(s => { s.active = false; });
      scenario.active = true;
      this._scenarios.set(scenario.id, scenario);
      this._persistUserScenarios();
      this._persistLastUsed(scenario.id);
    } else {
      scenario.active = false;
      this._scenarios.set(scenario.id, scenario);
      this._persistUserScenarios();
    }
  }

  /**
   * Delete a scenario by id. Falls back to getAll()[0] as the new active.
   */
  delete(id) {
    this._scenarios.delete(id);
    const newActive = this.getAll()[0];
    if (newActive) this.save(newActive, true);
    return this.getActive();
  }

  /**
   * Set the scenario with the given id as the sole active one.
   */
  setActiveById(id) {
    const s = this._scenarios.get(id);
    if (s) this.save(s, true);
  }

  getActive() {
    return this.getAll().find(s => s.active);
  }

  getPrebuiltScenarios() {
    return [...this._scenarios.values()]
      .filter(s => s.prebuilt === true)
      .sort((a, b) => a.order - b.order);
  }

  getUserScenarios() {
    return [...this._scenarios.values()]
      .filter(s => s.prebuilt === false)
      .sort((a, b) => a.order - b.order);
  }

  getNextUserScenarioId() {
    return this.getUserScenarios().length;
  }

  replaceUserScenarios(data) {
    [...this._scenarios.keys()].filter(k => k.startsWith('u:')).forEach(k => this._scenarios.delete(k));
    let firstId  = null;
    let activeId = null;
    if (Array.isArray(data.scenarios)) {
      data.scenarios.forEach((s, i) => {
        s.id      = 'u:' + i;
        s.prebuilt = false;
        s.simStart = ScenarioSerializer.toDateStr(s.simStart);
        s.simEnd   = ScenarioSerializer.toDateStr(s.simEnd);
        if (i === 0)  firstId  = s.id;
        if (s.active) activeId = s.id;
        this._scenarios.set(s.id, s);
      });
    }
    const targetId = activeId ?? firstId;
    if (targetId) {
      this._scenarios.forEach(s => { s.active = false; });
      this._scenarios.get(targetId).active = true;
      this._persistLastUsed(targetId);
    }
    this._persistUserScenarios();
  }

  _persistLastUsed(id) {
    this._scenarioData.lastUsed = id;
    this._scenarioStorage.save(this._scenarioData);
  }

  _persistUserScenarios() {
    this._scenarioData.scenarios = this.getUserScenarios();
    this._scenarioStorage.save(this._scenarioData);
  }
}
