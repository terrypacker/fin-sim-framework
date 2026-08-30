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
 * mc-trough-metric.test.mjs — design 97 §18, step 1.
 *
 * The lowest point REAL net liquidity reaches on a path: the metric a liquidity-pool
 * study is scored on, because the two metrics MC already carried cannot answer it.
 *
 * TROUGH-4 is the load-bearing one. It puts a path whose net WORTH barely dips beside
 * the fact that its spendable book collapsed, and asserts that `maxDrawdown` reads the
 * two as nearly identical while the trough separates them. If that test ever passes
 * vacuously — because the new metric quietly became a function of net worth — the whole
 * reason for adding it is gone.
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import { loadScenarioSim } from '../helpers/scenario-harness.js';
import { createMcSampler, computePathShape }
  from '../../src/finance/monte-carlo/intl-retirement-mc-runner.js';

const SIM_START = new Date(Date.UTC(2026, 0, 1));
const SIM_END   = new Date(Date.UTC(2034, 0, 1));

/** A yearly series point, in the shape `extractYearlyTimeSeries` produces. */
const pt = (year, netWorthUsd, netLiquidity, priceLevel) => ({
  date: new Date(Date.UTC(year, 0, 1)),
  netWorthUsd, netLiquidity, houseValueUsd: 0, priceLevel,
});

test('TROUGH-1: the trough is the minimum REAL net liquidity, and it names its year', () => {
  // Nominal minimum is 2028 (900k); real minimum is 2029, because by then the price
  // level has run away from a barely-higher nominal figure. A nominal metric would
  // report the wrong year AND the wrong depth.
  const shape = computePathShape([
    pt(2026, 3_000_000, 1_000_000, 1.00),
    pt(2027, 3_050_000,   950_000, 1.05),
    pt(2028, 3_100_000,   900_000, 1.10),   // nominal low: 900k / 1.10 = 818k real
    pt(2029, 3_200_000,   910_000, 1.30),   // real low:    910k / 1.30 = 700k real
    pt(2030, 3_400_000, 1_200_000, 1.35),
  ]);

  assert.equal(shape.minRealNetLiquidityYear, 2029);
  assert.ok(Math.abs(shape.minRealNetLiquidity - 700_000) < 1,
    `expected ~700k real, got ${shape.minRealNetLiquidity}`);
});

test('TROUGH-2: a series with no price level deflates by 1 rather than dropping out', () => {
  // An un-indexed series is a NOMINAL trough — a readable number. Skipping the points
  // would silently shorten the window the reserve is judged over, which is the failure
  // mode this codebase keeps finding: a believable figure measured over less than the
  // author thinks.
  const shape = computePathShape([
    pt(2026, 3_000_000, 1_000_000, undefined),
    pt(2027, 2_000_000,   400_000, undefined),
    pt(2028, 3_000_000, 1_100_000, undefined),
  ]);

  assert.equal(shape.minRealNetLiquidity, 400_000);
  assert.equal(shape.minRealNetLiquidityYear, 2027);
});

test('TROUGH-3: a degenerate series reports null, not NaN', () => {
  assert.equal(computePathShape([]).minRealNetLiquidity, null);
  assert.equal(computePathShape([]).troughRealNetLiquidity, null);
  assert.equal(computePathShape([]).troughRealDrawdown, null);
  assert.equal(computePathShape([pt(2026, 1, 1, 1)]).minRealNetLiquidity, null);   // <2 points
  assert.equal(computePathShape([
    pt(2026, 3_000_000, null, 1),
    pt(2027, 3_100_000, null, 1),
  ]).minRealNetLiquidity, null);
});

test('TROUGH-4: maxDrawdown cannot see a spendable book collapsing under a stable net worth', () => {
  // Same net-worth path in both: a house that keeps appreciating masks the liquid book.
  // This is precisely the plan a reserve is bought for, and the metric MC already had
  // scores the two as the same world.
  const steady = computePathShape([
    pt(2026, 3_000_000, 1_000_000, 1.0),
    pt(2027, 3_050_000,   950_000, 1.0),
    pt(2028, 3_100_000,   900_000, 1.0),
    pt(2029, 3_200_000,   950_000, 1.0),
  ]);
  const drained = computePathShape([
    pt(2026, 3_000_000, 1_000_000, 1.0),
    pt(2027, 3_050_000,   500_000, 1.0),
    pt(2028, 3_100_000,   120_000, 1.0),   // nearly dry, and net worth never dipped
    pt(2029, 3_200_000,   300_000, 1.0),
  ]);

  assert.equal(steady.maxDrawdown, drained.maxDrawdown,
    'net-worth drawdown is blind to this by construction — that is the point');
  assert.ok(drained.minRealNetLiquidity < steady.minRealNetLiquidity / 5,
    `trough must separate them: ${drained.minRealNetLiquidity} vs ${steady.minRealNetLiquidity}`);
});

