/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import {SimGraphNode} from "../graph/sim-graph-node.js";
import {Simulation} from "../simulation-framework/simulation.js";
import {EventBus} from "../simulation-framework/event-bus.js";
import {DerivedMetricsRegistry} from "../simulation-framework/derived-metrics-registry.js";
import {deriveNetWorth} from "../finance/derived-metrics/net-worth.js";
import {deriveNetLiquidity} from "../finance/derived-metrics/net-liquidity.js";
import {deriveOffsetCapacity} from "../finance/derived-metrics/offset-capacity.js";
import {roundRecordField} from "./params/record-field-rounding.js";

/**
 * Base class for simulation scenarios.
 *
 * BaseScenario extends SimGraphNode with kind:'scenario' / layer:'scenario'.
 * Scenario nodes live in the shared Graph and survive ServiceRegistry.reset()
 * (see design/17-scenario-as-graph-node.md §3.8).
 *
 * Scenario population is owned by ScenarioLoader, which dispatches between
 * graph deserialization (saved snapshot) and toolset compilation (declarative
 * inputs). Subclasses declare toolsets via `getToolsets()` + `buildDefaultConfig()`.
 */
export class BaseScenario extends SimGraphNode {
  /**
   * Declare the typed parameters this scenario exposes for UI editing,
   * MonteCarlo sampling, and optimization.
   *
   * Each entry: { key, label, type, group, defaultValue, description }
   *   type: 'Number' | 'Date' | 'Boolean' | 'String'
   *
   * Subclasses override this to describe their specific param surface.
   * @returns {Array<{key:string, label:string, type:string, group:string, defaultValue:*, description:string}>}
   */
  static getParamSchema() { return []; }
  getParamSchema() { return this.constructor.getParamSchema(); }

  /**
   * Return the toolset IDs this scenario declares. Non-empty means the
   * scenario routes through ScenarioCompiler on first load.
   * @returns {string[]}
   */
  static getToolsets() { return []; }
  getToolsets() { return this.constructor.getToolsets(); }

  /**
   * Produce the declarative config that WorkbenchApp merges into activeConfig for a
   * fresh prebuilt scenario.  Must return an object with at minimum:
   *   { toolsets, parameters, persons, accounts, realProperties, collectibles }
   * Returns null for scenarios that don't use the toolset path.
   *
   * @param {object}  _params   - merged params plain object
   * @param {string}  _simStart - ISO date string
   * @param {string}  _simEnd   - ISO date string
   * @returns {object|null}
   */
  // eslint-disable-next-line no-unused-vars
  static buildDefaultConfig(_params, _simStart, _simEnd) { return null; }

  /**
   * Construct a runnable scenario instance from typed inputs.
   * Subclasses must override — calling the base throws.
   * @param {object[]} _params
   * @param {Date}     _simStart
   * @param {Date}     _simEnd
   * @returns {BaseScenario}
   */
  // eslint-disable-next-line no-unused-vars
  static instantiate(_params, _simStart, _simEnd) {
    throw new Error(`${this.name} must implement static instantiate()`);
  }

  /** Stable machine identifier for this scenario class (e.g. 'intl-retirement'). */
  static scenarioId() {
    throw new Error(`${this.name} must implement static scenarioId()`);
  }

  /** Human-readable display name (e.g. 'International Retirement'). */
  static scenarioName() {
    throw new Error(`${this.name} must implement static scenarioName()`);
  }

  constructor({
    id,
    name,
    order        = 100,
    prebuilt     = false,
    active       = false,
    context,
    initialState = {},
    params       = [],
    simStart     = new Date(Date.UTC(2026, 0, 1)),
    simEnd       = new Date(Date.UTC(2041, 0, 1)),
    // Materialized cfg (populated by buildDefaultConfig / ScenarioLoader)
    persons, accounts, realProperties, collectibles, toolsets,
  } = {}) {
    super({
      id,
      name:  name ?? id,
      kind:  'scenario',
      layer: 'scenario',
    });

    this.order    = order;
    this.prebuilt = prebuilt;
    this.active   = active;
    // Runtime-only; never serialized
    this.context      = context;
    this.initialState = initialState;
    this.params       = params;

    if (!this._isDate(simStart)) throw new Error('Must supply simStart Date to scenario');
    if (!this._isDate(simEnd))   throw new Error('Must supply simEnd Date to scenario');

    this.simStart = simStart;
    this.simEnd   = simEnd;

    if (persons)        this.persons        = persons;
    if (accounts)       this.accounts       = accounts;
    if (realProperties) this.realProperties = realProperties;
    if (collectibles)   this.collectibles   = collectibles;
    if (toolsets)       this.toolsets       = toolsets;
  }

  _isDate(date) {
    return date instanceof Date && !isNaN(date);
  }
  // ─── Simulation accessor ──────────────────────────────────────────────────

