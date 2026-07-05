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
import { rescaleHoldingsToBalance } from '../finance/holdings/holding-utils.js';
import { ToolsetRegistry }         from './toolsets/toolset-registry.js';
import { ScenarioCompiler }        from './toolsets/scenario-compiler.js';
import { IntlRetirementScenario }  from './intl-retirement-scenario.js';
import { US_BANKING }         from './toolsets/us-banking-toolset.js';
import { US_TAX }             from './toolsets/us-tax-toolset.js';
import { US_STATE_TAX }       from './toolsets/us-state-tax-toolset.js';
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
import { normalizeCountryCode } from '../finance/country-codes.js';

const SCENARIO_CLASS_BY_ID = new Map([
  [IntlRetirementScenario.scenarioId(), IntlRetirementScenario],
]);

const BUILT_IN_TOOLSETS = [
  US_BANKING, US_TAX, US_STATE_TAX, US_RETIREMENT,
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

    // Stamp display-format currency codes for every account/asset/person and
    // free-standing money param (design 10 §Phase 3/4/5) here — after
    // persons/accounts are registered but before the compile-vs-deserialize
    // fork — so codes exist on BOTH load paths. (The deserialize path does not
    // run the toolset compiler.)
    this._registerDisplayCurrencies(cfg, services);

    if (cfg.toolsets?.length > 0) {
      this._compileFromToolsets(cfg, services);
    } else if (ScenarioSerializer.hasSerializedGraph(cfg)) {
      this._restoreFromGraph(cfg, services);
    }
  }

  /**
   * Register each account/asset/person native currency code, plus any
   * free-standing money param's currency, with the schema registry so the
   * display layer can convert money fields (design 10 §Phase 4/5). Runs on
   * both the compile and deserialize paths.
   * @private
   */
  _registerDisplayCurrencies(cfg, services) {
    const reg = services.schemaRegistry;
    if (!reg) return;
    for (const a of services.accountService?.getAll() ?? []) {
      if (a.stateKey) reg.registerAccount(a.stateKey, a);
    }
    for (const p of services.realPropertyService?.getAll() ?? []) {
      if (p.stateKey) reg.registerAsset(p.stateKey, p);
    }
    for (const c of services.collectibleService?.getAll() ?? []) {
      if (c.stateKey) reg.registerAsset(c.stateKey, c);
    }
    // Per-person income currency (monthlyWage / socialSecurityMonthly).
    for (const person of services.personService?.getAll() ?? []) {
      reg.registerPerson(person);
    }
    // Free-standing money params (e.g. monthlyExpenses) stamp the state paths
    // they own with the currency chosen in the param editor.
    for (const p of (Array.isArray(cfg?.params) ? cfg.params : [])) {
      if (p?.type === 'Money' && Array.isArray(p.currencyStateKeys)) {
        reg.registerCurrencyPaths(p.currencyStateKeys, p.currency ?? p.defaultCurrency);
      }
    }
  }

  /**
   * Back-compat shim: rewrite legacy country-code spellings ('AUS'→'AU', 'USA'→'US')
   * on persisted scenarios to the canonical ISO-3166-1 alpha-2 form (design 20 §10.2).
   * Covers the country-coded fields that ride on a saved cfg: person residency/citizen
   * records and the `startingResidency` parameter (both the flat map and the typed
   * params array). Can be removed once local dev caches predating the rename are gone.
   * @private
   */
  _normalizeCountryCodes(cfg) {
    for (const rec of (cfg.persons ?? [])) {
      if (rec.residency != null) rec.residency = normalizeCountryCode(rec.residency);
      if (Array.isArray(rec.citizen)) rec.citizen = rec.citizen.map(normalizeCountryCode);
    }
    if (cfg.parameters?.startingResidency != null) {
      cfg.parameters.startingResidency = normalizeCountryCode(cfg.parameters.startingResidency);
    }
    for (const p of (Array.isArray(cfg.params) ? cfg.params : [])) {
      if (p?.name === 'startingResidency' && p.value != null) {
        p.value = normalizeCountryCode(p.value);
      }
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
    this._normalizeCountryCodes(cfg);

    // Sync cfg.params (typed UI array) → cfg.parameters (plain key→value the compiler reads).
    if (Array.isArray(cfg.params) && cfg.params.length > 0) {
      cfg.parameters = cfg.parameters ?? {};
      for (const p of cfg.params) {
        cfg.parameters[p.name] = (p.type === 'Date' && p.value) ? new Date(p.value) : p.value;
        // Money params keep a numeric value (the compiler reads it as-is); their
        // currency rides alongside on the param entry. Default it when absent so
        // older configs (saved before Phase 5) acquire the schema's currency.
        if (p.type === 'Money') {
          if (p.currency == null && p.defaultCurrency != null) {
            p.currency = p.defaultCurrency;
          }
          // Expose the chosen native currency to the compiler/toolsets under a
          // sibling `<key>Currency` key, since cfg.parameters is a flat number
          // map that otherwise drops it. Handlers that debit a Money figure
          // (expenses, healthcare) convert it into the target account currency.
          cfg.parameters[`${p.name}Currency`] = p.currency ?? p.defaultCurrency ?? null;
        }
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
    // compilation. Only explicitly declared fields are touched; all other fields
    // remain authoritative from their records.
    //
    // Values can arrive two ways and we honor both so node params apply regardless
    // of how the cfg was assembled:
    //   1. The typed cfg.params array (the UI / round-tripped path) — node read from
    //      the entry, falling back to the scenario schema for older configs.
    //   2. cfg.parameters only (the flat map) — e.g. templates from
    //      buildDefaultConfig() that never materialized a params array, as used by
    //      the optimizer's cfgTemplate fallback and library consumers. These are
    //      caught by a second pass over the schema's node list.
    const appliedKeys = new Set();
    for (const p of (Array.isArray(cfg.params) ? cfg.params : [])) {
      const node = p.node ?? schemaNodeByKey.get(p.name);
      if (!node) continue;
      const val = cfg.parameters?.[p.name];
      if (val === undefined) continue;
      this._applyParamNode(cfg, node, val);
      appliedKeys.add(p.name);
    }

    // Second pass: schema-declared nodes whose value is present only in the flat
    // cfg.parameters map (no typed array entry). Skips keys already handled above.
    for (const [key, node] of schemaNodeByKey) {
      if (appliedKeys.has(key)) continue;
      const val = cfg.parameters?.[key];
      if (val === undefined) continue;
      this._applyParamNode(cfg, node, val);
    }
  }

  /**
   * Apply a single param value to the cfg record(s) named by its `node`.
   * Pure dispatch over node.type; shared by both cascade passes in _normalizeParams.
   * @private
   */
  _applyParamNode(cfg, node, val) {
    if (node.type === 'person') {
      const rec = (cfg.persons ?? []).find(r => r.id === node.id);
      // Design 15: canonicalize Date values to full ISO strings so the
      // cascaded field matches the serialized representation everywhere.
      if (rec) rec[node.field] = val instanceof Date ? val.toISOString() : val;
    } else if (node.type === 'account') {
      const rec = (cfg.accounts ?? []).find(r => r.stateKey === node.stateKey);
      if (rec) {
        rec[node.field] = val;
        // §4.4 invariant: a balance cascade must rescale holdings to match,
        // otherwise the holdings sum drifts away from the edited balance
        // (design 25 §4.4 / holdings-balance desync).
        if (node.field === 'balance' && Array.isArray(rec.holdings) && rec.holdings.length > 0) {
          rescaleHoldingsToBalance(rec.holdings, val);
        }
      }
    } else if (node.type === 'realProperty') {
      const rec = (cfg.realProperties ?? []).find(r => r.stateKey === node.stateKey);
      if (rec) rec[node.field] = val != null ? Math.round(val) : val;
    } else if (node.type === 'accountPriority') {
      // Fan one categorical strategy value out to drawdownPriority across many
      // accounts by role. Per-owner ranking (ownerOrder/ownerStride) keeps each
      // owner's same-role buckets in a distinct band so the primary drains before
      // the spouse. All scenario-specific data rides on the node, keeping this generic.
      //
      // User-authored strategies (stored in cfg.parameters[customStrategiesKey] as
      // [{ name, roles }]) are merged over the built-in `strategies` map so a custom
      // name resolves identically to a built-in one.
      let strategies = node.strategies ?? {};
      const custom = node.customStrategiesKey
        ? cfg.parameters?.[node.customStrategiesKey] : null;
      if (Array.isArray(custom) && custom.length > 0) {
        strategies = { ...strategies };
        for (const s of custom) {
          if (s?.name) strategies[s.name] = s.roles ?? {};
        }
      }
      const priorities = strategies[val];
      if (priorities) {
        // A selected strategy is authoritative over drawdown-eligible accounts:
        // each gets its mapped rank (+ owner band) or is cleared to null when the
        // strategy doesn't rank its role (excluded from drawdown). "Eligible" is
        // any role that appears in some strategy; savings/target roles never do,
        // so they keep their authored null. This keeps partial user-authored
        // strategies predictable (unranked roles drop out) and is a no-op for the
        // complete built-ins (which rank every eligible role).
        const eligible = new Set(
          Object.values(strategies).flatMap(m => (m ? Object.keys(m) : [])));
        for (const rec of (cfg.accounts ?? [])) {
          if (!eligible.has(rec.role)) continue;
          const base = priorities[rec.role];
          if (base == null) { rec.drawdownPriority = null; continue; }
          const rank = Math.max(0, (node.ownerOrder ?? []).indexOf(rec.ownerId));
          rec.drawdownPriority = base + rank * (node.ownerStride ?? 0);
        }
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
      if (s.dynamicOptionsFrom) entry.dynamicOptionsFrom = s.dynamicOptionsFrom;
      if (s.visibleWhen) entry.visibleWhen = s.visibleWhen;
      if (s.hidden)      entry.hidden      = s.hidden;
      // Money param metadata (design 10 §Phase 5): seed the chosen currency from
      // cfg.parameters' sibling override or the schema default; carry the state
      // paths this param stamps and its default for re-seeding.
      if (s.type === 'Money') {
        entry.currency        = cfg.parameters?.[`${s.key}Currency`] ?? s.defaultCurrency ?? 'USD';
        if (s.defaultCurrency)    entry.defaultCurrency    = s.defaultCurrency;
        if (s.currencyStateKeys)  entry.currencyStateKeys  = s.currencyStateKeys;
      }
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
      // Type is schema-owned metadata (the UI type selector is disabled for
      // schema params), so a schema type change (e.g. Array→AgeBandList,
      // Text→Enum) must propagate onto already-persisted entries — not just be
      // backfilled when absent.
      if (s.type        && p.type !== s.type)                p.type        = s.type;
      if (p.description === undefined && s.description)     p.description = s.description;
      if (p.node        === undefined && s.node)             p.node        = s.node;
      // Options are schema-owned (the available choices; the user's selection
      // lives in `value`), so adopt schema option-list changes onto persisted
      // entries — not just backfill when absent. E.g. a new AGE_BANDED choice
      // added to spendingStrategy must surface on already-saved scenarios.
      if (s.options)                                         p.options     = s.options;
      // dynamicOptionsFrom is schema-owned (names the sibling list param whose
      // entries extend this param's selectable options live in the UI).
      if (s.dynamicOptionsFrom)  p.dynamicOptionsFrom = s.dynamicOptionsFrom;
      else if (p.dynamicOptionsFrom) delete p.dynamicOptionsFrom;
      // visibleWhen is schema-owned UI metadata (conditional param visibility),
      // so re-sync it too — adopt new conditions and clear ones the schema dropped.
      if (s.visibleWhen)         p.visibleWhen = s.visibleWhen;
      else if (p.visibleWhen)    delete p.visibleWhen;
      if (p.value       === undefined && s.defaultValue !== undefined) p.value = s.defaultValue;
      // Money metadata drift: a schema param that became Money (e.g. a config
      // saved when monthlyExpenses was a Number) upgrades in place. The value is
      // already numeric, so forcing the type is safe and is required for the
      // editor to render the currency selector.
      if (s.type === 'Money') {
        p.type = 'Money';
        if (p.currencyStateKeys === undefined && s.currencyStateKeys) p.currencyStateKeys = s.currencyStateKeys;
        if (p.defaultCurrency  === undefined && s.defaultCurrency)    p.defaultCurrency   = s.defaultCurrency;
        if (p.currency         === undefined)                  p.currency         = s.defaultCurrency ?? 'USD';
      }
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
