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
import { ToolsetRegistry }    from './toolsets/toolset-registry.js';
import { ScenarioCompiler }   from './toolsets/scenario-compiler.js';
import { US_BANKING }         from './toolsets/us-banking-toolset.js';
import { US_TAX }             from './toolsets/us-tax-toolset.js';
import { US_RETIREMENT }      from './toolsets/us-retirement-toolset.js';
import { AU_BANKING }         from './toolsets/au-banking-toolset.js';
import { AU_TAX }             from './toolsets/au-tax-toolset.js';
import { AU_RETIREMENT }      from './toolsets/au-retirement-toolset.js';
import { US_AU_CROSS_BORDER } from './toolsets/us-au-cross-border-toolset.js';
import { US_REAL_PROPERTY }   from './toolsets/us-real-property-toolset.js';
import { AU_REAL_PROPERTY }   from './toolsets/au-real-property-toolset.js';
import { US_COLLECTIBLES }    from './toolsets/us-collectibles-toolset.js';
import { US_ROTH_CONVERSION } from './toolsets/us-roth-conversion-toolset.js';
import { US_BROKERAGE }      from './toolsets/us-brokerage-toolset.js';
import { AU_BROKERAGE }      from './toolsets/au-brokerage-toolset.js';
import { US_INCOME }         from './toolsets/us-income-toolset.js';
import { AU_INCOME }         from './toolsets/au-income-toolset.js';

const BUILT_IN_TOOLSETS = [
  US_BANKING, US_TAX, US_RETIREMENT,
  AU_BANKING, AU_TAX, AU_RETIREMENT,
  US_AU_CROSS_BORDER,
  US_REAL_PROPERTY, AU_REAL_PROPERTY,
  US_COLLECTIBLES, US_ROTH_CONVERSION,
  US_BROKERAGE, AU_BROKERAGE, US_INCOME, AU_INCOME,
];

/**
 * ScenarioLoader — single entry point for restoring a scenario configuration
 * into the simulation services.
 *
 * Two-branch dispatch:
 *   - If `cfg` carries a saved graph (events/handlers/actions/reducers),
 *     restore it via ScenarioSerializer.deserializeGraph().
 *   - Otherwise, if `cfg.toolsets` is non-empty, synthesize the graph by
 *     compiling the declarative toolsets.
 *
 * Persons / accounts / real-properties / collectibles are always restored
 * via ScenarioSerializer.deserializePersonsAccounts() before the graph step,
 * so the toolset compiler can read them from the services.
 */
export class ScenarioLoader {
  constructor() {
    this._toolsetRegistry = new ToolsetRegistry();
    for (const t of BUILT_IN_TOOLSETS) this._toolsetRegistry.register(t);
  }

