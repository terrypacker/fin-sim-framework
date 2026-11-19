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
import { IntlRetirementScenario } from '../../scenarios/intl-retirement-scenario.js';
import { ScenarioSerializer }         from '../../scenarios/scenario-serializer.js';
import { resolveAliasCenters, resolveRecordCenters } from '../../scenarios/scenario-param-apply.js';
import { withLiquidityAxisCenters } from '../pools/pool-target-scale.js';
import { IntlRetirementMcConfig, variablesMissingCenter } from './intl-retirement-mc-config.js';
import { McRunner, summarizeProvenance, median, percentile } from './mc-runner.js';
import { scenarioParamValues, paramSchemaDefaults } from '../param-schema-utils.js';
import { samplingSignature, mcEquityModel, mcEquityWindow, mcEquityStart, mcInflationModel, mcPrimeModel, applyMcPaths, mcReturnPaths } from './parallel/mc-worker-core.js';
import { stockBondCorrelationWarnings } from '../economic-regimes/stock-bond-correlation.js';
import { migrateYearFieldsToDates, migrateParamBag } from '../../scenarios/year-date-migration.js';

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
// The scenario-agnostic batch moved to ./mc-runner.js (design 134 §4); this stays importable.
export { summarizeProvenance };

/**
 * Levers that every path of this batch ignores, as messages (design 129 §3.4). The loader
 * checks the plan as written, but Monte Carlo swaps in its own processes per path (most
 * often `mcInflationModel: AUTO` ⇒ HISTORICAL_JOINT), so only the runner can see that a lever
 * is dead under them. Checked on the base with MC's switches applied; a lever the MC samples
 * counts as set. Also warned to the console, the way `summarizeProvenance` warns.
 *
 * @param {object} base       the batch's layered base params
 * @param {Array}  variables  resolved variables from buildVariables()
 * @returns {string[]}
 */
export function mcInertWarnings(base, variables) {
  const sampled  = (key) => variables.some(v => v.enabled && v.paramKey === key);
  const warnings = stockBondCorrelationWarnings(applyMcPaths({ ...base }),
    { mc: true, sampled: sampled('stockBondCorrelation') });
  for (const w of warnings) console.warn(`[IntlRetirementMcRunner] ${w}`);
  return warnings;
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
export class IntlRetirementMcRunner extends McRunner {
  static scenarioKind = 'intl-retirement';

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
   *        spending cube is built from `stateDiff`, which only exists on a non-silent
   *        run (`telemetry: 'diffs'`), so switching this on takes an iteration from
   *        ~530 ms to ~3,960 ms on the reference plan — **7.5x**. A `journal`-level run
   *        is NOT a cheaper middle: it produces entries whose `stateDiff` is null, and
   *        the cube silently computes zero. See spending-distribution.js.
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
    super({ n, mcConfig, simStart, simEnd, cfgTemplate, parallel, workerPool });
    this.mix         = mix;
    this.spending    = spending;
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
    // Design 117: convert sale years to dates BEFORE the template is read or serialized,
    // so its params, record centers and every worker's copy agree on one shape.
    migrateYearFieldsToDates(rawTemplate);
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
    //   2. record centers   — each record lever's value on its record, under its generated
    //                         key: the only source for a hidden `balanceTarget` and for
    //                         every record lever of an unloaded template.
    //   3. template params  — the loaded scenario's own values; fresher than a record.
    //   4. baseParams       — an explicit caller override wins over all of them.
    const schemaDefaults = paramSchemaDefaults(IntlRetirementScenario.buildFullParamSchema());
    const recordCenters  = resolveRecordCenters(rawTemplate);
    // Legacy-keyed levers (the wages) centre on their generated
    // successor's value — a loaded cfg carries only that one.
    const aliasCenters   = resolveAliasCenters(rawTemplate);
    // Leg C's axes (a pool size factor, a gate threshold, a gate dwell) are hidden generated
    // params: absent from the schema defaults, and from `cfg.params` unless authored, so
    // nothing above carries their plan value. Without it a grid on one has no reference cell
    // and a disabled row has no centre (design 110 §6.2 / §6.3). The centres only FILL a
    // missing key: an authored factor is the plan value (design 131 phase 4).
    const base = withLiquidityAxisCenters({ ...schemaDefaults, ...recordCenters, ...templateParams,
                   ...aliasCenters, ...migrateParamBag(baseParams), endDate: simEnd }, rawTemplate);
    // Harvest from the raw template: its records carry the generated per-record params
    // (design 98 W3). Once, here on the main thread — workers get resolved `variables`.
    const variables  = this.mcConfig.buildVariables(base, { cfg: rawTemplate });
    const centerless = variablesMissingCenter(variables);
    if (centerless.length) {
      throw new Error('Monte Carlo cannot sample an enabled variable with no center: '
        + centerless.map(v => v.label ?? v.paramKey).join(', ')
        + '. The plan leaves it unset — type a mean to sample around, or disable it.');
    }
    const provenance = summarizeProvenance(variables, { ownParams: templateParams, schemaDefaults });
    provenance.inertWarnings = mcInertWarnings(base, variables);

    return {
      ctx: { cfgTemplate, base, variables, simStart, simEnd, mix: this.mix, spending: this.spending,
             scenarioKind: IntlRetirementMcRunner.scenarioKind },
      provenance,
    };
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
    // A path that threw is excluded loudly (`_runAll`) and listed on `summary.erroredRuns`.
    const { ctx, provenance, mcRuns, erroredRuns } = await this._runAll(baseParams, onProgress);

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
      terminalRates:     r.result.terminalRates ?? null,   // design 79 §9
      shockArrivals:     r.result.shockArrivals ?? null,   // design 126 §3.5
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
      // Which equity process the paths ran (design 102 §7 Q3); null when the path is off.
      equityModel:    mcEquityModel(ctx.base),
      // And the historical years the bootstrap sampled (design 133); null off the bootstrap.
      equityWindow:   mcEquityWindow(ctx.base),
      // And a pinned opening run, '<year>+<years>' (design 133 §4.2); null when none.
      equityStart:    mcEquityStart(ctx.base),
      // And the inflation process (design 103 §6); null when the path is off.
      inflationModel: mcInflationModel(ctx.base),
      // And the prime rate mode (design 104).
      primeModel:     mcPrimeModel(ctx.base),
    };
    // The return processes and historical years the batch ran, in full (design 133), so the
    // results say what they were run with after the plan has moved on. The pairing fields
    // above are the comparison keys; this is the readable record.
    try { summary.returnPaths = mcReturnPaths(ctx.base); } catch { summary.returnPaths = null; }

    return { runs, summary };
  }

}
