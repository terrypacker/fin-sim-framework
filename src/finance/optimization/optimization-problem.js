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
import { IntlRetirementScenario } from '../../scenarios/intl-retirement-scenario.js';
import { ScenarioLoader }      from '../../scenarios/scenario-loader.js';
import { applyParamBagToConfig, resolveAliasCenters } from '../../scenarios/scenario-param-apply.js';
import { resolveLiquidityAxisCenters } from '../pools/pool-target-scale.js';
import { ScenarioSerializer }  from '../../scenarios/scenario-serializer.js';
import { computeNetWorth, computeNetWorthInclSpeculative } from '../derived-metrics/net-worth.js';
import { computeNetLiquidity } from '../derived-metrics/net-liquidity.js';
import { computeAfterTaxNetWorth, computeAfterTaxNetLiquidity, afterTaxOptionsFromParams }
  from '../derived-metrics/after-tax.js';
import { set }                 from '../monte-carlo/mc-param-paths.js';
import { scenarioParamValues } from '../param-schema-utils.js';
import { repinExpensesIfChanged } from '../spending/strategies/explicit-bands-spending-reducer.js';
import { captureDerivedState, applyDerivedState, captureDerivedEvents, spliceDerivedEvents }
                               from '../../scenarios/toolsets/derived-manifest.js';
import { OPT_PARAM_TYPES, OPTIMIZATION_OBJECTIVES, objectiveIsWindowable,
         infeasibilityOf, INFEASIBLE_OFFSET } from './optimization-objectives.js';
