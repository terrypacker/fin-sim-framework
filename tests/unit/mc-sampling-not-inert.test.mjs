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
 * mc-sampling-not-inert.test.mjs
 *
 * Guards the failure mode that makes a Monte Carlo run WORTHLESS WITHOUT LOOKING
 * BROKEN: sampled parameters that never reach the simulation.
 *
 * The MC runner samples a growth rate per iteration and threads it into the cfg it
 * builds. But growth rates also live in a scenario's persisted
 * `initialState.baseGrowthRates` / `effectiveGrowthRates` maps, which the loader
 * applies AFTER the param bag. If those maps shadow the sampled value, every
 * iteration runs the identical world: the run completes, reports a tidy
 * distribution, and every path is the same number. Nothing errors. The output looks
 * like a Monte Carlo and contains no Monte Carlo.
 *
 * Two independent things must therefore hold, and each gets its own test:
 *   1. sampling produces VARIED parameter values across iterations, and
 *   2. that variation produces VARIED simulation outcomes.
 *
 * Test 2 is the one that matters and the one a naive check misses — (1) can pass
 * while (2) fails, which is exactly the shadowing bug.
 *
 * The stdDev is deliberately exaggerated so an inert lever is unmistakable rather
 * than marginal; this is a wiring assertion, not a calibration one.
 *
 * Originally a standalone diagnostic script written while investigating precisely
 * this bug. Promoted to a test because the shadowing it detects is a silent
 * regression that no other test would catch.
 *
 * Run with: node --test tests/unit/mc-sampling-not-inert.test.mjs
 */

import { test }  from 'node:test';
import assert    from 'node:assert/strict';

import { IntlRetirementMcRunner } from '../../src/finance/monte-carlo/intl-retirement-mc-runner.js';
import { IntlRetirementMcConfig } from '../../src/finance/monte-carlo/intl-retirement-mc-config.js';
import { IntlRetirementScenario } from '../../src/scenarios/intl-retirement-scenario.js';

const SIM_START = new Date(Date.UTC(2026, 0, 1));
const SIM_END   = new Date(Date.UTC(2036, 0, 1));   // long enough for returns to diverge
const N         = 6;
const EQUITY_RATE_KEYS = ['brokerageGrowthRate', 'rothGrowthRate', 'iraGrowthRate', 'k401GrowthRate'];

/**
 * Run N iterations with a wide spread on the equity growth rates and EVERY OTHER
 * sampled variable pinned.
 *
 * The pinning is what makes the outcome assertion mean anything. A dozen variables
 * are enabled by default — inflation, FX, prime rates, dividends, spouse accounts —
 * and any one of them varies terminal net worth on its own. Leave them on and the
 * "outcomes vary" test passes even when the equity rates are completely inert,
 * which is the exact bug being guarded. Verified by mutation: with the spread set to
 * zero, this test must fail.
 */
async function runWithWideEquitySpread({ stdDev = 0.05 } = {}) {
  const cfg = IntlRetirementScenario.buildDefaultConfig({});
  const mcConfig = new IntlRetirementMcConfig();

  // Pin every other channel, then open up equity only.
  for (const v of mcConfig.buildVariables({})) {
    if (v.enabled && !EQUITY_RATE_KEYS.includes(v.paramKey)) {
      mcConfig.applyOverride(v.paramKey, { enabled: false });
    }
  }
  for (const k of EQUITY_RATE_KEYS) {
    mcConfig.applyOverride(k, { enabled: true, stdDev });
  }

  const runner = new IntlRetirementMcRunner({
    n: N, mcConfig, cfgTemplate: cfg, simStart: SIM_START, simEnd: SIM_END,
  });

  const { log, warn } = console;
  console.log = () => {}; console.warn = () => {};
  try {
    return await runner.run({});
  } finally {
    console.log = log; console.warn = warn;
  }
}

test('MC sampling: sampled growth rates vary across iterations', async () => {
  const { runs } = await runWithWideEquitySpread();
  const sampled = runs.map(r => r.params?.brokerageGrowthRate);

  assert.ok(sampled.every(v => typeof v === 'number'),
    'every run should report a sampled brokerageGrowthRate in params');

  const distinct = new Set(sampled.map(v => v.toFixed(6))).size;
  assert.ok(distinct > 1,
    `expected varied sampled rates across ${N} iterations, got ${distinct} distinct `
    + `value(s): ${sampled.join(', ')} — the sampler itself is not varying the param`);
});

test('MC sampling: sampled rates reach the sim and change the outcome', async () => {
  const { runs } = await runWithWideEquitySpread();
  const netWorths = runs.map(r => Math.round(r.finalNetWorthUsd ?? 0));
  const distinct = new Set(netWorths).size;

  assert.ok(distinct > 1,
    `all ${N} iterations produced the identical net worth (${netWorths[0]?.toLocaleString()}), `
    + 'so the sampled growth rates are INERT — they are being shadowed before the sim reads '
    + 'them (most likely by initialState.baseGrowthRates / effectiveGrowthRates, which the '
    + 'loader applies after the param bag). The MC would report a distribution containing no '
    + 'actual variation.');
});
