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
 * equity-return-mc.test.mjs — design 74 Phase 2 (MC integration).
 *
 * Covers the three Phase-2 pieces:
 *   - per-iteration SEED threading — the core fix. Before it, every MC iteration ran
 *     at the default seed 1, so a stochastic path ON drew the IDENTICAL sequence in
 *     every iteration and sequence-of-returns risk collapsed to one ordering. The
 *     design assumed the seed already varied; it did not.
 *   - `equityReturnVol` exposed as an MC variable.
 *   - path-shape diagnostics (computePathShape + summary.pathShape).
 */

import { test, describe } from 'node:test';
import assert             from 'node:assert/strict';

import { IntlRetirementMcRunner, computePathShape } from '../../src/finance/monte-carlo/intl-retirement-mc-runner.js';
import { IntlRetirementMcConfig } from '../../src/finance/monte-carlo/intl-retirement-mc-config.js';
import { IntlRetirementScenario } from '../../src/scenarios/intl-retirement-scenario.js';

// A short-horizon MC runner with every default scalar variable disabled, so the ONLY
// source of per-iteration variation is the in-loop sim.rng path (isolates the seed fix).
function seedOnlyRunner(n = 4) {
  // FX pinned on the template: these tests isolate the EQUITY return path, and
  // "stochastic OFF ⇒ seed variation is inert" is only true of a run with no other
  // stochastic consumer. The scenario default now supplies one.
  const simEnd = new Date(Date.UTC(2036, 0, 1));
  const cfgTemplate = IntlRetirementScenario.buildDefaultConfig(
    { fxProcessModel: 'NONE' }, undefined, simEnd);
  const runner = new IntlRetirementMcRunner({ n, simEnd, cfgTemplate });
  for (const v of IntlRetirementMcConfig.contributors[0]()) {
    runner.mcConfig.applyOverride(v.paramKey, { enabled: false });
  }
  return runner;
}

// ─── computePathShape (pure, fast) ───────────────────────────────────────────────

describe('computePathShape', () => {
  const ts = (...vals) => vals.map((v, i) => ({ date: new Date(Date.UTC(2026 + i, 0, 1)), netWorthUsd: v }));

  test('degenerate series (< 2 points) ⇒ all-null', () => {
    assert.deepEqual(computePathShape([]), {
      netWorthCagr: null, worst5yrCagr: null, maxDrawdown: null, decadeNetWorthUsd: null,
      houseCagr: null, houseMaxDrawdown: null,
      // design 97 §18 — the liquidity trough. Null, not 0: "no series" and "the plan
      // hit zero" are different facts and a report has to be able to tell them apart.
      minRealNetLiquidity: null, minRealNetLiquidityYear: null,
      troughRealNetLiquidity: null, troughRealNetLiquidityYear: null, troughRealDrawdown: null,
    });
    assert.deepEqual(computePathShape(ts(100)).netWorthCagr, null);
  });

  test('netWorthCagr is the geometric growth start→end', () => {
    // 100 → 200 over 2 years ⇒ √2 − 1 ≈ 0.4142.
    const { netWorthCagr } = computePathShape(ts(100, 150, 200));
    assert.ok(Math.abs(netWorthCagr - (Math.SQRT2 - 1)) < 1e-9);
  });

  test('non-positive endpoints ⇒ null cagr (no NaN/Infinity)', () => {
    assert.equal(computePathShape(ts(0, 100)).netWorthCagr, null);
    assert.equal(computePathShape(ts(100, 0)).netWorthCagr, null);
  });

  test('maxDrawdown is the deepest peak-to-trough fraction', () => {
    // peak 200, trough 150 ⇒ 25% drawdown.
    const { maxDrawdown } = computePathShape(ts(100, 200, 150, 180));
    assert.ok(Math.abs(maxDrawdown - 0.25) < 1e-9);
  });

  test('monotonic growth ⇒ zero drawdown', () => {
    assert.equal(computePathShape(ts(100, 110, 120, 130)).maxDrawdown, 0);
  });

  test('worst5yrCagr is the min rolling 5-year annualized growth', () => {
    // 6 points (indices 0..5): windows [0..5] only. 100 → 90 over 5y ⇒ negative.
    const { worst5yrCagr } = computePathShape(ts(100, 100, 100, 100, 100, 90));
    assert.ok(worst5yrCagr < 0 && Math.abs(worst5yrCagr - (Math.pow(0.9, 1 / 5) - 1)) < 1e-9);
  });

  test('decadeNetWorthUsd is net worth at ~10 years (clamped to the last point)', () => {
    const short = computePathShape(ts(100, 110, 120));      // only 3 points
    assert.equal(short.decadeNetWorthUsd, 120);             // clamped to last
    const long = computePathShape(ts(...Array.from({ length: 15 }, (_, i) => 100 + i)));
    assert.equal(long.decadeNetWorthUsd, 110);              // index 10 ⇒ 100 + 10
  });
});