  /**
   * Populate `services` from `cfg`. Caller is responsible for having created
   * the Simulation (via `scenario.buildSim()`) before calling this.
   *
   * Compile branch — runs the toolset compiler, which mutates sim.state. The
   * resulting state is snapshotted into `cfg.initialState` so the next save/load
   * cycle can restore it without re-running the compiler.
   *
   * Deserialize branch — restores the graph from a saved snapshot, then re-hydrates
   * sim.state from `cfg.initialState`. buildSim() can't do this on its own because
   * scenario subclasses (e.g. IntlRetirementScenario) don't thread initialState
   * through their constructor, so sim.state starts empty regardless.
   *
   * @param {object} cfg      - serialized scenario config
   * @param {object} services - ServiceRegistry instance
   */
  load(cfg, services) {
    if (!cfg) return;

    if (cfg.toolsets?.length > 0) {
      // Design 15 §2.5: drift-merge persons/accounts/realProperties/collectibles
      // before deserialization so that schema additions in buildDefaultConfig
      // propagate into existing cfgs. Conservative: only appends entries whose
      // key is absent; never replaces or reorders. Skipped when scenarioClass
      // isn't on the cfg (e.g. raw JSON imports).
      this._driftMergeDomainRecords(cfg);

      // Sync cfg.params (typed UI array) → cfg.parameters (plain key→value the compiler reads)
      // before loading persons/accounts so any param-driven person fields are up to date.
      if (Array.isArray(cfg.params) && cfg.params.length > 0) {
        cfg.parameters = cfg.parameters ?? {};
        for (const p of cfg.params) {
          cfg.parameters[p.name] = (p.type === 'Date' && p.value) ? new Date(p.value) : p.value;
        }
      }

      // Generic param→node cascade: each schema entry with a `node` declaration drives
      // a field update on cfg.persons or cfg.accounts before compilation.
      // Node is read from cfg.params[i].node (serialized alongside the param value) so
      // the mapping survives round-trips without requiring scenarioClass to be present.
      // Only explicitly declared fields are touched; all other person/account fields
      // (e.g. lifeExpectancy, contributionBasis) remain authoritative from their records.
      for (const p of (Array.isArray(cfg.params) ? cfg.params : [])) {
        const node = p.node;
        if (!node) continue;
        const val = cfg.parameters?.[p.name];
        if (val === undefined) continue;

        if (node.type === 'person') {
          const rec = (cfg.persons ?? []).find(r => r.id === node.id);
          if (rec) rec[node.field] = val instanceof Date ? val.toISOString().slice(0, 10) : val;
        } else if (node.type === 'account') {
          const rec = (cfg.accounts ?? []).find(r => r.stateKey === node.stateKey);
          if (rec) rec[node.field] = val;
        }
      }
    }

    ScenarioSerializer.deserializePersonsAccounts(cfg, services);

    const sim = services.simulationRegistry?.getPrimary?.();

    if (cfg.toolsets?.length > 0) {
      const { statePatches } = new ScenarioCompiler(this._toolsetRegistry).compile(cfg, services);
      cfg.initialState = statePatches;

      // Snapshot the compiled graph back to cfg so the config is a complete
      // serialized representation usable by newScenario() and import/export.
      const { eventService, handlerService, reducerService,
              personService, accountService, realPropertyService, collectibleService } = services;
      cfg.events         = (eventService?.getAll()         ?? []).map(n => ScenarioSerializer._serializeEvent(n));
      cfg.handlers       = (handlerService?.getAll()       ?? []).map(n => ScenarioSerializer._serializeHandler(n));
      cfg.actions        = []; // action stubs are re-derived from handler generatedActionTypes at load time
      cfg.reducers       = (reducerService?.getAll()       ?? []).map(n => ScenarioSerializer._serializeReducer(n));
      cfg.persons        = (personService?.getAll()        ?? []).map(n => ScenarioSerializer._serializePerson(n));
      cfg.accounts       = (accountService?.getAll()       ?? []).map(n => ScenarioSerializer._serializeAccount(n));
      cfg.realProperties = (realPropertyService?.getAll()  ?? []).map(n => ScenarioSerializer._serializeRealProperty(n));
      cfg.collectibles   = (collectibleService?.getAll()   ?? []).map(n => ScenarioSerializer._serializeCollectible(n));

      // Normalize params to a typed schema array if the prebuilt hasn't done it yet (old saved cfg).
      const schema = cfg.scenarioClass?.getParamSchema?.() ?? [];
      if (!Array.isArray(cfg.params)) {
        cfg.params = schema.map(s => {
          const entry = { name: s.key, label: s.label, type: s.type, group: s.group, value: s.defaultValue };
          if (s.node) entry.node = s.node;
          return entry;
        });
      } else if (schema.length > 0) {
        // Schema-drift guard: merge any schema entries missing from cfg.params so new
        // params added to the schema propagate to existing saved scenarios with their defaults.
        const existing = new Set(cfg.params.map(p => p.name));
        for (const s of schema) {
          if (!existing.has(s.key)) {
            const entry = { name: s.key, label: s.label, type: s.type, group: s.group, value: s.defaultValue };
            if (s.node) entry.node = s.node;
            cfg.params.push(entry);
          }
        }
      }
    } else if (ScenarioSerializer.hasSerializedGraph(cfg)) {
      // Fallback for manually-built scenarios that have no toolset declaration.
      ScenarioSerializer.deserializeGraph(cfg, services);
      if (sim && cfg.initialState && Object.keys(cfg.initialState).length > 0) {
        Object.assign(sim.state, _cloneState(cfg.initialState));
      }
    }
  }

  /**
   * Drift-merge domain records (persons / accounts / realProperties / collectibles)
   * from cfg.scenarioClass.buildDefaultConfig() into cfg. Append-only: a default
   * entry is added when its key (id for persons, stateKey for the others) is
   * absent from cfg. Never replaces, removes, or reorders existing entries —
   * if a user deleted a default account, drift merge will NOT re-add it
   * (presence is keyed by stateKey, so renames also count as new entries).
   *
   * No-op when cfg has no scenarioClass (raw JSON imports without class metadata).
   * @private
   */
  _driftMergeDomainRecords(cfg) {
    const ScenarioCls = cfg.scenarioClass;
    if (typeof ScenarioCls?.buildDefaultConfig !== 'function') return;

    const schema = ScenarioCls.getParamSchema?.() ?? [];
    const defaultParams = Object.fromEntries(schema.map(s => [s.key, s.defaultValue]));
    let defaults;
    try {
      defaults = ScenarioCls.buildDefaultConfig(defaultParams, cfg.simStart, cfg.simEnd);
    } catch {
      return;
    }
    if (!defaults) return;

    const append = (cfgList, defaultList, keyFn) => {
      if (!Array.isArray(defaultList) || defaultList.length === 0) return cfgList;
      const out = Array.isArray(cfgList) ? cfgList : [];
      const present = new Set(out.map(keyFn).filter(k => k != null));
      for (const def of defaultList) {
        const k = keyFn(def);
        if (k == null || present.has(k)) continue;
        out.push(structuredClone(def));
        present.add(k);
      }
      return out;
    };

    cfg.persons        = append(cfg.persons,        defaults.persons,        r => r.id);
    cfg.accounts       = append(cfg.accounts,       defaults.accounts,       r => r.stateKey);
    cfg.realProperties = append(cfg.realProperties, defaults.realProperties, r => r.stateKey);
    cfg.collectibles   = append(cfg.collectibles,   defaults.collectibles,   r => r.stateKey);
  }
}

/**
 * Deep-clone the simulation state. structuredClone preserves Date objects
 * (which the people map carries) but falls back to JSON-clone for any state
 * that contains class instances structuredClone can't handle.
 */
function _cloneState(state) {
  try {
    return structuredClone(state);
  } catch {
    return JSON.parse(JSON.stringify(state));
  }
}
