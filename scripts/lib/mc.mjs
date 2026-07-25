/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * mc.mjs — Monte Carlo arm setup, with the three traps that produce wrong answers.
 *
 * Running an arm is three lines. Running one that MEASURES WHAT YOU THINK is not,
 * and each of the following was a real bug found by inspecting output that looked
 * plausible. They live here so no future arm has to rediscover them.
 *
 * ── TRAP 1: variable means come from the FRAMEWORK DEFAULTS, not your scenario.
 *
 * `DEFAULT_MC_VARIABLE_CONFIGS` takes its means from `INTL_RETIREMENT_DEFAULTS`.
 * `_perturb()` samples an enabled variable from `cfg.mean` and IGNORES baseParams.
 * So an arm whose scenario assumes 10% equity returns gets sampled around the
 * framework's 5–7% default, silently testing a world several points more
 * pessimistic than the plan — and every failure rate comes out overstated.
 * `recentreOnScenario()` fixes this generically. Always call it.
 * (There is an aliasing wrinkle behind it: the paramKey is `brokerageGrowthRate`
 * but its default mean is read from `usStockGrowthRate`.)
 *
 * ── TRAP 2: shock variables are not built unless `shocks` is passed to run().
 *
 * `buildShockMcConfigs` reads `params.shocks`. Enabling `shocks[0].severity` and
 * then calling `runner.run({})` builds NO shock variables at all — silently, with
 * no warning — and the arm measures a world with no crash in it. Pass the shocks
 * array through: `runner.run({ shocks })`. `extractShocks()` pulls it off the cfg.
 *
 * ── TRAP 3: a constant sampled return is not sequence risk.
 *
 * With `equityReturnStochastic` off, one rate is drawn per ITERATION and held for
 * the whole horizon. Ordinary sequence-of-returns risk is then absent, so failure
 * probability is UNDERSTATED, while terminal-wealth MEANS are meaningless in the
 * other direction (a constant 19% compounded for 40 years is a fantasy that
 * dominates the average). Report medians and low percentiles, never means — and
 * prefer `stochastic: { equity: true }` for genuine path risk.
 *
 * ── Common random numbers
 *
 * The runner seeds iteration i deterministically from i, so index i is the SAME
 * WORLD in every arm. Paired differences at equal n therefore isolate the lever
 * instead of portfolio noise; `pairedRescues()` in ./mc-analysis.mjs relies on it.
 * Consequently: hold every sampled variable you are NOT studying at the same
 * setting across arms. Enabling an extra MC variable in one arm breaks the pairing.
 */

import { IntlRetirementMcRunner } from '../../src/finance/monte-carlo/intl-retirement-mc-runner.js';
import { IntlRetirementMcConfig } from '../../src/finance/monte-carlo/intl-retirement-mc-config.js';
import { quietAsync } from './run.mjs';
import { numericParams } from './variant.mjs';

/** The configured shock array, in the shape `runner.run()` needs (TRAP 2). */
export function extractShocks(cfg) {
  return (cfg.params ?? []).find(p => p.name === 'shocks')?.value
    ?? cfg.parameters?.shocks
    ?? [];
}

/**
 * Re-centre every numeric MC variable on this cfg's own param value (TRAP 1).
 * Keeps each variable's configured stdDev; only the mean moves.
 *
 * @returns {string[]} human-readable list of what moved, for the report header
 */
export function recentreOnScenario(mcConfig, cfg, shocks) {
  const own = numericParams(cfg);
  const moved = [];
  for (const v of mcConfig.buildVariables({ shocks })) {
    const mine = own.get(v.paramKey);
    if (mine != null && v.mean != null && Math.abs(mine - v.mean) > 1e-9) {
      mcConfig.applyOverride(v.paramKey, { mean: mine });
      moved.push(`${v.paramKey} ${(v.mean * 100).toFixed(1)}%→${(mine * 100).toFixed(1)}%`);
    }
  }
  return moved;
}

/**
 * Build an MC config for an arm.
 *
 * @param {object}  cfg
 * @param {object}  [opts]
 * @param {boolean} [opts.shock]     enable the manufactured single crash (severity + date)
 * @param {object}  [opts.overrides] extra `applyOverride` calls, `{paramKey: override}`
 * @param {boolean} [opts.recentre]  default true — see TRAP 1
 */
export function buildMcConfig(cfg, { shock = false, overrides = {}, recentre = true } = {}) {
  const shocks = extractShocks(cfg);
  const mcConfig = new IntlRetirementMcConfig();

  // Both ship enabled:false; a sequence-risk probe needs them on.
  if (shock) {
    mcConfig.applyOverride('shocks[0].severity',  { enabled: true });
    mcConfig.applyOverride('shocks[0].startDate', { enabled: true });
  }
  for (const [k, v] of Object.entries(overrides)) mcConfig.applyOverride(k, v);

  const recentred = recentre ? recentreOnScenario(mcConfig, cfg, shocks) : [];
  return { mcConfig, shocks, recentred };
}

/**
 * Run one arm and reduce each iteration to a comparable row.
 *
 * `seed` is carried on every row because it is the pairing key across arms — drop
 * it and paired analysis becomes impossible after the fact.
 */
export async function runArm({ cfg, n, mcConfig, shocks }) {
  const runner = new IntlRetirementMcRunner({
    n, mcConfig, cfgTemplate: cfg,
    simStart: new Date(cfg.simStart), simEnd: new Date(cfg.simEnd),
  });

  const started = Date.now();
  const { runs, summary } = await quietAsync(() => runner.run({ shocks }));

  const rows = runs.map(r => ({
    seed:   r.seed,
    nw:     Math.round(r.finalNetWorthUsd ?? 0),
    failed: !!r.scenarioFailed,
    oof:    r.outOfFundsDate ? String(r.outOfFundsDate).slice(0, 10) : null,
    // sampled long-run mean — the headline explanatory variable for failure
    growth: r.params?.brokerageGrowthRate ?? null,
    shockDate: r.params?.shocks?.[0]?.startDate ? String(r.params.shocks[0].startDate).slice(0, 10) : null,
    shockSev:  r.params?.shocks?.[0]?.severity ?? null,
    // realized path shape (populated only when stochastic paths are on)
    netWorthCagr: r.pathShape?.netWorthCagr ?? null,
    worst5yrCagr: r.pathShape?.worst5yrCagr ?? null,
    maxDrawdown:  r.pathShape?.maxDrawdown ?? null,
    houseCagr:        r.pathShape?.houseCagr ?? null,
    houseMaxDrawdown: r.pathShape?.houseMaxDrawdown ?? null,
    repairSpend:      Math.round(r.lifetimeRepairSpend ?? 0),
    firstDecadeBelow: r.firstDecadeBelowMedian ?? null,
  }));

  return { rows, pathShape: summary?.pathShape ?? null, summary, ms: Date.now() - started };
}