// ─── per-iteration seed threading (the core fix) ─────────────────────────────────

describe('MC per-iteration seed', () => {
  test('stochastic ON + no scalar vars ⇒ iterations DIVERGE (own return sequence each)', async () => {
    const { runs } = await seedOnlyRunner(4).run({ equityReturnStochastic: true, equityReturnVol: 0.18 });
    const nw = runs.map(r => Math.round(r.finalNetWorthUsd));
    assert.ok(new Set(nw).size > 1, `all iterations identical (${nw[0]}) — seed not threaded`);
  });

  test('stochastic ON ⇒ reproducible: same config twice gives the same paths', async () => {
    const a = (await seedOnlyRunner(4).run({ equityReturnStochastic: true, equityReturnVol: 0.18 })).runs.map(r => Math.round(r.finalNetWorthUsd));
    const b = (await seedOnlyRunner(4).run({ equityReturnStochastic: true, equityReturnVol: 0.18 })).runs.map(r => Math.round(r.finalNetWorthUsd));
    assert.deepEqual(a, b);
  });

  test('stochastic OFF ⇒ seed variation is inert (deterministic MC unchanged)', async () => {
    const { runs } = await seedOnlyRunner(4).run({});
    const nw = runs.map(r => Math.round(r.finalNetWorthUsd));
    assert.equal(new Set(nw).size, 1, 'seed threading perturbed a run with no stochastic path');
  });
});

// ─── equityReturnVol exposed as an MC variable ───────────────────────────────────

describe('equityReturnVol MC variable', () => {
  test('appears in the resolved variable list, disabled by default, centred on 0.18', () => {
    const vars = new IntlRetirementMcConfig().buildVariables({ endDate: new Date(Date.UTC(2036, 0, 1)) });
    const v = vars.find(x => x.paramKey === 'equityReturnVol');
    assert.ok(v, 'equityReturnVol not exposed as an MC variable');
    assert.equal(v.enabled, false, 'should be opt-in (single runs unaffected)');
    assert.ok(Math.abs(v.mean - 0.18) < 1e-9);
  });
});

// ─── summary.pathShape ───────────────────────────────────────────────────────────

describe('summary.pathShape', () => {
  test('the aggregate carries the sequence-risk readout keys', async () => {
    const { summary, runs } = await seedOnlyRunner(6).run({ equityReturnStochastic: true, equityReturnVol: 0.18 });
    for (const k of ['medianNetWorthCagr', 'medianWorst5yrCagr', 'medianMaxDrawdown',
                     'medianDecadeNetWorthUsd', 'failureRateBelowMedianDecade', 'failureRateAboveMedianDecade']) {
      assert.ok(k in summary.pathShape, `summary.pathShape missing ${k}`);
    }
    // Every run carries its own path shape and the below-median flag.
    for (const r of runs) {
      assert.ok(r.pathShape && typeof r.pathShape === 'object');
      assert.equal(typeof r.firstDecadeBelowMedian, 'boolean');
    }
  });
});
