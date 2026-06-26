/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { ServiceRegistry }     from '../../services/service-registry.js';
import { IntlRetirementScenario, applyRealPropertySaleYearParams } from '../../scenarios/intl-retirement-scenario.js';
import { ScenarioLoader }      from '../../scenarios/scenario-loader.js';
import { ScenarioSerializer }  from '../../scenarios/scenario-serializer.js';
import { computeNetWorth }     from '../derived-metrics/net-worth.js';
import { computeNetLiquidity } from '../derived-metrics/net-liquidity.js';
import { set }                 from '../monte-carlo/mc-param-paths.js';
import { repinExpensesIfChanged } from '../spending/strategies/explicit-bands-spending-reducer.js';
import { OPT_PARAM_TYPES, OPTIMIZATION_OBJECTIVES } from './optimization-objectives.js';
import { valuesForConfig }     from './opt-values.js';

/** Deep-ish equality good enough for ENUM value matching (primitives + arrays of primitives). */
function _eq(a, b) {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((x, i) => _eq(x, b[i]));
  }
  return false;
}

function _clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

/**
 * OptimizationProblem — the black box `f(x)` (design/38 §3.1).
 *
 * Owns everything that is *not* search strategy: the search space (variables),
 * the base params applied to every candidate, the objective, and the isolated,
 * deterministic, side-effect-free simulation harness (`evaluate`). Every solver
 * (grid, pattern search, annealing, …) calls `evaluate`; no solver knows how a
 * candidate becomes a score.
 *
 * `encode`/`decode` let vector-oriented solvers operate in ℝⁿ while categorical
 * and integer variables snap back to legal values on `decode`.
 *
 * ── Initial-state provider (the seam with design 39) ────────────────────────
 * `evaluate` rolls forward from EITHER the scenario start (batch) OR a mid-run
 * snapshot (MPC), so one black box serves both engines:
 *
 *   initialState = { kind: 'compile',  cfgTemplate }
 *       → build the scenario in an isolated ServiceRegistry, stepTo(simEnd).
 *         Today's IntlRetirementOptimizer._runOne behaviour, unchanged.
 *
 *   initialState = { kind: 'snapshot', snapshot, cfgTemplate }
 *       → still COMPILE the scenario (to rebuild the deterministic wiring), then
 *         inject the snapshot's `state` + event `queue` instead of re-simulating
 *         the past, and step forward from the snapshot date. `snapshot` is
 *         `{ date, state, queue }` — the shape SimulationHistory.takeSnapshot()
 *         produces.
 *
 * Both kinds (and every solver) rely on the SHARED INVARIANT that compiling the
 * same cfg in a fresh ServiceRegistry yields identical wiring and `stateKey`
 * slot assignments every time — so an injected snapshot's stateKeys line up with
 * the freshly-compiled handlers/reducers.
 */
export class OptimizationProblem {
  /**
   * @param {object}   opts
   * @param {Array}    opts.variables    - Search-space configs (the ENABLED set):
   *                                        [{ paramKey, type, values | min/max/step, group }].
   * @param {object}   [opts.baseParams] - Scenario params applied to every candidate.
   * @param {object}   [opts.objective]  - Entry from OPTIMIZATION_OBJECTIVES.
   * @param {Date}     opts.simStart
   * @param {Date}     opts.simEnd
   * @param {object}   [opts.initialState] - { kind:'compile'|'snapshot', ... } (see class doc).
   */
  constructor({
    variables    = [],
    baseParams   = {},
    objective    = OPTIMIZATION_OBJECTIVES.MAX_NET_WORTH,
    simStart     = new Date(Date.UTC(2026, 0, 1)),
    simEnd       = new Date(Date.UTC(2041, 0, 1)),
    initialState = { kind: 'compile', cfgTemplate: null },
  } = {}) {
    this.variables    = variables;
    this.baseParams   = baseParams;
    this.objective    = objective;
    this.simStart     = simStart;
    this.simEnd       = simEnd;
    this.initialState = initialState;
    this._serializedTemplate = null;
  }

