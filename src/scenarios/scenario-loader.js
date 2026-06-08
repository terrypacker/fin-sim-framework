/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { ScenarioSerializer }     from './scenario-serializer.js';
import { ToolsetRegistry }         from './toolsets/toolset-registry.js';
import { ScenarioCompiler }        from './toolsets/scenario-compiler.js';
import { IntlRetirementScenario }  from './intl-retirement-scenario.js';
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
import { ECONOMIC_REGIMES }  from './toolsets/economic-regimes-toolset.js';

const SCENARIO_CLASS_BY_ID = new Map([
  [IntlRetirementScenario.scenarioId(), IntlRetirementScenario],
]);

const BUILT_IN_TOOLSETS = [
  US_BANKING, US_TAX, US_RETIREMENT,
  AU_BANKING, AU_TAX, AU_RETIREMENT,
  US_AU_CROSS_BORDER,
  US_REAL_PROPERTY, AU_REAL_PROPERTY,
  US_COLLECTIBLES, US_ROTH_CONVERSION,
  US_BROKERAGE, AU_BROKERAGE, US_INCOME, AU_INCOME,
  ECONOMIC_REGIMES,
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

    // Resolve scenarioId string → class so that _driftMergeDomainRecords and
    // _mergeParamSchema can apply scenario-level schema even for re-imported JSONs
    // (serializeScenario writes a string id; the class reference isn't serializable).
    if (cfg.scenarioId && !cfg.scenarioClass) {
      // Handle both bare class IDs ('intl-retirement') and prefixed prebuilt IDs
      // ('p:intl-retirement') — the latter is what newScenario() stores when copying
      // a prebuilt, and what gets preserved when a user scenario is copied again.
      const rawId = cfg.scenarioId.startsWith('p:') ? cfg.scenarioId.slice(2) : cfg.scenarioId;
      cfg.scenarioClass = SCENARIO_CLASS_BY_ID.get(rawId) ?? SCENARIO_CLASS_BY_ID.get(cfg.scenarioId) ?? null;
    }

    if (cfg.toolsets?.length > 0) {
      this._driftMergeDomainRecords(cfg);
      this._normalizeParams(cfg);
    }

    ScenarioSerializer.deserializePersonsAccounts(cfg, services);

    if (cfg.toolsets?.length > 0) {
      this._compileFromToolsets(cfg, services);
    } else if (ScenarioSerializer.hasSerializedGraph(cfg)) {
      this._restoreFromGraph(cfg, services);
    }
  }

  /**
   * Sync cfg.params → cfg.parameters and cascade param values onto person/account
   * records via each param's optional `node` declaration.
   *
   * Must run before deserializePersonsAccounts so that param-driven person fields
   * (e.g. birthDate, monthlyWage) are up to date when the service reads the records.
   * @private
   */
  _normalizeParams(cfg) {
    // Sync cfg.params (typed UI array) → cfg.parameters (plain key→value the compiler reads).
    if (Array.isArray(cfg.params) && cfg.params.length > 0) {
      cfg.parameters = cfg.parameters ?? {};
      for (const p of cfg.params) {
        cfg.parameters[p.name] = (p.type === 'Date' && p.value) ? new Date(p.value) : p.value;
      }
    }

    // Fallback node-lookup from scenario class schemas. Configs saved before the
    // `node` declaration was introduced for a given param won't have it on the stored
    // entry. The scenario schema is the ground truth; using it here means the cascade
    // works on the first Rebuild of an old config, before _mergeParamSchema (which
    // runs after compilation) has had a chance to backfill.
    //
    // When cfg.scenarioClass is unresolved (e.g. user-created scenarios whose
    // scenarioId is a user-generated "u:N" ID rather than the class ID
    // "intl-retirement"), fall back to ALL registered scenario classes so that
    // params like usHouseSaleYear still cascade correctly.
    const schemaNodeByKey = new Map();
    const schemasToSearch = cfg.scenarioClass
      ? [cfg.scenarioClass]
      : [...SCENARIO_CLASS_BY_ID.values()];
    for (const cls of schemasToSearch) {
      for (const s of (cls?.getParamSchema?.() ?? [])) {
        if (s.node && !schemaNodeByKey.has(s.key)) schemaNodeByKey.set(s.key, s.node);
      }
    }

    // Generic param→node cascade: each schema entry with a `node` declaration drives
    // a field update on cfg.persons, cfg.accounts, or cfg.realProperties before
    // compilation. Node is read from cfg.params[i].node (serialized alongside the
    // param value), falling back to the scenario schema for older configs.
    // Only explicitly declared fields are touched; all other fields remain
    // authoritative from their records.
    for (const p of (Array.isArray(cfg.params) ? cfg.params : [])) {
      const node = p.node ?? schemaNodeByKey.get(p.name);
      if (!node) continue;
      const val = cfg.parameters?.[p.name];
      if (val === undefined) continue;

      if (node.type === 'person') {
        const rec = (cfg.persons ?? []).find(r => r.id === node.id);
        // Design 15: canonicalize Date values to full ISO strings so the
        // cascaded field matches the serialized representation everywhere.
        if (rec) rec[node.field] = val instanceof Date ? val.toISOString() : val;
      } else if (node.type === 'account') {
        const rec = (cfg.accounts ?? []).find(r => r.stateKey === node.stateKey);
        if (rec) rec[node.field] = val;
      } else if (node.type === 'realProperty') {
        const rec = (cfg.realProperties ?? []).find(r => r.stateKey === node.stateKey);
        if (rec) rec[node.field] = val != null ? Math.round(val) : val;
      }
    }
  }

  /**
   * Compile the toolset declarations into the services, then snapshot the
   * resulting graph back onto cfg and normalize cfg.params against the combined
   * scenario + toolset param schema.
   * @private
   */
  _compileFromToolsets(cfg, services) {
    const { paramSchema: toolsetParamSchema, statePatches } =
      new ScenarioCompiler(this._toolsetRegistry).compile(cfg, services);
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

    this._mergeParamSchema(cfg, toolsetParamSchema);
  }

  /**
   * Merge the combined scenario + toolset param schema into cfg.params.
   *
   * Three cases:
   *   - cfg.params absent → build from scratch using schema defaults.
   *   - cfg.params present → backfill missing metadata fields (schema drift) and
   *     append any schema keys not yet in cfg.params.
   *   - No schema entries → no-op.
   *
   * Scenario-class entries win on key collisions (richer labels/groups, node
   * declarations). Within toolset entries the first occurrence wins so that
   * shared keys (e.g. monthlyExpenses in both US_RETIREMENT and AU_RETIREMENT)
   * don't create duplicates that would corrupt the params→parameters sync loop.
   * @private
   */
  _mergeParamSchema(cfg, toolsetParamSchema) {
    const scenarioSchema = cfg.scenarioClass?.getParamSchema?.() ?? [];
    const scenarioKeys   = new Set(scenarioSchema.map(s => s.key));
    const toolsetEntries = [];
    const seenToolsetKeys = new Set();
    for (const t of (toolsetParamSchema ?? [])) {
      if (scenarioKeys.has(t.key) || seenToolsetKeys.has(t.key)) continue;
      seenToolsetKeys.add(t.key);
      toolsetEntries.push(t);
    }
    const combinedSchema = [...scenarioSchema, ...toolsetEntries];
    if (combinedSchema.length === 0) return;

    // Seed entry.value from cfg.parameters when it carries an explicit value
    // (e.g. set by buildDefaultConfig or a JSON import). Otherwise fall back
    // to the schema's defaultValue. This keeps the UI representation aligned
    // with the value the compiler actually used.
    //
    // Omit the `value` key entirely when both sources are undefined — some
    // structured-clone implementations (notably jsdom's) drop undefined props,
    // which would otherwise make active.params and structuredClone(active.params)
    // unequal.
    const _toEntry = s => {
      const v = cfg.parameters?.[s.key];
      const value = v !== undefined ? v : s.defaultValue;
      const entry = { name: s.key, label: s.label, type: s.type, group: s.group };
      if (value !== undefined) entry.value = value;
      if (s.description) entry.description = s.description;
      if (s.node)        entry.node        = s.node;
      if (s.options)     entry.options     = s.options;
      if (s.hidden)      entry.hidden      = s.hidden;
      return entry;
    };

    if (!Array.isArray(cfg.params)) {
      cfg.params = combinedSchema.map(_toEntry);
      return;
    }

    // Schema-drift guard:
    //   - Backfill any metadata fields (label, group, type, description, node)
    //     that are missing on existing cfg.params entries. This lets scenarios
    //     saved before a metadata field was introduced (e.g. description for
    //     UI tooltips) pick it up on the next load without losing user values.
    //   - Append schema entries whose key isn't yet in cfg.params with the
    //     schema's defaults.
    const schemaByKey = new Map(combinedSchema.map(s => [s.key, s]));
    for (const p of cfg.params) {
      const s = schemaByKey.get(p.name);
      if (!s) continue;
      if (p.label       === undefined && s.label)            p.label       = s.label;
      if (p.group       === undefined && s.group)            p.group       = s.group;
      if (p.type        === undefined && s.type)             p.type        = s.type;
      if (p.description === undefined && s.description)     p.description = s.description;
      if (p.node        === undefined && s.node)             p.node        = s.node;
      if (p.options     === undefined && s.options)          p.options     = s.options;
      if (p.value       === undefined && s.defaultValue !== undefined) p.value = s.defaultValue;
    }
    const existing = new Set(cfg.params.map(p => p.name));
    for (const s of combinedSchema) {
      if (!existing.has(s.key)) cfg.params.push(_toEntry(s));
    }
  }

  /**
   * Restore a manually-built or previously-compiled scenario from its serialized
   * graph snapshot, then rehydrate sim.state from cfg.initialState.
   * @private
   */
  _restoreFromGraph(cfg, services) {
    ScenarioSerializer.deserializeGraph(cfg, services);
    const sim = services.simulationRegistry?.getPrimary?.();
    if (sim && cfg.initialState && Object.keys(cfg.initialState).length > 0) {
      Object.assign(sim.state, _cloneState(cfg.initialState));
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
