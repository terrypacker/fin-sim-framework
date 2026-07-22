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
import { createDistribution }         from '../../simulation-framework/distributions.js';
import { ServiceRegistry }            from '../../services/service-registry.js';
import { IntlRetirementScenario, applyRealPropertySaleYearParams, resolveBalanceCenters } from '../../scenarios/intl-retirement-scenario.js';
import { ScenarioLoader }             from '../../scenarios/scenario-loader.js';
import { ScenarioSerializer }         from '../../scenarios/scenario-serializer.js';
import { IntlRetirementMcConfig }     from './intl-retirement-mc-config.js';
import { get, set }                   from './mc-param-paths.js';
import { computeNetWorth }            from '../derived-metrics/net-worth.js';
import { computeNetLiquidity }        from '../derived-metrics/net-liquidity.js';

/** @deprecated Use computeNetWorth from derived-metrics/net-worth.js */
export function computeNetWorthUsd(state) {
  return computeNetWorth(state, 'USD');
}

/**
 * Gross USD value of all real-property holdings in `state` (design 75 §6.4 C). Unlike
 * computeNetWorth this sums the *gross* `value` (not equity), FX-converted to USD, because the
 * house-appreciation PATH we want to characterize is the value series, independent of the
 * mortgage. Returns 0 when no property exists (or all sold ⇒ value 0).
 */
export function computeHouseValueUsd(state, baseCurrency = 'USD') {
  let total = 0;
  for (const val of Object.values(state)) {
    if (val == null || typeof val !== 'object') continue;
    if (val.kind !== 'real-property' || typeof val.value !== 'number') continue;
    const currency = val.currency?.code ?? val.currency ?? baseCurrency;
    if (currency === baseCurrency) { total += val.value; continue; }
    const rate = state.effectiveExchangeRates?.[`${baseCurrency}_${currency}`] ?? 1;
    total += val.value / rate;
  }
  return total;
}

/**
 * Extract one net worth data point per year from sim history snapshots.
 * Takes the last snapshot within each calendar year.
 */
function extractYearlyTimeSeries(sim) {
  const byYear = new Map();
  for (const snap of sim.history.snapshots) {
    const year = snap.date.getUTCFullYear();
    byYear.set(year, snap);
  }
  return [...byYear.entries()]
    .sort(([a], [b]) => a - b)
    .map(([year, snap]) => ({
      date:         new Date(Date.UTC(year, 0, 1)),
      netWorthUsd:  computeNetWorthUsd(snap.state),
      netLiquidity: computeNetLiquidity(snap.state, snap.date),
      houseValueUsd: computeHouseValueUsd(snap.state),
    }));
}

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
 */
