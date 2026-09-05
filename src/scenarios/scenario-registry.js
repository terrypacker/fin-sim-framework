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
    /**
     * The active scenario id, as persisted. A plain string — deliberately NOT a
     * retained copy of the storage document. See _persist().
     * @type {string|null}
     */
    this._lastUsed        = null;
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
    const data = this._scenarioStorage.load();
    this._lastUsed = data.lastUsed ?? null;
    // One-time cleanup (design/39 Step 5c): early MPC builds wrote decision records
    // into the scenario layer, so they leaked into `fin-sim-scenarios` storage and
    // got re-stamped to u:<N> on reload — un-loadable junk in the picker. Decision
    // records now live in their own `decision` layer and never touch this storage;
    // purge any already-persisted ones (mpc:-origin id or derived flag) and re-save.
    const cleaned = data.scenarios.filter(
      s => !(s?.derived || (typeof s?.id === 'string' && s.id.startsWith('mpc:'))),
    );
    if (cleaned.length !== data.scenarios.length) {
      // Writes `cleaned` directly, NOT via _persist(): the graph has no scenario
      // nodes yet, so _persist() would read back an empty list and erase the file.
      this._scenarioStorage.save({
        scenarios: cleaned,
        ...(this._lastUsed ? { lastUsed: this._lastUsed } : {}),
      });
    }
    cleaned.forEach((s, i) => {
      if (!s.id || !s.id.startsWith('u:')) s.id = 'u:' + i;
      s.prebuilt = false;
      s.layer   = 'scenario';
      s.simStart = ScenarioSerializer.toDateStr(s.simStart);
      s.simEnd   = ScenarioSerializer.toDateStr(s.simEnd);
      this._graph.addNode(s);
    });
    const lastUsed = this._lastUsed;
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

    const lastUsed = this._lastUsed;
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
   * The PERSISTED copy of a scenario, re-read from storage — NOT the live graph node.
   *
   * `get()` returns the node the editors mutate in place, so it can never answer "what
   * would a reload load?". The recovery overlay has to ask exactly that: a scenario broken
   * by in-flight edits that were never saved is repaired by discarding them, and a
   * scenario broken in storage is not. The two look identical from the live record alone.
   *
   * @param {string} id
   * @returns {object|null} the stored record, or null for a prebuilt (never persisted
   *          until saved) and for an id storage has never seen
   */
  getStored(id) {
    const data = this._scenarioStorage.load();
    return (data?.scenarios ?? []).find(s => s?.id === id) ?? null;
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

  /**
   * The next free `u:<N>` index — one past the highest in use.
   *
   * NOT the count. User ids are not dense: a delete leaves a hole, and an upload can
   * land ids of its own, so `u:1, u:2, u:4, u:7` is an ordinary state. Returning the
   * count (4 here) hands back an id that already exists, and `_upsert` then UPDATES
   * that scenario instead of adding one — Copy silently overwrote the scenario it was
   * copying, renaming it "New Scenario" and taking its config with it.
   */
  getNextUserScenarioId() {
    const used = this._byLayer()
      .filter(n => typeof n.id === 'string' && n.id.startsWith('u:'))
      .map(n => Number.parseInt(n.id.slice(2), 10))
      .filter(n => Number.isInteger(n));
    return used.length ? Math.max(...used) + 1 : 0;
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

    // One id rule for every path that mints one: an id that collides is an overwrite.
    let nextIndex = this.getNextUserScenarioId();

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
    this._lastUsed = id;
    this._persist();
  }

  _persistUserScenarios() {
    this._persist();
  }

  /**
   * Write the current user scenarios and active id to storage.
   *
   * The payload is built fresh per call and **not retained**. This class used to
   * keep it in a `_scenarioData` field whose `.scenarios` held the live graph
   * nodes from the previous save — nodes `Graph.updateNode` may since have
   * replaced, so the retained document could go stale as well as alias.
   *
   * Note what this does NOT do: the array still holds live node references for
   * the duration of the call. `ScenarioStorage.save()`'s `JSON.stringify` is
   * still the moment the snapshot is taken, and that is the right place for it —
   * a deep copy here would only duplicate the serialization the store performs
   * immediately afterwards. (`structuredClone` is not an option regardless: live
   * scenario nodes carry a `scenarioClass` function, which JSON drops silently
   * and structured clone rejects with DataCloneError.)
   *
   * So the contract is: the caller may hand `save()` live objects, and `save()`
   * must snapshot them before returning. The complementary half is
   * `ScenarioStorage.load()` returning a fresh copy — `_init` mutates what it
   * loads and installs it as graph nodes. Both halves are documented on those
   * methods; a backend that stored objects rather than strings would break them.
   */
  _persist() {
    this._scenarioStorage.save({
      scenarios: this.getUserScenarios(),
      // Omitted rather than written as null when unset, so a profile that has
      // never selected a scenario stores exactly what it always did.
      ...(this._lastUsed ? { lastUsed: this._lastUsed } : {}),
    });
  }
}
