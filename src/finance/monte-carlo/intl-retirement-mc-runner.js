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
import { IntlRetirementMcConfig, CENTER_SOURCES, refineCenterSource } from './intl-retirement-mc-config.js';
import { scenarioParamValues, paramSchemaDefaults } from '../param-schema-utils.js';
import { get, set }                   from './mc-param-paths.js';
import { computeNetWorth }            from '../derived-metrics/net-worth.js';
import { computeAfterTaxNetWorth, afterTaxOptionsFromParams } from '../derived-metrics/after-tax.js';
import { computeNetLiquidity }        from '../derived-metrics/net-liquidity.js';
import { toBaseCurrency, currencyOf } from '../fx/to-base-currency.js';
import { buildAllocationCube }        from '../allocation-reporting/allocation-cube.js';
import { mixPoint, MIX_CLASSES }      from '../allocation-reporting/mix-distribution.js';

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
    // Shared valuation convention (design 82 §5.1a) — the house series and the net
    // worth it is compared against must price AUD the same way.
    total += toBaseCurrency(val.value, currencyOf(val, baseCurrency), baseCurrency, state);
  }
  return total;
}

/**
 * Sampler for the per-iteration time series (design 78 §4.5).
 *
 * The metrics an MC path needs are computed here, at sample time, from live state —
 * instead of deep-cloning the entire state so they can be computed later. That is
 * 1,803 full-state clones per iteration replaced by ~45 records of a few numbers, and
 * it is the whole of MC's remaining telemetry cost.
 *
 * Runs at the YEAR-BOUNDARY cadence (design 82 §4): the state after the last event
 * dated in year Y, which is the same instant the lab page and the workbench panel
 * sample, so a share means the same thing in all three. Must not retain references
 * into `state` — it returns numbers only.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.mix=false] also record the asset MIX (design 82 §8.1). Costs
 *        one cube build per sample; see §8.3 on why it is measured, not assumed cheap.
 */
/**
 * The cadence every MC `timeSeries` — and therefore every `pathShape` — is recorded
 * on (design 82 §4/§8.3). Exported so an arm artifact can STAMP it: the switch off
 * design 78's event cadence re-baselined the recorded series without changing a
 * single run outcome, so an old arm JSON and a new one look equally well-formed and
 * are silently not comparable. A stamp turns "remember not to compare across that
 * boundary" into something a reader can check — see `mc-run.mjs` / `mc-report.mjs`.
 */
export const MC_SAMPLER_CADENCE = 'year-boundary';

export function createMcSampler({ mix = false, baseCurrency = 'USD' } = {}) {
  return function sampleTimeSeriesPoint(state, date) {
    const point = {
      date:          new Date(date),
      netWorthUsd:   computeNetWorth(state, baseCurrency),
      netLiquidity:  computeNetLiquidity(state, date),
      houseValueUsd: computeHouseValueUsd(state, baseCurrency),
    };
    if (!mix) return point;

    // Built through the SHARED cube + pivot, never a private sum: design 82 §8.1's
    // whole point is that an MC share and a lab-page share are the same quantity.
    // `displayNameFor` is deliberately absent — a mix needs no account labels, and MC
    // runs on an isolated per-iteration registry with nothing named.
    const rows = buildAllocationCube(state, { date, baseCurrency });
    const { grossAssets, mix: shares } = mixPoint(rows, { classes: MIX_CLASSES });
    point.grossAssetsUsd = grossAssets;
    point.mix            = shares;
    return point;
  };
}

/**
 * Reduce the sampler's records to one data point per year.
 *
 * Under the year-boundary cadence there is already exactly one record per calendar
 * year, so this is now a re-stamp rather than a reduction: the date is normalized to
 * 1 January of the sampled year so every path's series lands on IDENTICAL timestamps.
 * The MC fan chart groups by exact timestamp (`mc-results-panel._buildFanData`), so a
 * per-path stamp — 31 December for a boundary sample, the horizon for a terminal
 * flush — would split one year into two columns of one path each.
 *
 * The label therefore names the year the state belongs to, not the instant it was read
 * at; that was already true under the event cadence and is unchanged here.
 */
