/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { ScenarioRunner }             from '../../simulation-framework/scenario.js';
import { IntlRetirementScenario, resolveBalanceCenters } from '../../scenarios/intl-retirement-scenario.js';
import { ScenarioSerializer }         from '../../scenarios/scenario-serializer.js';
import { IntlRetirementMcConfig, CENTER_SOURCES, refineCenterSource } from './intl-retirement-mc-config.js';
import { scenarioParamValues, paramSchemaDefaults } from '../param-schema-utils.js';
import { buildIterationRunner, perturbParams } from './parallel/mc-worker-core.js';
import { McWorkerPool }              from './parallel/mc-worker-pool.js';

// What a path records lives in ./mc-sampling.js so the worker core can import it
// without importing this module (which owns the BATCH: param layering, provenance,
// aggregation). Re-exported here because these were this module's public API before
// the split — `src/index.js` and existing callers import them from here.
export {
  computeNetWorthUsd, computeHouseValueUsd, MC_SAMPLER_CADENCE, createMcSampler,
  extractYearlyTimeSeries,
} from './mc-sampling.js';

/**
 * Path-shape diagnostics for one MC iteration (design 74 §5.2). Computed from the
 * yearly net-worth series so it characterizes the *shape* of the path, not just its
 * endpoint — the readout sequence-of-returns risk needs. Robust to short/degenerate
 * series (returns nulls rather than NaN/Infinity).
 *
 *   - netWorthCagr    — realized geometric growth of net worth start→end ("realized
 *                       geometric mean" in §5.2). null when either endpoint ≤ 0.
 *   - worst5yrCagr    — the worst rolling 5-year annualized growth. The classic
 *                       sequence-risk window: a bad early 5 years is far more damaging
 *                       to a decumulating portfolio than the same 5 years late.
 *   - maxDrawdown     — deepest peak-to-trough decline as a fraction of the peak, [0,1].
 *   - decadeNetWorthUsd — net worth ~10 years in (min(10, last)); the aggregate step
 *                       marks whether this was below the cross-path median (§5.2's
 *                       "first decade below median" — the direct sequence-risk flag).
 *   - minRealNetLiquidity / minRealNetLiquidityYear — the lowest point on the path,
 *                       in SPENDABLE, BASE-YEAR terms (design 97 §18). This is the
 *                       metric a liquidity reserve exists to move, and none of the
 *                       three above can stand in for it:
 *                         · `maxDrawdown` is a fraction of net WORTH, which counts
 *                           the house and any company equity — the two things a
 *                           reserve cannot spend. A plan can hold its net-worth
 *                           drawdown flat while its spendable book goes to nothing.
 *                         · it is a RATIO, so it cannot say how many years of
 *                           spending were left at the worst point.
 *                         · terminal wealth is measured after the recovery, so it
 *                           rewards whoever carried the most equity through it
 *                           (`scenarios/offset-bond-pool/STUDY.md`) — the exact bias
 *                           a reserve study must not score itself on.
 *                       Deflated by the price level sampled AT each point, so it is
 *                       comparable across paths whose realized inflation differs.
 *
 *                       On a path that ran out of funds it is ~0 by construction, so
 *                       failure is the primary key and this is the secondary one.
 *   - troughRealNetLiquidity / …Year / …Drawdown — the same quantity measured AFTER
 *                       the peak: the level at the bottom of the deepest fall from a
 *                       running high, and that fall as a fraction of the high.
 *
 *                       Needed because `minRealNetLiquidity` is the whole-path floor,
 *                       and on any plan that is still accumulating at t0 the floor IS
 *                       t0 — measured on the reference plan, the median path's minimum
 *                       fell in the FIRST sampled year, so the metric reported the
 *                       opening balance and ranked every arm identically. The opening
 *                       balance is the one number no strategy can change.
 *
 *                       The post-peak trough cannot be reached by the opening balance
 *                       (a running peak has to be set first), so it is the one to rank
 *                       strategies on; the whole-path floor stays, because on a plan
 *                       that decumulates from day one they coincide and the floor is
 *                       the more direct statement.
 */
