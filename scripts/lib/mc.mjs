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
 * ── TRAP 1 (FIXED IN THE RUNNER): means came from FRAMEWORK DEFAULTS, not your scenario.
 *
 * `DEFAULT_MC_VARIABLE_CONFIGS` takes its means from `INTL_RETIREMENT_DEFAULTS`, and
 * the runner used to center on those unless the caller passed the scenario's params
 * as `baseParams` — which no arm did. An arm whose scenario assumed 10% equity
 * returns got sampled around the framework's 5% default, silently testing a world
 * several points more pessimistic than the plan, and a *disabled* lever wrote its
 * framework default straight into `cfg.parameters`, overwriting the plan's own value.
 *
 * `IntlRetirementMcRunner.run()` now seeds its base from the cfgTemplate's own params
 * (both stores) before anything else, so every arm is centered on its scenario with
 * no caller cooperation. `summary.provenance` reports where each center came from.
 * `recentreOnScenario()` is kept as a VERIFICATION that this held — it no longer
 * overrides anything, and anything it reports is a bug worth chasing.
 *
 * ── TRAP 2 (FIXED IN THE RUNNER): shock variables need `shocks` in the base params.
 *
 * `buildShockMcConfigs` reads `params.shocks`. Enabling `shocks[0].severity` and then
 * calling `runner.run({})` used to build NO shock variables at all — silently — so
 * the arm measured a world with no crash in it. The runner now reads `shocks` off the
 * cfgTemplate along with every other param. Passing `runner.run({ shocks })` is still
 * correct (an explicit caller override wins) and `extractShocks()` still pulls it off
 * the cfg, but omitting it is no longer a silent hole.
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
import { scenarioParamValues }    from '../../src/finance/param-schema-utils.js';
import { DISTRIBUTION_TYPES }     from '../../src/simulation-framework/distributions.js';
import { quietAsync } from './run.mjs';
import { numericParams } from './variant.mjs';

/** The configured shock array, in the shape `runner.run()` needs (TRAP 2). */
export function extractShocks(cfg) {
  return (cfg.params ?? []).find(p => p.name === 'shocks')?.value
    ?? cfg.parameters?.shocks
    ?? [];
}

/**
 * VERIFY that every numeric MC variable is centered on this cfg's own param value
 * (TRAP 1). The runner does the re-centring itself now, so this asserts rather than
 * repairs: it builds the variable list the way the runner will and reports anything
 * that would still be sampled away from the scenario.
 *
 * A non-empty result means either a deliberate override (from `opts.overrides`) or a
 * regression in the runner's base-param layering — not something to paper over here.
 *
 * @returns {string[]} human-readable list of centers that differ, for the report header
 */
export function recentreOnScenario(mcConfig, cfg, shocks) {
  const own  = numericParams(cfg);
  const base = { ...scenarioParamValues(cfg), shocks };
  const off  = [];
  for (const v of mcConfig.buildVariables(base)) {
    const mine   = own.get(v.paramKey);
    const center = v.type === DISTRIBUTION_TYPES.CONSTANT ? v.value : v.mean;
    if (mine != null && center != null && Math.abs(mine - center) > 1e-9) {
      off.push(`${v.paramKey} centered ${center} vs scenario ${mine}`);
    }
  }
  return off;
}

/**
 * Build an MC config for an arm.
 *
 * @param {object}  cfg
 * @param {object}  [opts]
 * @param {boolean} [opts.shock]     enable the manufactured single crash (severity + date)
 * @param {object}  [opts.overrides] extra `applyOverride` calls, `{paramKey: override}`
 * @param {boolean} [opts.recentre]  default true — verify centers match the scenario
 *                                   (TRAP 1). The returned `recentred` list is now a
 *                                   list of centers that DON'T match; normally empty.
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
    // ISO, not String(): `outOfFundsDate` arrives as a Date, and `String(date)` is
    // "Tue Feb 27 2061 00:00:00 GMT…", whose first ten characters are "Tue Feb 27" —
    // a date string with the YEAR sliced off. Every consumer reads the year by
    // `oof.slice(0, 4)`, so they silently got NaN and dropped the row; the terminal
    // report prints the out-of-funds line only when at least one row parses, so the
    // readout simply never appeared and nothing ever errored. Matches run.mjs.
    oof:    r.outOfFundsDate ? new Date(r.outOfFundsDate).toISOString().slice(0, 10) : null,
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

  return {
    rows,
    pathShape:  summary?.pathShape ?? null,
    // What world these rows describe (see summarizeProvenance). Persisted with the
    // arm so a report written days later can still say whether it is about the plan.
    provenance: summary?.provenance ?? null,
    summary,
    ms: Date.now() - started,
  };
}
