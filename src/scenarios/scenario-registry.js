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
 * Scenario entries live in the shared Graph under layer:'scenario' so they
 * survive ServiceRegistry.reset() (design/17-scenario-as-graph-node.md §3.6).
 *
 * ### Date representation
 *
 * Every registry entry's `simStart` / `simEnd` is a **full ISO 8601 string**
 * (e.g. `'2026-01-01T00:00:00.000Z'`), regardless of where it came from
 * (prebuilt descriptor with a `Date`, JSON-deserialized user scenario,
 * uploaded JSON file). Conversion to `Date` happens only when the scenario
 * instance is constructed for the Simulation.
 *
 * ID scheme:
 *   'p:<id>'  — prebuilt scenario (e.g. 'p:intl-retirement')
 *   'u:<N>'   — user-saved scenario at index N
 */
export class ScenarioRegistry {
  constructor(scenarioStorage, graph) {
    this._scenarioStorage = scenarioStorage;
    this._graph           = graph;
    this._scenarioData    = {};
    this._init();
  }

  /**
   * Load user scenarios from storage.
   * Preserves the stored u:<N> id if present; only assigns a new index-based id
   * for legacy records that have no id yet.
   * If lastUsed refers to a user scenario, mark it active immediately.
   * Storage round-trips simStart/simEnd as strings already, but older payloads
   * may have truncated dates — re-canonicalize through ScenarioSerializer.toDateStr.
   */
  _init() {
    this._scenarioData = this._scenarioStorage.load();
    // One-time cleanup (design/39 Step 5c): early MPC builds wrote decision records
    // into the scenario layer, so they leaked into `fin-sim-scenarios` storage and
    // got re-stamped to u:<N> on reload — un-loadable junk in the picker. Decision
    // records now live in their own `decision` layer and never touch this storage;
    // purge any already-persisted ones (mpc:-origin id or derived flag) and re-save.
    const cleaned = this._scenarioData.scenarios.filter(
      s => !(s?.derived || (typeof s?.id === 'string' && s.id.startsWith('mpc:'))),
    );
    if (cleaned.length !== this._scenarioData.scenarios.length) {
      this._scenarioData.scenarios = cleaned;
      this._scenarioStorage.save(this._scenarioData);
    }
    this._scenarioData.scenarios.forEach((s, i) => {
      if (!s.id || !s.id.startsWith('u:')) s.id = 'u:' + i;
      s.prebuilt = false;
      s.layer   = 'scenario';
      s.simStart = ScenarioSerializer.toDateStr(s.simStart);
      s.simEnd   = ScenarioSerializer.toDateStr(s.simEnd);
      this._graph.addNode(s);
    });
    const lastUsed = this._scenarioData.lastUsed;
    if (lastUsed?.startsWith('u:') && this._graph.getNode(lastUsed)) {
      this._graph.getNode(lastUsed).active = true;
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
      if (this._graph.getNode(id)) return;
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
      this._graph.addNode({
        id,
        layer:         'scenario',
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
    if (lastUsed?.startsWith('p:') && this._graph.getNode(lastUsed)) {
      this.save(this._graph.getNode(lastUsed), true);
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
    return this._byLayer().sort((a, b) => a.order - b.order);
  }

  get(id) {
    const node = this._graph.getNode(id);
    return node?.layer === 'scenario' ? node : undefined;
  }

  /**
   * Save a scenario. When active=true, marks it as the sole active scenario
   * and persists lastUsed. When active=false, just updates storage.
   */
  save(scenario, active) {
    scenario.layer = 'scenario';
    if (active) {
      this._byLayer().forEach(s => { s.active = false; });
      scenario.active = true;
      this._upsert(scenario);
      this._persistUserScenarios();
      this._persistLastUsed(scenario.id);
    } else {
      scenario.active = false;
      this._upsert(scenario);
      this._persistUserScenarios();
    }
  }

  /**
   * Delete a scenario by id. Falls back to getAll()[0] as the new active.
   */
  delete(id) {
    this._graph.removeNode(id);
    const newActive = this.getAll()[0];
    if (newActive) this.save(newActive, true);
    return this.getActive();
  }

  /**
   * Set the scenario with the given id as the sole active one.
   */
  setActiveById(id) {
    const s = this.get(id);
    if (s) this.save(s, true);
  }

  getActive() {
    return this.getAll().find(s => s.active);
  }

  getPrebuiltScenarios() {
    return this._byLayer()
      .filter(s => s.prebuilt === true)
      .sort((a, b) => a.order - b.order);
  }

  getUserScenarios() {
    return this._byLayer()
      .filter(s => s.prebuilt === false)
      .sort((a, b) => a.order - b.order);
  }

  getNextUserScenarioId() {
    return this.getUserScenarios().length;
  }

  /**
   * Upsert user scenarios from uploaded JSON data.
   * Scenarios whose id matches an existing u:<N> node are updated in-place.
   * Scenarios with no id (or a non-u: id) are assigned a fresh id that avoids
   * collisions with all currently-loaded user scenarios.
   * Existing user scenarios that are NOT present in the upload are preserved.
   * Active state changes only when an uploaded scenario carries active:true.
   */
  upsertUserScenarios(data) {
    if (!Array.isArray(data.scenarios)) return;

    // Find next available index beyond all current u:<N> ids.
    const existingIndices = this._byLayer()
      .filter(n => n.id?.startsWith('u:'))
      .map(n => parseInt(n.id.slice(2), 10))
      .filter(n => !isNaN(n));
    let nextIndex = existingIndices.length > 0 ? Math.max(...existingIndices) + 1 : 0;

    let activeId = null;
    data.scenarios.forEach(s => {
      s.prebuilt = false;
      s.layer    = 'scenario';
      s.simStart = ScenarioSerializer.toDateStr(s.simStart);
      s.simEnd   = ScenarioSerializer.toDateStr(s.simEnd);
      if (!s.id || !s.id.startsWith('u:')) s.id = 'u:' + nextIndex++;
      if (s.active) activeId = s.id;
      this._upsert(s);
    });

    if (activeId && this._graph.getNode(activeId)) {
      this._byLayer().forEach(s => { s.active = false; });
      this._graph.getNode(activeId).active = true;
      this._persistLastUsed(activeId);
    }
    this._persistUserScenarios();
  }

  // ─── Private ────────────────────────────────────────────────────────────────

  _byLayer() {
    return this._graph.byLayer('scenario');
  }

  _upsert(scenario) {
    if (this._graph.getNode(scenario.id)) {
      this._graph.updateNode(scenario.id, scenario);
    } else {
      this._graph.addNode(scenario);
    }
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