  /**
   * The active simulation.  Delegates to SimulationRegistry so the sim object
   * is not tightly held by the scenario.
   * @returns {import('../simulation-framework/simulation.js').Simulation|null}
   */
  get sim() {
    return this.context.simulationRegistry.getPrimary();
  }

  // ─── Params ───────────────────────────────────────────────────────────────

  /**
   * Apply a plain params object to this scenario without clearing the config layer.
   *
   * Algorithm:
   *   1. Write each key present in `params` back onto the matching `this.params[i].value`.
   *   2. For each typed-param entry that carries a `node` declaration, update the
   *      live config-layer record (person / account / real property / collectible /
   *      company equity) in-place via the service APIs.
   *   3. For account `balance` changes, also patch `this.initialState` so
   *      that the next `buildSim()` starts with the correct opening balance.
   *
   * This is the in-place sibling of `ScenarioLoader._applyParamNode`, which runs the
   * same cascade on the cfg records during a full load/Rebuild. The two must cover
   * the same `node.type`s: a type handled by only one of them means the param is
   * silently dropped on that path — and for a GENERATED per-record param that is
   * worse than inert, because the design-55 §6 harvest re-seeds the param from its
   * record, blanking the user's value. Node types with no simple record target
   * (`bequest`, `bequestAsset`, `accountPriority`) are load-path only by design.
   * Whole-number coercion is shared via `roundRecordField` so neither path rounds a
   * fractional rate to zero.
   *
   * Subclasses may override for finer control (e.g. to also update event data).
   *
   * @param {object} params - Plain key→value map of param overrides.
   */
  applyParams(params) {
    if (!params || !Array.isArray(this.params)) return;

    // Step 1 — update typed params array
    for (const p of this.params) {
      const key = p.name ?? p.key;
      if (params[key] !== undefined) p.value = params[key];
    }

    // Step 2+3 — apply node cascade to live config nodes
    const { personService, accountService } = this.context;
    for (const p of this.params) {
      const node = p.node;
      if (!node) continue;
      const key = p.name ?? p.key;
      const raw = params[key] ?? p.value;
      if (raw === undefined) continue;
      const val = (p.type === 'Date' && raw) ? new Date(raw) : raw;

      if (node.type === 'person') {
        const person = personService.getAll().find(pr => pr.id === node.id);
        if (person) {
          personService.updatePerson(person, {
            [node.field]: val instanceof Date ? val.toISOString() : val,
          });
        }
      } else if (node.type === 'account') {
        const account = accountService.getAll().find(a => a.stateKey === node.stateKey);
        if (account) {
          accountService.updateAccount(account, { [node.field]: val });
        }
        // Keep initialState in sync for opening-balance params so buildSim()
        // starts the Simulation with the updated balance.
        if (node.field === 'balance' && this.initialState?.[node.stateKey]) {
          this.initialState[node.stateKey].balance = val;
        }
      } else if (node.type === 'realProperty') {
        const realPropertyService = this.context?.realPropertyService;
        const prop = realPropertyService?.getAll().find(r => r.stateKey === node.stateKey);
        if (prop) {
          realPropertyService.updateProperty(prop, {
            [node.field]: roundRecordField(node.field, val),
          });
        }
      } else if (node.type === 'collectible') {
        const collectibleService = this.context?.collectibleService;
        const col = collectibleService?.getAll().find(c => c.stateKey === node.stateKey);
        if (col) {
          collectibleService.updateCollectible(col, {
            [node.field]: roundRecordField(node.field, val),
          });
        }
      } else if (node.type === 'companyEquity') {
        const companyEquityService = this.context?.companyEquityService;
        const eq = companyEquityService?.getAll().find(e => e.stateKey === node.stateKey);
        if (eq) {
          companyEquityService.updateCompanyEquity(eq, {
            [node.field]: roundRecordField(node.field, val),
          });
        }
      }
    }
  }

  /**
   * Cheap Rebuild: clears only the execution layer, applies params to existing
   * config nodes in-place, then constructs a fresh Simulation.
   *
   * Use this instead of destroyScenario() + initScenario() when only typed
   * params have changed and the config graph structure (persons, accounts,
   * events, handlers) does not need to be recreated from scratch.
   *
   * @param {object} [params] - Plain key→value overrides.  If omitted, the
   *   current this.params values are used as-is.
   */
  rebuild(params) {
    this.context.services.reset();
    if (params) this.applyParams(params);
    // Rebuild with the SAME sim options the caller originally asked for. Passing
    // nothing here silently reverted every one of them to its default — so an app
    // that built the primary sim with a sampler (design 82 §6) or at a reduced
    // telemetry level lost that on the first param edit, and the panel it fed simply
    // went empty with nothing to explain why.
    this.buildSim(this._buildSimOpts ?? {});
  }

