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
import { IntlRetirementScenario }     from '../../scenarios/intl-retirement-scenario.js';
import { DEFAULT_MC_VARIABLE_CONFIGS } from './intl-retirement-mc-config.js';

// USD account state keys
const USD_ACCOUNT_KEYS = [
  'usSavingsAccount', 'fixedIncomeAccount', 'usStockAccount',
  'iraAccount', 'k401Account', 'rothAccount',
  'spouseRothAccount', 'spouseIraAccount', 'spouseK401Account',
];

// AUD account state keys
const AUD_ACCOUNT_KEYS = [
  'auSavingsAccount', 'auStockAccount', 'superAccount', 'spouseSuperAccount',
];

/**
 * Total net worth in USD.
 * AUD accounts are converted using the simulation's final exchange rate.
 */
export function computeNetWorthUsd(state) {
  const usd = USD_ACCOUNT_KEYS.reduce((s, k) => s + (state[k]?.balance ?? 0), 0);
  const aud = AUD_ACCOUNT_KEYS.reduce((s, k) => s + (state[k]?.balance ?? 0), 0);
  const rate = state.exchangeRateUsdToAud ?? 1.55;
  return usd + aud / rate;
}

/**
 * Extract one net worth data point per year from sim history snapshots.
 * Takes the last snapshot within each calendar year.
 */
function extractYearlyTimeSeries(sim) {
  const byYear = new Map();
  for (const snap of sim.history.snapshots) {
    const year = snap.date.getUTCFullYear();
    byYear.set(year, snap.state);
  }
  return [...byYear.entries()]
    .sort(([a], [b]) => a - b)
    .map(([year, state]) => ({
      date:        new Date(Date.UTC(year, 0, 1)),
      netWorthUsd: computeNetWorthUsd(state),
    }));
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
   * @param {object}   opts
   * @param {number}   [opts.n=100]               - Number of MC iterations.
   * @param {Array}    [opts.variableConfigs]      - Distribution configs per param.
   *                                                 Defaults to DEFAULT_MC_VARIABLE_CONFIGS.
   * @param {Date}     [opts.simStart]             - Simulation start date.
   * @param {Date}     [opts.simEnd]               - Simulation end date.
   */
  constructor({
    n              = 100,
    variableConfigs = DEFAULT_MC_VARIABLE_CONFIGS,
    simStart       = new Date(Date.UTC(2026, 0, 1)),
    simEnd         = new Date(Date.UTC(2041, 0, 1)),
  } = {}) {
    this.n               = n;
    this.variableConfigs = variableConfigs;
    this.simStart        = simStart;
    this.simEnd          = simEnd;
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

    const runner = new ScenarioRunner({
      createSimulation: (params) => {
        ServiceRegistry.reset();
        const scenario = new IntlRetirementScenario({
          context:  ServiceRegistry.getInstance().simulationContext,
          params,
          simStart,
          simEnd,
        });
        scenario.buildSim();
        scenario.loadDefaults();
        scenario.sim.silent = true; // skip bus, clones, diffs — not needed in MC
        return scenario.sim;
      },
      evaluate: (sim) => ({
        finalNetWorthUsd:  computeNetWorthUsd(sim.state),
        scenarioFailed:    sim.state.scenarioFailed    ?? false,
        outOfFundsDate:    sim.state.outOfFundsDate    ?? null,
        cumulativeDeficit: sim.state.cumulativeDeficit ?? 0,
        deficitMonths:     sim.state.deficitMonths     ?? 0,
        timeSeries:        extractYearlyTimeSeries(sim),
      }),
    });

    const base    = { ...baseParams, endDate: simEnd };
    const mcRuns  = [];
    for (let i = 0; i < this.n; i++) {
      const params = this._perturb(base, i);
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
      scenarioFailed:    r.result.scenarioFailed,
      outOfFundsDate:    r.result.outOfFundsDate,
      cumulativeDeficit: r.result.cumulativeDeficit,
      deficitMonths:     r.result.deficitMonths,
      timeSeries:        r.result.timeSeries,
    }));

    return { runs, summary };
  }

  /**
   * Produce a perturbed parameter object for iteration i.
   *
   * Every variable config contributes to the output so that `r.params` is
   * fully self-contained and does not rely on INTL_RETIREMENT_DEFAULTS:
   *   - Enabled configs: sample from their distribution (consumes RNG calls).
   *   - Disabled configs: use the constant value from the config (mean or value).
   *
   * Values already supplied by the caller in baseParams take precedence over
   * disabled-config defaults, but are always overridden by enabled configs.
   */
  _perturb(baseParams, i) {
    const rng       = makeSeededRng(i + 1);
    const perturbed = { ...baseParams };

    for (const cfg of this.variableConfigs) {
      if (cfg.enabled) {
        perturbed[cfg.paramKey] = createDistribution(cfg).sample(rng);
      } else if (!(cfg.paramKey in baseParams)) {
        // Fill in the config's reference value so r.params is complete.
        perturbed[cfg.paramKey] = cfg.value ?? cfg.mean;
      }
    }

    return perturbed;
  }
}