function extractYearlyTimeSeries(sim) {
  const byYear = new Map();
  for (const sample of sim.samples) {
    byYear.set(sample.date.getUTCFullYear(), sample);
  }
  return [...byYear.entries()]
    .sort(([a], [b]) => a - b)
    .map(([year, sample]) => ({
      date:          new Date(Date.UTC(year, 0, 1)),
      netWorthUsd:   sample.netWorthUsd,
      netLiquidity:  sample.netLiquidity,
      houseValueUsd: sample.houseValueUsd,
      ...(sample.mix ? { grossAssetsUsd: sample.grossAssetsUsd, mix: sample.mix } : {}),
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
   */
  constructor({
    n           = 100,
    mcConfig    = new IntlRetirementMcConfig(),
    simStart    = new Date(Date.UTC(2026, 0, 1)),
    simEnd      = new Date(Date.UTC(2041, 0, 1)),
    cfgTemplate = null,
    mix         = false,
  } = {}) {
    this.n           = n;
    this.mcConfig    = mcConfig;
    this.simStart    = simStart;
    this.simEnd      = simEnd;
    this.cfgTemplate = cfgTemplate;
    this.mix         = mix;
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
    const sampler  = createMcSampler({ mix: this.mix });

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
    // Read the template's params from the RAW record: serializeScenario carries the
    // typed `params` list but not the `parameters` bag, and a cfg straight out of
    // buildDefaultConfig() has only the bag — so reading the serialized copy would
    // see no params at all for that (very common) source.
    const templateParams = scenarioParamValues(rawTemplate);

    // After-tax scoring options (design 84 §6.4a). Assigned below, once `base` is
    // resolved — `evaluate` cannot close over it directly because the ScenarioRunner is
    // constructed before the param layering runs, and `evaluate` only ever fires inside
    // the iteration loop that follows. These are METRIC params (rate method, assumed
    // gain fraction), not economic ones, so they are not perturbed per path and one
    // provider is correct for the whole run.
    let afterTaxOpts = afterTaxOptionsFromParams({});

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
        // telemetry 'off' + a sampler: MC needs no bus, journal or full-state
        // history snapshots — only the yearly series, which the sampler collects
        // directly (design 78 §4.5).
        //
        // The cadence is 'year-boundary' (design 82 §4/§8.3), NOT the event cadence
        // design 78 shipped with. Design 78 picked the event cadence for cheapness, and
        // it lands the "yearly" point at whatever event happened to be last in the year
        // — mid-something, and drifting with event volume. A MIX is precisely sensitive
        // to whether the year-end rebalance has fired, so an arbitrary instant is not an
        // option here; and having MC sample somewhere the lab page and the workbench
        // panel do not would defeat the shared-modules argument entirely.
        //
        // This RE-BASELINES the RECORDED series, and nothing else. The sampler cannot
        // affect the run, so `scenarioFailed`, `outOfFundsDate`, `cumulativeDeficit` and
        // `finalNetWorthUsd` are unchanged EXACTLY. What moves is `timeSeries`, and
        // therefore `pathShape` (CAGR, worst-5yr, max drawdown, the decade split).
        //
        // Direction, measured rather than assumed — and the opposite of the intuition:
        // on the reference plan the year-boundary series is LOWER in 25 of 45 years and
        // higher in 2 (mean −0.10%, worst −1.17%). A retired plan spends faster than it
        // compounds within a year, so a mid-year reading sits ABOVE the year-end one.
        // See design 82 §8.3; an arm JSON from before this change is not comparable.
        scenario.buildSim({ seed, telemetry: 'off', sampler, samplerCadence: MC_SAMPLER_CADENCE });

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

        return scenario.sim;
      },
      evaluate: (sim) => ({
        // Design 84 §6.4a — MC used to record NOMINAL net worth only, which prices a
        // Roth dollar at par with a pre-tax one. On any question about WHERE wealth
        // sits (a decant, a conversion, a wrapper swap) that is the wrong scoreboard
        // and it favours holding by construction; G1 fixed it on the grid path and the
        // MC path was never followed. Built from the shared factory so a grid cell, an
        // optimizer score and an MC path are one number.
        afterTaxNetWorthUsd: computeAfterTaxNetWorth(sim.state, simEnd, afterTaxOpts),
        cumulativeTaxesPaid: sim.state.cumulativeTaxesPaid ?? 0,
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
    afterTaxOpts = afterTaxOptionsFromParams(base);
    const variables  = this.mcConfig.buildVariables(base);
    const provenance = summarizeProvenance(variables, { ownParams: templateParams, schemaDefaults });

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