  // ── Vector ⇄ candidate codec ──────────────────────────────────────────────

  /** candidate object → numeric vector (variable order). ENUMs encode as index. */
  encode(candidate) {
    return this.variables.map(v => {
      const val = candidate?.[v.paramKey];
      if (v.type === OPT_PARAM_TYPES.ENUM) {
        const idx = (v.values ?? []).findIndex(o => _eq(o, val));
        return idx < 0 ? 0 : idx;
      }
      return Number(val);
    });
  }

  /** numeric vector → candidate object. Snaps INTEGER (round) and ENUM (nearest legal). */
  decode(vector) {
    const candidate = {};
    this.variables.forEach((v, i) => {
      const raw = vector[i];
      if (v.type === OPT_PARAM_TYPES.ENUM) {
        const opts = v.values ?? [];
        const idx  = opts.length ? _clamp(Math.round(raw), 0, opts.length - 1) : 0;
        candidate[v.paramKey] = opts[idx];
      } else if (v.type === OPT_PARAM_TYPES.INTEGER) {
        candidate[v.paramKey] = _clamp(Math.round(raw), v.min, v.max);
      } else { // CONTINUOUS
        candidate[v.paramKey] = _clamp(raw, v.min, v.max);
      }
    });
    return candidate;
  }

  /** Seeded sample within bounds. @param {() => number} rng uniform [0,1). */
  randomCandidate(rng) {
    const candidate = {};
    for (const v of this.variables) {
      if (v.type === OPT_PARAM_TYPES.ENUM) {
        const opts = v.values ?? [];
        candidate[v.paramKey] = opts[Math.floor(rng() * opts.length)] ?? opts[0];
      } else if (v.type === OPT_PARAM_TYPES.INTEGER) {
        candidate[v.paramKey] = Math.round(v.min + rng() * (v.max - v.min));
      } else { // CONTINUOUS
        candidate[v.paramKey] = v.min + rng() * (v.max - v.min);
      }
    }
    return candidate;
  }

  /**
   * Exhaustive grid size. ∞-safe: returns null when any variable is unbounded
   * (no values and no finite min/max/step), since the grid is then infinite.
   */
  candidateCount() {
    if (this.variables.length === 0) return 1;
    let n = 1;
    for (const v of this.variables) {
      const vals = valuesForConfig(v);
      if (vals.length === 0) return null;
      n *= vals.length;
    }
    return n;
  }

  // ── The shared black box ──────────────────────────────────────────────────