test('TROUGH-6: an ACCUMULATING plan makes the whole-path floor its opening balance', () => {
  // This is not hypothetical — it is what the first real pool run reported: the median
  // path's minimum landed in the FIRST sampled year, so every arm scored the same number
  // and it was the one number no strategy can change.
  const shape = computePathShape([
    pt(2026, 3_000_000, 1_000_000, 1.0),
    pt(2027, 3_400_000, 1_400_000, 1.0),
    pt(2028, 3_800_000, 1_900_000, 1.0),   // peak
    // The fall a reserve exists to survive — deep, and still above where the plan started,
    // which is the case that makes the whole-path floor useless.
    pt(2029, 3_100_000, 1_100_000, 1.0),
    pt(2030, 3_500_000, 1_300_000, 1.0),
  ]);

  assert.equal(shape.minRealNetLiquidity, 1_000_000, 'the floor is t0 — uninformative here');
  assert.equal(shape.minRealNetLiquidityYear, 2026);

  // The post-peak trough cannot be reached by the opening balance: a peak has to be set first.
  assert.equal(shape.troughRealNetLiquidity, 1_100_000);
  assert.equal(shape.troughRealNetLiquidityYear, 2029);
  assert.ok(Math.abs(shape.troughRealDrawdown - (1 - 1_100_000 / 1_900_000)) < 1e-9);
});

test('TROUGH-7: the post-peak trough is the DEEPEST fall, not the last one', () => {
  const shape = computePathShape([
    pt(2026, 1, 1_000_000, 1.0),
    pt(2027, 1,   400_000, 1.0),   // −60% from 1.0m
    pt(2028, 1, 2_000_000, 1.0),   // new peak
    pt(2029, 1, 1_200_000, 1.0),   // −40% from 2.0m: LATER and LOWER-ranked, but shallower
  ]);
  assert.equal(shape.troughRealNetLiquidityYear, 2027);
  assert.ok(Math.abs(shape.troughRealDrawdown - 0.6) < 1e-9);
});

test('TROUGH-8: a path that only ever rose reports zero drawdown, not null', () => {
  // Null would drop the path out of every percentile, which would quietly restrict the
  // distribution to the paths that fell — i.e. make every arm look worse than it is.
  const shape = computePathShape([
    pt(2026, 1, 1_000_000, 1.0),
    pt(2027, 1, 1_500_000, 1.0),
    pt(2028, 1, 2_000_000, 1.0),
  ]);
  assert.equal(shape.troughRealDrawdown, 0);
  assert.equal(shape.troughRealNetLiquidity, 2_000_000);
  assert.equal(shape.troughRealNetLiquidityYear, 2028);
});

test('TROUGH-5: the sampler records the price level, on a real run, without perturbing it', () => {
  const base = loadScenarioSim({
    simStart: SIM_START, simEnd: SIM_END, stepTo: SIM_END, telemetry: 'off',
  }).sim;
  const sampled = loadScenarioSim({
    simStart: SIM_START, simEnd: SIM_END, stepTo: SIM_END, telemetry: 'off',
    sampler: createMcSampler(), samplerCadence: 'year-boundary',
  }).sim;

  // Inert on the run (the MCMIX-1 contract — the sampler holds LIVE state).
  assert.equal(String(sampled.state.outOfFundsDate ?? null), String(base.state.outOfFundsDate ?? null));

  const levels = sampled.samples.map(s => s.priceLevel);
  assert.ok(levels.length >= 5, `expected a sample per year, got ${levels.length}`);
  assert.ok(levels.every(v => typeof v === 'number' && v > 0), 'every sample carries a price level');
  // Monotone non-decreasing, and it actually MOVES — a deflator pinned at 1.0 would make
  // every "real" figure nominal and nothing downstream would notice.
  for (let i = 1; i < levels.length; i++) {
    assert.ok(levels[i] >= levels[i - 1], `price level fell at index ${i}`);
  }
  assert.ok(levels[levels.length - 1] > levels[0], 'the price level never moved — deflator is inert');
});