export function computePathShape(timeSeries) {
  const nw = (timeSeries ?? []).map(p => p.netWorthUsd);
  const empty = {
    netWorthCagr: null, worst5yrCagr: null, maxDrawdown: null, decadeNetWorthUsd: null,
    houseCagr: null, houseMaxDrawdown: null,
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

  return { netWorthCagr, worst5yrCagr, maxDrawdown, decadeNetWorthUsd, houseCagr, houseMaxDrawdown };
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
 * Standalone seeded PRNG — same algorithm as Simulation.createRNG().
 * Used to produce per-iteration reproducible samples from distributions.
 */
function makeSeededRng(seed) {
  let s = seed;
  return () => {
    s = Math.trunc(s + 0x6D2B79F5);
    let t = Math.imul(s ^ s >>> 15, 1 | s);
    t ^= t + Math.imul(t ^ t >>> 7, 61 | t);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
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
   */
  constructor({
    n           = 100,
    mcConfig    = new IntlRetirementMcConfig(),
    simStart    = new Date(Date.UTC(2026, 0, 1)),
    simEnd      = new Date(Date.UTC(2041, 0, 1)),
    cfgTemplate = null,
  } = {}) {
    this.n           = n;
    this.mcConfig    = mcConfig;
    this.simStart    = simStart;
    this.simEnd      = simEnd;
    this.cfgTemplate = cfgTemplate;
  }

  /**
   * Run n Monte Carlo iterations asynchronously, yielding to the browser
   * between each iteration so the UI stays responsive.
   *
   * @param {object}   [baseParams={}]  - Scenario params that override defaults.
   * @param {Function} [onProgress]     - Called with (completed, total) after each run.
   * @returns {Promise<{ runs: Array, summary: object }>}
   */
  async run(baseParams = {}, onProgress) {
    const simStart = this.simStart;
    const simEnd   = this.simEnd;

    // Design 15 §2.3: the active scenario cfg is the per-iteration template.
    // Fallback to a fresh defaults cfg for tests / library consumers that don't
    // wire a ServiceRegistry-backed active scenario.
    //
    // Pipe through serializeScenario so the template is a plain JSON-safe object
    // (no functions / class refs); registry entries carry `factory` and
    // `scenarioClass` which `structuredClone` would reject.
    const rawTemplate = this.cfgTemplate
      ?? IntlRetirementScenario.buildDefaultConfig({}, simStart, simEnd);
    const cfgTemplate = ScenarioSerializer.serializeScenario(rawTemplate);

    const runner = new ScenarioRunner({
      createSimulation: (params, seed) => {
        // Isolated per-iteration registry: never touches the singleton, so the
        // user's active config graph + UI bindings stay intact across MC runs.
        const registry = new ServiceRegistry();
        const scenario = new IntlRetirementScenario({
          context: registry.simulationContext,
          params,
          simStart,
          simEnd,
        });
        // Per-iteration seed so each path draws its OWN in-loop stochastic sequence
        // (design 74 §5.2). Previously the seed was dropped here and every iteration
        // ran at the default seed 1 — so with a stochastic path ON, all iterations
        // drew the IDENTICAL return sequence and sequence-of-returns risk collapsed to
        // a single ordering. The seed is the ScenarioRunner iteration index (i + 1),
        // so a run is reproducible and the scalar-param sampling rng (makeSeededRng,
        // same index) and the in-loop path share the iteration.
        scenario.buildSim({ seed });

        const cfg = structuredClone(cfgTemplate);
        // Merge perturbed params into cfg.parameters so ScenarioLoader reads them.
        cfg.parameters = { ...(cfg.parameters ?? {}), ...params };
        // Patch real property sale years — toolsets read from cfg.realProperties, not cfg.parameters.
        applyRealPropertySaleYearParams(cfg, params);
        // Also update cfg.params entries if already populated (schema-drift guard path).
        if (Array.isArray(cfg.params)) {
          for (const p of cfg.params) {
            if (params[p.name] !== undefined) p.value = params[p.name];
          }
        }
        new ScenarioLoader().load(cfg, registry);

        scenario.sim.silent = true;           // skip bus, clones, diffs — not needed in MC
        scenario.sim.journal.enabled = false; // skip journal — not needed in MC (would waste memory)
        return scenario.sim;
      },
      evaluate: (sim) => ({
        finalNetWorthUsd:  computeNetWorthUsd(sim.state),
        finalNetLiquidity: computeNetLiquidity(sim.state, simEnd),
        scenarioFailed:    sim.state.scenarioFailed    ?? false,
        outOfFundsDate:    sim.state.outOfFundsDate    ?? null,
        cumulativeDeficit: sim.state.cumulativeDeficit ?? 0,
        deficitMonths:     sim.state.deficitMonths     ?? 0,
        timeSeries:        extractYearlyTimeSeries(sim),
        // Lifetime stochastic house-repair spend (design 75 §6.4 C), native property currency
        // summed across properties. Already accumulated in state by HouseRepairApplyReducer.
        lifetimeRepairSpend: sim.state.houseRepairSpendingTotal ?? 0,
      }),
    });

    // Center each balance MC lever on the template's live account balance (design 55 §13).
    // Without this a *disabled* balance lever's self-contained fallback (cfg.value ?? mean,
    // a hardcoded default) would be written to params and rescale the account's holdings —
    // silently resetting a customized balance. Merged under baseParams so an explicit caller
    // override still wins.
    const balanceCenters = resolveBalanceCenters(cfgTemplate);
    const base      = { ...balanceCenters, ...baseParams, endDate: simEnd };
    const variables = this.mcConfig.buildVariables(base);

    const mcRuns  = [];
    for (let i = 0; i < this.n; i++) {
      const params = this._perturb(base, i, variables);
      const result = runner.runScenario(params, i + 1);
      mcRuns.push({ seed: i + 1, params, result });
      if (onProgress) onProgress(i + 1, this.n);
      // Yield to the browser so the UI stays responsive and progress is painted.
      await new Promise(resolve => setTimeout(resolve, 0));
    }

    const summary = runner.summarize(
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
      finalNetLiquidity: r.result.finalNetLiquidity,
      scenarioFailed:    r.result.scenarioFailed,
      outOfFundsDate:    r.result.outOfFundsDate,
      cumulativeDeficit: r.result.cumulativeDeficit,
      deficitMonths:     r.result.deficitMonths,
      timeSeries:        r.result.timeSeries,
      pathShape:         computePathShape(r.result.timeSeries),
      lifetimeRepairSpend: r.result.lifetimeRepairSpend ?? 0,
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
    const rng       = makeSeededRng(i + 1);
    const perturbed = structuredClone(baseParams);

    for (const cfg of variables) {
      if (cfg.enabled) {
        set(perturbed, cfg.paramKey, createDistribution(cfg).sample(rng));
      } else if (get(baseParams, cfg.paramKey) === undefined) {
        set(perturbed, cfg.paramKey, cfg.value ?? cfg.mean);
      }
    }

    return perturbed;
  }
}