export function computePathShape(timeSeries) {
  const nw = (timeSeries ?? []).map(p => p.netWorthUsd);
  const empty = {
    netWorthCagr: null, worst5yrCagr: null, maxDrawdown: null, decadeNetWorthUsd: null,
    houseCagr: null, houseMaxDrawdown: null,
    minRealNetLiquidity: null, minRealNetLiquidityYear: null,
    troughRealNetLiquidity: null, troughRealNetLiquidityYear: null, troughRealDrawdown: null,
  };
  if (nw.length < 2) return empty;

  const years = nw.length - 1;
  const first = nw[0];
  const last  = nw[nw.length - 1];
  const netWorthCagr = (first > 0 && last > 0) ? Math.pow(last / first, 1 / years) - 1 : null;

  // Worst rolling 5-year annualized growth (skips windows straddling non-positive NW).
  let worst5yrCagr = null;
  for (let t = 0; t + 5 < nw.length; t++) {
    const a = nw[t], b = nw[t + 5];
    if (a > 0 && b > 0) {
      const cagr = Math.pow(b / a, 1 / 5) - 1;
      worst5yrCagr = worst5yrCagr === null ? cagr : Math.min(worst5yrCagr, cagr);
    }
  }

  // Deepest peak-to-trough decline as a fraction of the running peak.
  let peak = -Infinity, maxDrawdown = 0;
  for (const v of nw) {
    if (v > peak) peak = v;
    if (peak > 0) maxDrawdown = Math.max(maxDrawdown, (peak - v) / peak);
  }

  const decadeNetWorthUsd = nw[Math.min(10, nw.length - 1)];

  // The trough of REAL net liquidity, and the year it happened in. A point with no
  // price level deflates by 1 rather than dropping out: an un-indexed series is then
  // a NOMINAL trough, which is a readable number, where skipping the point would
  // silently shorten the window a reserve is judged over.
  let minRealNetLiquidity = null, minRealNetLiquidityYear = null;
  // …and the deepest fall FROM A RUNNING PEAK, which is the ranking metric: the whole-path
  // floor is the opening balance on any plan still accumulating at t0, and no strategy can
  // change the opening balance.
  let liqPeak = null, deepest = 0;
  let troughRealNetLiquidity = null, troughRealNetLiquidityYear = null, troughRealDrawdown = null;
  for (const p of timeSeries ?? []) {
    if (typeof p.netLiquidity !== 'number' || !Number.isFinite(p.netLiquidity)) continue;
    const level = (typeof p.priceLevel === 'number' && p.priceLevel > 0) ? p.priceLevel : 1;
    const real  = p.netLiquidity / level;
    const year  = p.date?.getUTCFullYear?.() ?? null;

    if (minRealNetLiquidity === null || real < minRealNetLiquidity) {
      minRealNetLiquidity     = real;
      minRealNetLiquidityYear = year;
    }

    if (liqPeak === null || real > liqPeak) liqPeak = real;
    // Ties go to the FIRST occurrence: on a path that runs dry the level sits at zero for
    // years, and the year the money ran out is the informative one.
    const fall = liqPeak > 0 ? (liqPeak - real) / liqPeak : 0;
    if (fall > deepest) {
      deepest = fall;
      troughRealNetLiquidity     = real;
      troughRealNetLiquidityYear = year;
      troughRealDrawdown         = fall;
    }
  }
  // A path that only ever rose has no fall from a peak. Its trough is its endpoint and its
  // drawdown is zero — reported as such, rather than as null, because "never fell" is an
  // answer and a null would drop the path out of every percentile.
  if (troughRealNetLiquidity === null && minRealNetLiquidity !== null) {
    const last = (timeSeries ?? []).filter(p => Number.isFinite(p.netLiquidity)).at(-1);
    const lvl  = (typeof last?.priceLevel === 'number' && last.priceLevel > 0) ? last.priceLevel : 1;
    troughRealNetLiquidity     = last.netLiquidity / lvl;
    troughRealNetLiquidityYear = last.date?.getUTCFullYear?.() ?? null;
    troughRealDrawdown         = 0;
  }

  // House-price path (design 75 §6.4 C). Characterize the appreciation PATH over the pre-sale
  // window only: once the house is sold its value drops to 0, which is a sale event, not a
  // market drawdown — so we truncate at the first zero that follows a positive value. This
  // isolates the sequence/timing risk on the binding asset (its realized CAGR and worst
  // peak-to-trough dip while still held) from the sale artifact.
  const houseSeries = (timeSeries ?? []).map(p => p.houseValueUsd ?? 0);
  let hStart = houseSeries.findIndex(v => v > 0);
  let houseCagr = null, houseMaxDrawdown = null;
  if (hStart >= 0) {
    let hEnd = hStart;
    while (hEnd + 1 < houseSeries.length && houseSeries[hEnd + 1] > 0) hEnd++;
    if (hEnd > hStart) {
      const a = houseSeries[hStart], b = houseSeries[hEnd];
      houseCagr = Math.pow(b / a, 1 / (hEnd - hStart)) - 1;
      let peak = -Infinity; houseMaxDrawdown = 0;
      for (let t = hStart; t <= hEnd; t++) {
        const v = houseSeries[t];
        if (v > peak) peak = v;
        if (peak > 0) houseMaxDrawdown = Math.max(houseMaxDrawdown, (peak - v) / peak);
      }
    }
  }

  return {
    netWorthCagr, worst5yrCagr, maxDrawdown, decadeNetWorthUsd, houseCagr, houseMaxDrawdown,
    minRealNetLiquidity, minRealNetLiquidityYear,
    troughRealNetLiquidity, troughRealNetLiquidityYear, troughRealDrawdown,
  };
}