  // ─── Build ────────────────────────────────────────────────────────────────

  /**
   * Create a fresh Simulation and register it as 'primary'.
   * Also configures SimulationSync with simStart so recurring events are
   * scheduled from the correct date.
   *
   * If `initialState` is absent or empty, calls `buildDefaultInitialState(params)`
   * so subclasses can supply a scenario-specific default without overriding this
   * method.  The resolved state (as a plain object) is stored on `this.initialState`
   * so it can be captured for serialization.
   */
  /**
   * @param {object} [opts]
   * @param {number} [opts.seed=1] - Seed for the simulation's snapshot-safe RNG
   *   (`sim.rng`). Defaults to 1 so single runs stay byte-identical. Monte Carlo
   *   passes a per-iteration seed so each path draws its OWN in-loop random sequence
   *   (FX design 47, yield curve design 67, equity return paths design 74); without
   *   this every MC iteration ran at seed 1 and drew the identical stochastic path,
   *   silently collapsing sequence-of-returns risk to a single ordering.
   */
  /**
   * @param {object} [o]
   * @param {number} [o.seed=1]
   * @param {'full'|'journal'|'metrics'|'off'} [o.telemetry='full'] Observation
   *   cost of the run — see TELEMETRY_LEVELS (design 78 §4.3). Batch callers
   *   (Monte Carlo, optimizer, scripts/) should ask for the level they need
   *   here rather than poking sim.silent after the fact.
   * @param {function} [o.sampler] Optional (state, date) => record. Lets a caller
   *   collect a time series without paying for full-state snapshots; read it back
   *   off `sim.samples`.
   * @param {'interval'|'year-boundary'} [o.samplerCadence='interval'] When the
   *   sampler fires — every `snapshotInterval` events, or once per calendar year at
   *   the year boundary (design 82 §4). Anything sensitive to the year-end sequence
   *   (an asset mix, which the year-end rebalance moves) wants 'year-boundary'; the
   *   default keeps design 78's MC series unchanged.
   * @param {'throw'|'warn'|'off'} [o.pastEndPolicy='throw'] What `sim.stepTo()`
   *   does when handed a date past this scenario's simEnd — see Simulation.
   */
  buildSim({
    seed = 1, telemetry = 'full', sampler = null, samplerCadence = 'interval',
    pastEndPolicy = 'throw',
  } = {}) {
    // Remembered so rebuild() can reconstruct an equivalent sim rather than a
    // default one — see rebuild().
    this._buildSimOpts = { seed, telemetry, sampler, samplerCadence, pastEndPolicy };

    const isEmpty = !this.initialState || Object.keys(this.initialState).length === 0;
    const resolved = isEmpty ? (this.buildDefaultInitialState(this.params) ?? {}) : this.initialState;

    // Persist as a plain object so ScenarioTabPresenter can serialize it.
    this.initialState = typeof resolved?.toPlain === 'function' ? resolved.toPlain() : resolved;

    const { simulationRegistry, simulationSync, graph } = this.context;
    simulationRegistry.unregister('primary');

    const derivedMetrics = new DerivedMetricsRegistry();
    derivedMetrics.register(deriveNetWorth);
    derivedMetrics.register(deriveNetLiquidity);
    // Design 86 G4 — offset capital that is neither invested nor offsetting. Both
    // figures are 0 when the plan holds no offset account, so this is inert otherwise.
    derivedMetrics.register(deriveOffsetCapacity);

    // Per-run execution bus. The Simulation publishes execution telemetry
    // (EXECUTION_*, BREAKPOINT_HIT) onto its own bus, NOT the persistent
    // ServiceRegistry bus, so every telemetry subscription dies with the sim
    // when the scenario is rebuilt — no manual cleanup required. The shared
    // ServiceRegistry bus (context.bus) carries SERVICE_ACTION / config edits;
    // SimulationSync reaches this sim via the registry, not the bus.
    const sim = new Simulation(this.simStart, {
      bus: new EventBus(),
      graph,
      seed,
      initialState: resolved,
      // simEnd is the run's horizon, not just a slider bound: the toolsets
      // schedule events out to it and no further, so stepping past it produces a
      // half-advanced world. Handing it to the sim lets stepTo() say so.
      opts: {
        derivedMetrics, telemetry, sampler, samplerCadence,
        simEnd: this.simEnd, pastEndPolicy,
      },
    });

    simulationRegistry.register('primary', sim);
    simulationSync.setSimStart(this.simStart);
  }

  /**
   * Override to supply a scenario-specific default initial state.
   * Called from buildSim() when no saved initialState is provided.
   * Return a SimulationState instance (with toPlain()) or a plain object.
   * @param {object} _params - Merged scenario params.
   * @returns {object|null}
   */
  // eslint-disable-next-line no-unused-vars
  buildDefaultInitialState(_params) {
    return null;
  }
}