import { valuesForConfig }     from './opt-values.js';
import { DateUtils }           from '../../simulation-framework/date-utils.js';
import { rolloutProfiler }     from './rollout-profiler.js';

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
    horizonYears = null,   // sliding window length H (design 41); null/0 = full horizon
    feasibilityFirst = false,  // lexicographic solvency ranking (design 80 U2)
  } = {}) {
    this.variables    = variables;
    this.baseParams   = baseParams;
    this.objective    = objective;
    this.simStart     = simStart;
    this.simEnd       = simEnd;
    this.initialState = initialState;
    this.horizonYears = horizonYears;
    this.feasibilityFirst = feasibilityFirst;
    this._serializedTemplate = null;
    this._rawTemplateCache   = null;
    this._resolvedBase       = null;
  }

  /**
   * The base params every candidate is applied on top of: the cfg template's OWN
   * params, under the caller's `baseParams`.
   *
   * Without the template layer a rollout describes the framework's library defaults
   * rather than the loaded plan, because `serializeScenario` carries the typed
   * `cfg.params` list but DROPS the `cfg.parameters` bag — so a template built by
   * `buildDefaultConfig()` (the fallback, and what every headless lab uses) arrives
   * at `_compile` with no params at all and the loader fills in schema defaults.
   * `moveYear` and the `people` map aren't even in the schema, so they simply went
   * missing: the plan's move to AU never happened. Same defect the MC runner had.
   *
   * Resolved once and memoized. A WORKER must not redo the merge — it is handed a
   * pre-serialized template, so re-merging would fold a *different* (synthetic)
   * template's params in underneath and make parallel rollouts disagree with serial
   * ones. `initProblem` therefore pre-seeds `_resolvedBase` with the main thread's
   * already-merged base, the same way it pre-seeds `_serializedTemplate`.
   */
  _resolveBase() {
    const raw = this._rawTemplate();
    // Leg C's axes (design 110 §6.2 / §6.3) are HIDDEN generated params, so they are in
    // neither `cfg.params` nor `paramSchemaDefaults` and the base would carry no value for them —
    // the same gap `resolveAliasCenters` fills for a legacy-keyed lever.
    this._resolvedBase ??= { ...scenarioParamValues(raw), ...resolveAliasCenters(raw),
                             ...resolveLiquidityAxisCenters(raw), ...this.baseParams };
    return this._resolvedBase;
  }

  /**
   * The date each candidate rolls-and-scores to (design 41). With a sliding window
   * `horizonYears` (H), it is `min(now + H, simEnd)` — slides with "now," clamps at
   * simEnd, shrinks over the final H years. Forced to `simEnd` when H is unset OR
   * the objective isn't windowable (running-accumulator / death-anchored goals are
   * full-horizon, §41 §4/D1), so a non-continuation-value score is never windowed.
   * `H = remaining` ⇒ simEnd ⇒ identical to the full-horizon path. The COMMIT step
   * (rollToSnapshot) is independent — this governs only how far each solve looks.
   */
  _scoreEnd() {
    const H = this.horizonYears;
    if (!H || H <= 0 || !objectiveIsWindowable(this.objective)) return this.simEnd;
    const now  = this.initialState?.kind === 'snapshot' && this.initialState.snapshot?.date
      ? new Date(this.initialState.snapshot.date)
      : this.simStart;
    const edge = DateUtils.addYears(new Date(now), H);
    return edge < this.simEnd ? edge : this.simEnd;
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
    const result = this._rolloutResult(candidate);
    return { result, score: this._scoreResult(result) };
  }

  /**
   * The expensive half of `evaluate` (design 46 Phase 0.5): build the candidate's
   * params and roll one isolated simulation to the score date, returning the
   * pure-data metrics `result`. Deterministic in `(candidate, snapshot)` and free
   * of the objective — so it is the unit a Web Worker runs off the main thread.
   */
  _rolloutResult(candidate) {
    const params = this._applyCandidate({ ...this._resolveBase(), endDate: this._scoreEnd() }, candidate ?? {});
    return this._rollout(params);
  }

  /**
   * The cheap half of `evaluate`: apply the objective to a `result`, sign-adjusted
   * so higher is always better (minimize objectives negated), windowed by the
   * snapshot accumulator when scoring from a mid-run snapshot. Pure and
   * objective-bound, so it stays on the main thread even when `_rolloutResult` ran
   * in a worker (objectives carry functions and don't cross the worker boundary).
   */
  _scoreResult(result) {
    const { evaluate, direction } = this.objective;
    const sign  = direction === 'minimize' ? -1 : 1;
    const snapshot = this.initialState?.kind === 'snapshot' ? this.initialState.snapshot : undefined;
    const base = sign * evaluate(result, { snapshot });
    if (!this.feasibilityFirst) return base;

    // Design 80 U2 — lexicographic solvency ranking.
    //
    // Two distinct things this buys; be precise about which, because the obvious
    // story is the wrong one. It is NOT that `μ · deficit` under-prices ruin —
    // measured at the failing epoch (design/80 §2.9) the plain score already ranked
    // the feasible option ~50x above the nearest infeasible one. What it buys is:
    //
    //  1. SEARCH GUIDANCE. Under the plain score, infeasible candidates are ordered
    //     by `reward − λ − μ·deficit`, a mixture that includes consumption — so in a
    //     high-dimensional space where feasible samples are scarce, CEM's elite set
    //     fills with "expensively infeasible" points and refits its mean toward
    //     them. Ordering infeasible candidates by least shortfall ALONE gives a
    //     clean gradient back to the feasible set. This is what actually removed
    //     the five failing epochs of §2.7.
    //  2. A STRUCTURAL GUARANTEE in place of a numeric one. Solvency now holds at
    //     any μ, so it cannot be lost to a future re-tune. That matters because the
    //     λ term provably cannot help carry it: `computeNetLiquidity` bottoms out at
    //     0 ("reaches zero at the same moment an OutOfFunds event fires"), so
    //     `|terminal − target|` is capped at `target` across the whole insolvent
    //     region and the terminal penalty for ruin never scales with its severity.
    //
    // When NOTHING is feasible — a real case, e.g. a lever range floor above the
    // affordable level (§2.5) — least-shortfall ordering still gives the solver a
    // direction, and `isFeasibleResult` lets the caller say so instead of silently
    // committing the least-bad option.
    //
    // OFFSET is finite, not -Infinity: CEM fits a distribution over the elite set
    // and a non-finite score poisons the mean/σ update. It is far above any
    // realistic |base| (consumption, λ and μ terms are ≲1e10 on these scenarios)
    // and far above any realistic deficit, so the two bands cannot interleave.
    const shortfall = infeasibilityOf(result, snapshot);
    return shortfall > 0 ? -INFEASIBLE_OFFSET - shortfall : base;
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

  /** The cfg template as handed in (or the synthetic default), built at most once. */
  _rawTemplate() {
    this._rawTemplateCache ??= this.initialState?.cfgTemplate
      ?? IntlRetirementScenario.buildDefaultConfig({}, this.simStart, this.simEnd);
    return this._rawTemplateCache;
  }

  /** Serialize the cfg template once (JSON-safe; registry entries carry factories). */
  _cfgTemplate() {
    this._serializedTemplate ??= ScenarioSerializer.serializeScenario(this._rawTemplate());
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
    // 'off' at BUILD time. This used to build at the default 'full' and set silent +
    // journal off afterwards, which left history snapshots on: ~2,000 whole-state
    // clones (~220 MB on the reference plan) per rollout, on the main thread for the
    // Optimization tab, read by nothing — rollToSnapshot clones state itself.
    scenario.buildSim({ telemetry: 'off' });

    const cfg = structuredClone(this._cfgTemplate());
    // The same function an MC iteration and the Replay button use, so a lever key means
    // one thing everywhere (aliased legacy keys included).
    applyParamBagToConfig(cfg, params);
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
    // `data` copied a level down for the same reason `cloneQueue` does it (design 39 §14.9.4):
    // the re-target shims below rewrite queued event data IN PLACE, and a shared `data` object
    // makes that write land in the snapshot every later rollout is measured against.
    const queue = (snap.queue ?? []).map(e => ({
      ...e, date: new Date(e.date), ...(e.data ? { data: { ...e.data } } : {}),
    }));
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
      // ─── design 39 §14.9.4: the derivation manifest ─────────────────────────────
      //
      // Injection takes realized history from the snapshot and everything the candidate
      // DERIVED from params from this compile. Capture the derived half BEFORE injection
      // overwrites it; the toolsets declare what it is (derived-manifest.js), so a new lever
      // declares its own facts instead of adding a case here.
      //
      // This replaced four hand-written cases: the design 58 drawdown-field forward, the
      // WEIGHTED per-account priority forward, and the ROTH / early-withdrawal re-target
      // shims. The shims could change an AMOUNT on a queued event but never add or remove
      // one, so a schedule deciding WHICH years convert was lost in every rollout (§14.9).
      const snap      = this.initialState.snapshot;
      const manifest  = sim.derivedManifest ?? { state: [], events: [] };
      const derived   = captureDerivedState(sim.state, manifest.state);
      const events    = captureDerivedEvents(
        sim.queue?.data, manifest.events, new Date(snap.date).getTime());

      this._injectSnapshot(sim, snap);
      sim.state = applyDerivedState(sim.state, derived);
      spliceDerivedEvents(sim, events, manifest.events);

      // Forward-effective EXPLICIT_BANDS edit (design 39 §5 / Step 5b): when the
      // controls changed the band active at "now" vs the injected snapshot's pin,
      // actuate it immediately rather than waiting for the next annual period
      // advance — so the current year reflects the decision and the projection
      // matches the live Apply (which re-pins the same way). No-op otherwise.
      // Not a manifest entry: `monthlyExpenses` is realized (inflated to "now" by the run),
      // and this re-derives it from the candidate's band AT now.
      const patch = repinExpensesIfChanged(
        sim.state, params.spendingExpenseBands, new Date(sim.currentDate).getTime());
      if (patch) sim.state = { ...sim.state, ...patch };
    }
    return sim;
  }

  /** Roll the simulation forward per the initial-state strategy and read terminal metrics. */
  _rollout(params) {
    // Phase-0 profiling (design/46 §1): split setup / forward-step / metrics per
    // rollout. No-op overhead unless `__rolloutProfiler.enable()` was called.
    const sim = rolloutProfiler.time('compile', () => this._seededSim(params));
    rolloutProfiler.time('step', () => sim.stepTo(params.endDate));
    const result = rolloutProfiler.time('objective', () => this._readResult(sim.state, params.endDate, params));
    rolloutProfiler.countRollout();
    return result;
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
    const params = this._applyCandidate({ ...this._resolveBase(), endDate: this.simEnd }, candidate ?? {});
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
    // The fan spans the scored window [now, scoreEnd] (design 41) so the user sees
    // the horizon being optimized over, not always out to simEnd.
    const scoreEnd = this._scoreEnd();
    const params = this._applyCandidate({ ...this._resolveBase(), endDate: scoreEnd }, candidate ?? {});
    const sim    = this._seededSim(params);
    const startMs = sim.currentDate.getTime();
    const endMs   = scoreEnd.getTime();
    const n       = Math.max(2, points);
    const dates = [];
    const netWorth = [];
    for (let i = 0; i < n; i++) {
      const t = new Date(startMs + (endMs - startMs) * (i / (n - 1)));
      sim.stepTo(t);
      dates.push(new Date(sim.currentDate));
      netWorth.push(computeNetWorth(sim.state, 'USD'));
    }
    return { dates, netWorth, result: this._readResult(sim.state, scoreEnd, params) };
  }

  /** Terminal + cumulative metrics read from the final sim state. */
  _readResult(state, endDate, params = {}) {
    // After-tax re-pricing (design/40): values pre-tax IRA/401k/super dollars net
    // of their embedded liquidation tax so the Roth lever has a gradient. The
    // C-shaped provider seam selects the rate source: 'liquidation' (Option C —
    // the real tax-engine waterfall, design 40 Phase 3) or 'configured' (Option A,
    // the default — fixed effective rates).
    const afterTaxOpts = afterTaxOptionsFromParams(params);
    return {
      finalNetWorthUsd:  computeNetWorth(state, 'USD'),
      finalNetLiquidity: computeNetLiquidity(state, endDate),
      // Design 88 D7: the disclosure twin, so a panel can show "and what if the
      // speculative stakes all pay off?" beside the recognised figure without
      // re-running anything. NOT a terminal measure — nothing optimizes against it
      // (D10: the objective anchors on the recognised figure, or better, liquidity).
      finalNetWorthInclSpeculative: computeNetWorthInclSpeculative(state, 'USD'),
      finalAfterTaxNetWorth:     computeAfterTaxNetWorth(state, endDate, afterTaxOpts),
      finalAfterTaxNetLiquidity: computeAfterTaxNetLiquidity(state, endDate, afterTaxOpts),
      // Terminal price level (base-year USD deflator at the score date). The terminal
      // measures above are NOMINAL USD at `endDate`; the Die-With-Target objectives
      // divide by this to express the |terminal − target| penalty in the same real
      // base-year units as the (deflated) consumption reward, so the spend⇄bequest
      // trade-off is inflation-neutral and late-life spending isn't starved to defend
      // a fixed nominal target. 1.0 ⇒ no deflation (sim start / no accumulator).
      terminalPriceLevel: state.inflationAccumulator?.US ?? 1,
      scenarioFailed:    state.scenarioFailed    ?? false,
      cumulativeDeficit: state.cumulativeDeficit ?? 0,
      deficitMonths:     state.deficitMonths     ?? 0,
      // WHEN the plan ran dry (design 80 F1). The deficit fields say how badly a
      // rollout failed; only this says when, which is the one fact a user can act
      // on ("this plan runs out in Apr 2051"). Stamped by SetOutOfFundsDateReducer
      // on the FIRST occurrence, so it survives the 194 months that follow.
      outOfFundsDate:    state.outOfFundsDate    ?? null,
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