  /**
   * Run ONE isolated, deterministic simulation for a candidate and score it.
   * Score is sign-adjusted so higher is always better (minimize objectives are
   * negated), matching the legacy optimizer's ranking contract.
   *
   * @param {object} candidate - paramKey → value overrides.
   * @returns {{ result: object, score: number }}
   */
  evaluate(candidate) {
    const params = this._applyCandidate({ ...this.baseParams, endDate: this.simEnd }, candidate ?? {});
    const result = this._rollout(params);

    const { evaluate, direction } = this.objective;
    const sign  = direction === 'minimize' ? -1 : 1;
    const snapshot = this.initialState?.kind === 'snapshot' ? this.initialState.snapshot : undefined;
    const score = sign * evaluate(result, { snapshot });
    return { result, score };
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  /**
   * Apply a candidate's paramKey→value pairs onto a deep clone of base using
   * path-aware set(), so nested paths (e.g. spendingExpenseBands[0].monthlyAmount)
   * reach the correct location in the params tree (design 25a).
   */
  _applyCandidate(base, candidate) {
    const params = structuredClone(base);
    for (const [k, v] of Object.entries(candidate)) set(params, k, v);
    return params;
  }

  /** Serialize the cfg template once (JSON-safe; registry entries carry factories). */
  _cfgTemplate() {
    if (this._serializedTemplate) return this._serializedTemplate;
    const raw = this.initialState?.cfgTemplate
      ?? IntlRetirementScenario.buildDefaultConfig({}, this.simStart, this.simEnd);
    this._serializedTemplate = ScenarioSerializer.serializeScenario(raw);
    return this._serializedTemplate;
  }

  /**
   * Compile the scenario in an isolated ServiceRegistry so the user's active
   * scenario + UI stay untouched. Returns the freshly-built (not yet stepped)
   * Simulation. Shared by both initial-state kinds.
   */
  _compile(params) {
    const registry = new ServiceRegistry();
    const scenario = new IntlRetirementScenario({
      context:  registry.simulationContext,
      params,
      simStart: this.simStart,
      simEnd:   this.simEnd,
    });
    scenario.buildSim();

    const cfg = structuredClone(this._cfgTemplate());
    cfg.parameters = { ...(cfg.parameters ?? {}), ...params };
    applyRealPropertySaleYearParams(cfg, params);
    if (Array.isArray(cfg.params)) {
      for (const p of cfg.params) {
        if (params[p.name] !== undefined) p.value = params[p.name];
      }
    }
    new ScenarioLoader().load(cfg, registry);
    return scenario.sim;
  }

  /**
   * Inject a now-snapshot's state + event queue into a freshly-compiled sim,
   * instead of re-simulating the past. The freshly-compiled wiring + stateKeys
   * line up by the shared deterministic-compile invariant (design 39 §10 Q4).
   */
  _injectSnapshot(sim, snap) {
    sim.state = structuredClone(snap.state);
    const queue = (snap.queue ?? []).map(e => ({ ...e, date: new Date(e.date) }));
    sim.queue.restoreData(queue);
    sim.currentDate = sim.normalizeDate(new Date(snap.date));
    // Carry the snapshot's RNG cursor forward so a rollout seeded from "now"
    // continues the same draw sequence (faithful for stochastic rollouts —
    // design 39 §10 Q5). SimulationHistory.takeSnapshot() captures rngState;
    // honour it when present, otherwise keep the fresh compile's seed.
    if (snap.rngState !== undefined) sim.rngState = snap.rngState;
    // Keep the instanceId counter ahead of any restored event so recurring
    // re-schedules never collide with a queued event in the indexed heap.
    const maxId = queue.reduce((m, e) => Math.max(m, e.instanceId ?? -1), -1);
    sim.nextEventInstanceId = Math.max(sim.nextEventInstanceId, maxId + 1);
    sim.history.snapshots.length = 0;
    sim.history.snapshotCursor   = -1;
  }

  /**
   * Compile the scenario and seed it per the initial-state strategy (inject the
   * snapshot for `kind:'snapshot'`), returning a silent, journal-off sim that is
   * ready to step but has NOT been stepped. Shared by `_rollout` (steps to
   * simEnd) and `rollToSnapshot` (steps to an intermediate epoch).
   */
  _seededSim(params) {
    const sim = this._compile(params);
    if (this.initialState?.kind === 'snapshot') {
      this._injectSnapshot(sim, this.initialState.snapshot);
      // Forward-effective EXPLICIT_BANDS edit (design 39 §5 / Step 5b): when the
      // controls changed the band active at "now" vs the injected snapshot's pin,
      // actuate it immediately rather than waiting for the next annual period
      // advance — so the current year reflects the decision and the projection
      // matches the live Apply (which re-pins the same way). No-op otherwise.
      const patch = repinExpensesIfChanged(
        sim.state, params.spendingExpenseBands, new Date(sim.currentDate).getTime());
      if (patch) sim.state = { ...sim.state, ...patch };
    }
    sim.silent = true;
    sim.journal.enabled = false;
    return sim;
  }

  /** Roll the simulation forward per the initial-state strategy and read terminal metrics. */
  _rollout(params) {
    const sim = this._seededSim(params);
    sim.stepTo(params.endDate);
    return this._readResult(sim.state, params.endDate, params);
  }

  /**
   * Roll forward to an intermediate date and capture a fresh now-snapshot — the
   * receding-horizon "advance" of design 39 Step 3. Applies `candidate` (the
   * committed first-segment controls) on top of baseParams, seeds from the
   * initial state (a snapshot or a t0 compile), steps to `toDate`, and returns a
   * snapshot in the SimulationHistory.takeSnapshot() shape for the next epoch.
   *
   * @param {object} candidate - committed control params for this segment.
   * @param {Date}   toDate    - the next decision epoch.
   * @returns {{ date: Date, state: object, queue: Array, rngState: number }}
   */
  rollToSnapshot(candidate, toDate) {
    const params = this._applyCandidate({ ...this.baseParams, endDate: this.simEnd }, candidate ?? {});
    const sim = this._seededSim(params);
    sim.stepTo(toDate);
    return {
      date:     new Date(sim.currentDate),
      state:    structuredClone(sim.state),
      queue:    sim.cloneQueue(),
      rngState: sim.rngState,
    };
  }

  /**
   * Roll forward sampling net worth at evenly spaced dates — the per-step
   * trajectory the MPC cockpit's "futures fan" draws (design 39 §7). Reuses the
   * initial-state strategy (snapshot or compile), so a candidate's fan line
   * starts at "now". Returns the sampled series plus the terminal result.
   *
   * @param {object} candidate
   * @param {number} [points=24] number of samples from the start date to simEnd.
   * @returns {{ dates: Date[], netWorth: number[], result: object }}
   */
  rolloutSeries(candidate, { points = 24 } = {}) {
    const params = this._applyCandidate({ ...this.baseParams, endDate: this.simEnd }, candidate ?? {});
    const sim    = this._seededSim(params);
    const startMs = sim.currentDate.getTime();
    const endMs   = this.simEnd.getTime();
    const n       = Math.max(2, points);
    const dates = [];
    const netWorth = [];
    for (let i = 0; i < n; i++) {
      const t = new Date(startMs + (endMs - startMs) * (i / (n - 1)));
      sim.stepTo(t);
      dates.push(new Date(sim.currentDate));
      netWorth.push(computeNetWorth(sim.state, 'USD'));
    }
    return { dates, netWorth, result: this._readResult(sim.state, this.simEnd, params) };
  }

  /** Terminal + cumulative metrics read from the final sim state. */
  _readResult(state, endDate, params = {}) {
    return {
      finalNetWorthUsd:  computeNetWorth(state, 'USD'),
      finalNetLiquidity: computeNetLiquidity(state, endDate),
      scenarioFailed:    state.scenarioFailed    ?? false,
      cumulativeDeficit: state.cumulativeDeficit ?? 0,
      deficitMonths:     state.deficitMonths     ?? 0,
      rothFinalBalance:  (state.rothAccount?.balance ?? 0) + (state.spouseRothAccount?.balance ?? 0),
      // Lifetime running accumulators (design 38 §5), USD-normalized.
      cumulativeTaxesPaid:  state.cumulativeTaxesPaid   ?? 0,
      lifetimeConsumption:  state.cumulativeConsumption ?? 0,
      // CRRA running utility of consumption (design 39 §4).
      lifetimeConsumptionUtility: state.cumulativeConsumptionUtility ?? 0,
      // Run's average marginal utility u'(c̄) — the dollars→utils shadow price that
      // auto-scales the CRRA Die-With-Target λ (design 39 §11). Null when no
      // consumption was recorded.
      consumptionMarginalUtility: (state.cumulativeConsumptionUtilityCount ?? 0) > 0
        ? (state.cumulativeConsumptionMarginalUtility ?? 0) / state.cumulativeConsumptionUtilityCount
        : null,
      // Objective parameters carried through so pure objectives can read them.
      terminalWealthTarget:        params.terminalWealthTarget ?? 0,
      terminalWealthTargetPenalty: params.terminalWealthTargetPenalty,
      deficitPenalty:              params.deficitPenalty,
    };
  }
}