/** Median of a numeric array (ignoring null/undefined/NaN); null when empty. */
function median(xs) {
  const v = xs.filter(x => x != null && Number.isFinite(x)).sort((a, b) => a - b);
  if (v.length === 0) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

/** Linear-interpolated percentile p∈[0,1] of a numeric array (ignoring null/NaN); null when empty. */
function percentile(xs, p) {
  const v = xs.filter(x => x != null && Number.isFinite(x)).sort((a, b) => a - b);
  if (v.length === 0) return null;
  if (v.length === 1) return v[0];
  const idx = p * (v.length - 1);
  const lo  = Math.floor(idx), hi = Math.ceil(idx);
  return lo === hi ? v[lo] : v[lo] + (v[hi] - v[lo]) * (idx - lo);
}

/**
 * Reduce a resolved variable list to a provenance record for the run summary.
 *
 * Answers "what world did these numbers come from?" — the question a failure rate
 * cannot be read without. Groups every variable by where its center came from (see
 * CENTER_SOURCES), plus the two sets that need calling out:
 *
 *   syntheticCenters — ENABLED variables centered on the MC template's hardcoded
 *                      mean because neither the scenario nor the param schema has a
 *                      value at that paramKey. Those paths are partly synthetic;
 *                      results must be labelled as such. Also warned to the console,
 *                      since nothing else would surface it.
 *   divergentCenters — centers deliberately set away from the scenario's own value.
 *                      Legitimate (that is what an override is for) but it means the
 *                      run is not centered on the plan as written.
 *
 * @param {Array}  variables                resolved variables from buildVariables()
 * @param {object} [layers]
 * @param {object} [layers.ownParams]       the loaded scenario's own param bag
 * @param {object} [layers.schemaDefaults]  key → schema defaultValue
 */
export function summarizeProvenance(variables, { ownParams = null, schemaDefaults = null } = {}) {
  const bySource = { scenario: [], schema: [], override: [], default: [] };
  const divergentCenters = [];
  const syntheticCenters = [];

  for (const v of variables) {
    // buildVariables can only report "resolvable in the merged bag or not"; the
    // runner knows WHICH layer answered, so it splits scenario-owned values from
    // schema defaults here — via the same function the MC panel's row tags use.
    const source = refineCenterSource(v, { ownParams, schemaDefaults });

    bySource[source]?.push(v.paramKey);
    if (v.centerDiverges) {
      divergentCenters.push({ paramKey: v.paramKey, center: v.center, scenarioValue: v.scenarioValue });
    }
    if (v.enabled && source === CENTER_SOURCES.DEFAULT) syntheticCenters.push(v.paramKey);
  }

  if (syntheticCenters.length > 0) {
    console.warn('[IntlRetirementMcRunner] sampling around FRAMEWORK DEFAULTS — the scenario '
      + `carries no value for: ${syntheticCenters.join(', ')}. Results are partly synthetic.`);
  }

  return {
    centersBySource: bySource,
    syntheticCenters,
    divergentCenters,
    /** True when every sampled center traces to the loaded scenario. */
    fromScenario: syntheticCenters.length === 0 && divergentCenters.length === 0,
  };
}

/**
 * Monte Carlo runner for the IntlRetirementScenario.
 *
 * Orchestrates n simulation runs, each with parameters perturbed by
 * configured statistical distributions.  The ServiceRegistry is reset
 * between runs so each run gets a clean simulation environment.
 *
 * Each run result includes:
 *   seed, params, finalNetWorthUsd, scenarioFailed,
 *   outOfFundsDate, cumulativeDeficit, deficitMonths
 *
 * The aggregate summary (from ScenarioRunner.summarize) includes:
 *   mean, p10, p50, p90, successRate, failureCount,
 *   medianOutOfFundsDate, p50Deficit, p90Deficit,
 *   p50DeficitMonths, p90DeficitMonths
 */
export class IntlRetirementMcRunner {
  /**
   * @param {object}                    opts
   * @param {number}                    [opts.n=100]          - Number of MC iterations.
   * @param {IntlRetirementMcConfig}    [opts.mcConfig]       - Config that generates the
   *                                                            variable list via buildVariables().
   * @param {Date}                      [opts.simStart]       - Simulation start date.
   * @param {Date}                      [opts.simEnd]         - Simulation end date.
   * @param {boolean}                   [opts.mix=false]      - Also record the per-year
   *        asset MIX on every path (design 82 §8). Off by default: it is a real cost
   *        (one allocation cube per sampled year) and only the allocation-distribution
   *        report reads it, so an ordinary solvency run should not pay for it.
   * @param {boolean}                   [opts.spending=false] - Also record the classified
   *        SPENDING summary on every path (design 89 §11.1 phase 6). Off by default for
   *        the same reason as `mix`, but the price is far higher and worth stating: a
   *        spending cube is built from `stateDiff`, which only exists at
   *        `telemetry: 'full'`, so switching this on takes an iteration from ~530 ms to
   *        ~3,960 ms on the reference plan — **7.5x**. A `journal`-level run is NOT a
   *        cheaper middle: it produces entries whose `stateDiff` is null, and the cube
   *        silently computes zero. See spending-distribution.js.
   * @param {boolean} [opts.parallel=false] - Run the iterations on a Web Worker pool
   *        instead of the main thread (design 89 §21.7). Opt-in, and ignored where
   *        `Worker` does not exist, so every existing caller keeps its current path.
   *        The pool is created per `run()` and torn down after it; a caller that runs
   *        MC repeatedly should pass `workerPool` instead and pay the worker startup
   *        (the whole scenario module graph, per worker) once.
   * @param {import('./parallel/mc-worker-pool.js').McWorkerPool} [opts.workerPool] -
   *        A pool to reuse. Caller-owned: this runner never terminates it.
   */
  constructor({
    n           = 100,
    mcConfig    = new IntlRetirementMcConfig(),
    simStart    = new Date(Date.UTC(2026, 0, 1)),
    simEnd      = new Date(Date.UTC(2041, 0, 1)),
    cfgTemplate = null,
    mix         = false,
    spending    = false,
    parallel    = false,
    workerPool  = null,
  } = {}) {
    this.n           = n;
    this.mcConfig    = mcConfig;
    this.simStart    = simStart;
    this.simEnd      = simEnd;
    this.cfgTemplate = cfgTemplate;
    this.mix         = mix;
    this.spending    = spending;
    this._parallel   = parallel;
    this._pool       = workerPool;    // caller-owned: never terminated here
    this._ownsPool   = false;
  }

  /**
   * Resolve the world every iteration runs in: the serialized template, the layered
   * base params, the variable list and its provenance.
   *
   * Split out of `run` because this is exactly the part that must happen ONCE, on the
   * main thread, and then travel to every worker unchanged. A worker that re-derived
   * any of it would be rolling a different world than its siblings — the failure mode
   * `rolloutContext` calls "only reproduces single-threaded".
   *
   * @returns {{ ctx: import('./parallel/mc-worker-core.js').McIterationContext, provenance: object }}
   */
  _prepare(baseParams = {}) {
    const simStart = this.simStart;
    const simEnd   = this.simEnd;

    // Design 15 §2.3: the active scenario cfg is the per-iteration template.
    // Fallback to a fresh defaults cfg for tests / library consumers that don't
    // wire a ServiceRegistry-backed active scenario.
    //
    // Pipe through serializeScenario so the template is a plain JSON-safe object
    // (no functions / class refs); registry entries carry `factory` and
    // `scenarioClass` which `structuredClone` would reject. That is also precisely
    // what makes the template postMessage-able to a worker.
    const rawTemplate = this.cfgTemplate
      ?? IntlRetirementScenario.buildDefaultConfig({}, simStart, simEnd);
    const cfgTemplate = ScenarioSerializer.serializeScenario(rawTemplate);
    // Read the template's params from the RAW record: serializeScenario carries the
    // typed `params` list but not the `parameters` bag, and a cfg straight out of
    // buildDefaultConfig() has only the bag — so reading the serialized copy would
    // see no params at all for that (very common) source.
    const templateParams = scenarioParamValues(rawTemplate);

    // ── The base world every variable is centered on ─────────────────────────
    //
    // Layered weakest-first. The TEMPLATE'S OWN PARAMS are what make an MC run
    // describe the LOADED SCENARIO rather than the framework's library defaults:
    // without them buildVariables() resolves no scenario value for any paramKey and
    // every center falls back to the hardcoded mean in DEFAULT_MC_VARIABLE_CONFIGS —
    // a plan assuming 10% equity returns gets sampled around 5%, and, worse because
    // it is completely silent, a *disabled* lever writes that default into params,
    // overwriting the scenario's real value in cfg.parameters. They also carry
    // `shocks` and every visibleWhen controller, so per-shock rows get built and
    // strategy-gated variables aren't wrongly hidden.
    //
    //   1. schema defaults  — what ScenarioLoader materializes for keys the cfg
    //                         doesn't carry, i.e. what the sim will actually run at.
    //   2. template params  — the loaded scenario's own values.
    //   3. balance centers  — a holdings-bearing account's balance is derived from
    //                         its holdings, not a plain param, so the account record
    //                         beats the params bag (design 55 §13).
    //   4. baseParams       — an explicit caller override wins over all of them.
    const schemaDefaults = paramSchemaDefaults(IntlRetirementScenario.buildFullParamSchema());
    const balanceCenters = resolveBalanceCenters(cfgTemplate);
    const base = { ...schemaDefaults, ...templateParams, ...balanceCenters, ...baseParams, endDate: simEnd };
    const variables  = this.mcConfig.buildVariables(base);
    const provenance = summarizeProvenance(variables, { ownParams: templateParams, schemaDefaults });

    return {
      ctx: { cfgTemplate, base, variables, simStart, simEnd, mix: this.mix, spending: this.spending },
      provenance,
    };
  }

  /**
   * Should this batch run on a worker pool?
   *
   * Three ways to answer no, and the third is the interesting one:
   *   - no pool was asked for (the default: an explicit opt-in keeps every existing
   *     caller — the lab scripts, the decision-graph runner, every test — on the
   *     exact path they run on today);
   *   - the environment has no `Worker` (Node without an injected spawn, SSR);
   *   - **a subclass overrides `_perturb`**. `_OffsetSeedMcRunner`
   *     (`decision-graph/decision-graph-runner.js`) does, to give each leaf its own
   *     seed space. A worker perturbs from the shared `perturbParams`, so it cannot
   *     see that override and would silently sample a different world. Detecting it
   *     and staying serial is the honest answer; the alternative — putting the offset
   *     in the context — is a real option if a decision graph ever needs the speed.
   */
  _poolFor(pool) {
    if (!pool) return null;
    if (this._perturb !== IntlRetirementMcRunner.prototype._perturb) {
      console.warn('[IntlRetirementMcRunner] `_perturb` is overridden; running MC serially. '
        + 'A worker cannot see the override and would sample a different world.');
      return null;
    }
    return pool;
  }

  /**
   * Run every iteration, in parallel when a pool is available and serially otherwise.
   *
   * The two paths call the SAME `buildIterationRunner`, so they agree by construction
   * rather than by review: iterations are independent and index-seeded, so a sharded
   * run is bit-identical to an ordered one.
   */
  async _runIterations(ctx, onProgress) {
    const pool = this._poolFor(this._resolvePool());
    if (pool) {
      try {
        pool.setContext(ctx);
        // Progress is reported in COMPLETION order (a count, not an index) — the one
        // thing that genuinely changes when the loop is sharded.
        return await pool.map(
          Array.from({ length: this.n }, (_, i) => i),
          { onSettled: onProgress },
        );
      } finally {
        if (this._ownsPool) { pool.terminate(); this._pool = null; this._ownsPool = false; }
      }
    }

    const iter   = buildIterationRunner(ctx);
    const mcRuns = [];
    for (let i = 0; i < this.n; i++) {
      // `this._perturb`, not the shared function, so a subclass override still governs
      // this path (see `_poolFor`).
      mcRuns.push(iter.runIteration(i, this._perturb(ctx.base, i, ctx.variables)));
      if (onProgress) onProgress(i + 1, this.n);
      // Yield to the browser so the UI stays responsive and progress is painted.
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    return mcRuns;
  }

  /**
   * The pool this batch will use, if any: a caller-supplied one (reused across runs
   * and terminated by its owner), or one this runner creates and tears down when
   * `parallel` was requested and the environment actually has workers.
   */
  _resolvePool() {
    if (this._pool) return this._pool;
    if (!this._parallel || typeof Worker === 'undefined') return null;
    this._pool     = new McWorkerPool();
    this._ownsPool = true;
    return this._pool;
  }

  /**
   * Run n Monte Carlo iterations asynchronously.
   *
   * Serially by default, yielding to the browser between iterations so the UI stays
   * responsive; on a worker pool when one is configured (`parallel` / `workerPool`),
   * which takes the sims off the main thread entirely. The results are identical
   * either way — see `_runIterations`.
   *
   * @param {object}   [baseParams={}]  - Scenario params that override defaults.
   * @param {Function} [onProgress]     - Called with (completed, total) after each run.
   *        On the parallel path this counts COMPLETIONS, not indices.
   * @returns {Promise<{ runs: Array, summary: object }>}
   */
  async run(baseParams = {}, onProgress) {
    const { ctx, provenance } = this._prepare(baseParams);
    const mcRuns = await this._runIterations(ctx, onProgress);

    // `summarize` is stateless w.r.t. the two closures a ScenarioRunner is built from,
    // and on the parallel path this thread never builds one — so the aggregation gets
    // its own bare instance rather than reaching into the iteration runner.
    const summary = new ScenarioRunner({}).summarize(
      mcRuns,
      r => r.result.finalNetWorthUsd,
      r => ({
        failed:            r.result.scenarioFailed,
        outOfFundsDate:    r.result.outOfFundsDate,
        cumulativeDeficit: r.result.cumulativeDeficit,
        deficitMonths:     r.result.deficitMonths,
      })
    );

    const runs = mcRuns.map(r => ({
      seed:              r.seed,
      params:            r.params,
      finalNetWorthUsd:  r.result.finalNetWorthUsd,
      afterTaxNetWorthUsd: r.result.afterTaxNetWorthUsd,
      cumulativeTaxesPaid: r.result.cumulativeTaxesPaid,
      finalNetLiquidity: r.result.finalNetLiquidity,
      scenarioFailed:    r.result.scenarioFailed,
      outOfFundsDate:    r.result.outOfFundsDate,
      cumulativeDeficit: r.result.cumulativeDeficit,
      deficitMonths:     r.result.deficitMonths,
      timeSeries:        r.result.timeSeries,
      pathShape:         computePathShape(r.result.timeSeries),
      lifetimeRepairSpend: r.result.lifetimeRepairSpend ?? 0,
      // Design 89 phase 6. `runs` is an explicit projection, not a spread of `evaluate`'s
      // result — a field added there and not listed here is silently dropped, which is
      // exactly what happened on the first attempt at this one.
      spending:          r.result.spending ?? null,
    }));

    // Sequence-of-returns readout (design 74 §5.2). Mark each path against the
    // cross-path median net worth at ~10 years, then split the failure rate by it: if
    // a below-median first decade carries a materially higher failure rate, the risk
    // that's biting IS sequence-of-returns, not the terminal average. This is the
    // number §5.2 calls "the one worth reporting".
    const medianDecadeNetWorthUsd = median(runs.map(r => r.pathShape.decadeNetWorthUsd));
    let belowN = 0, belowFail = 0, aboveN = 0, aboveFail = 0;
    if (medianDecadeNetWorthUsd != null) {
      for (const r of runs) {
        const d = r.pathShape.decadeNetWorthUsd;
        if (d == null) continue;
        const below = d < medianDecadeNetWorthUsd;
        if (below) { belowN++; if (r.scenarioFailed) belowFail++; }
        else       { aboveN++; if (r.scenarioFailed) aboveFail++; }
        r.firstDecadeBelowMedian = below;
      }
    }
    summary.pathShape = {
      medianNetWorthCagr:      median(runs.map(r => r.pathShape.netWorthCagr)),
      medianWorst5yrCagr:      median(runs.map(r => r.pathShape.worst5yrCagr)),
      medianMaxDrawdown:       median(runs.map(r => r.pathShape.maxDrawdown)),
      medianDecadeNetWorthUsd,
      failureRateBelowMedianDecade: belowN ? belowFail / belowN : null,
      failureRateAboveMedianDecade: aboveN ? aboveFail / aboveN : null,
      // House-price path + lifetime repair spend across runs (design 75 §6.4 C). The house
      // CAGR/drawdown medians characterize the appreciation path of the binding asset; the
      // repair-spend percentiles show the fat right tail of the lumpy holding cost.
      medianHouseCagr:         median(runs.map(r => r.pathShape.houseCagr)),
      medianHouseMaxDrawdown:  median(runs.map(r => r.pathShape.houseMaxDrawdown)),
      medianRepairSpend:       median(runs.map(r => r.lifetimeRepairSpend)),
      p90RepairSpend:          percentile(runs.map(r => r.lifetimeRepairSpend), 0.90),
      p10RepairSpend:          percentile(runs.map(r => r.lifetimeRepairSpend), 0.10),
      // The reserve metric (design 97 §18). p10 is reported alongside the median because
      // the question a liquidity pool answers is about the BAD tail — a median trough
      // moves barely at all between pool shapes, and the arms separate at the bottom.
      medianMinRealNetLiquidity: median(runs.map(r => r.pathShape.minRealNetLiquidity)),
      p10MinRealNetLiquidity:    percentile(runs.map(r => r.pathShape.minRealNetLiquidity), 0.10),
      medianTroughRealNetLiquidity: median(runs.map(r => r.pathShape.troughRealNetLiquidity)),
      p10TroughRealNetLiquidity:    percentile(runs.map(r => r.pathShape.troughRealNetLiquidity), 0.10),
    };

    // Provenance of the sampled world (see summarizeProvenance). Carried on the
    // summary so a report can state what these numbers describe instead of the
    // reader having to assume it was their plan.
    summary.provenance = provenance;

    return { runs, summary };
  }

  /**
   * Produce a perturbed parameter object for iteration i.
   *
   * Deep-clones baseParams so nested writes (e.g. shocks[N].severity) never
   * leak back into the live scenario or adjacent iterations.
   *
   * For every variable in the resolved list:
   *   - Enabled: sample from its distribution and write via set().
   *   - Disabled: if the path is absent from baseParams, fill the reference
   *     value (cfg.value ?? cfg.mean) so r.params is self-contained.
   */
  _perturb(baseParams, i, variables) {
    return perturbParams(baseParams, i, variables);
  }
}
