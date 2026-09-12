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
import { buildIterationRunner, perturbParams, samplingSignature } from './parallel/mc-worker-core.js';
import { McWorkerPool }              from './parallel/mc-worker-pool.js';

// What a path records lives in ./mc-sampling.js so the worker core can import it
// without importing this module (which owns the BATCH: param layering, provenance,
// aggregation). Re-exported here because these were this module's public API before
// the split — `src/index.js` and existing callers import them from here.
export {
  computeNetWorthUsd, computeHouseValueUsd, MC_SAMPLER_CADENCE, createMcSampler,
  extractYearlyTimeSeries, computePathShape,
} from './mc-sampling.js';
// Used by `run` below too, and a re-export does not bind a local name.
import { computePathShape } from './mc-sampling.js';

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
    // Harvest from the raw template: its records carry the generated per-record params
    // (design 98 W3). Once, here on the main thread — workers get resolved `variables`.
    const variables  = this.mcConfig.buildVariables(base, { cfg: rawTemplate });
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
    const allRuns = await this._runIterations(ctx, onProgress);
    // A path that threw carries no result, so it cannot enter the statistics — but dropping
    // it silently would report a success rate over n − k paths as if it were n. It is
    // excluded loudly instead: logged here and listed on `summary.erroredRuns`.
    const erroredRuns = allRuns.filter(r => r.error);
    const mcRuns      = allRuns.filter(r => !r.error);
    for (const r of erroredRuns) {
      console.error(`[IntlRetirementMcRunner] path seed=${r.seed} threw and is excluded from the results: `
        + r.error.message);
    }

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

    // Paths that threw, with their seed and params so each can be replayed on its own.
    summary.erroredRuns = erroredRuns.map(r => ({ seed: r.seed, params: r.params, message: r.error.message }));

    // The facts that define this batch's random stream (design 100 §5–6), so a later
    // batch can be checked for pairing against this one instead of assumed paired. On
    // the result itself rather than kept by the caller: it then travels with the result
    // across a rebuild, and nothing has to reconstruct what the batch ran with.
    summary.pairing = {
      n:              runs.length,
      seeds:          runs.map(r => r.seed),
      sampled:        samplingSignature(ctx.variables),
      mcSequenceRisk: ctx.base.mcSequenceRisk !== false,
    };

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
