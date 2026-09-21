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
 * mpc-advice-signals.test.mjs
 *
 * DESIGN 39 §14.8.4 — the card must say when the search found nothing to choose between, and
 * when no candidate reaches the goal's own target.
 *
 * ASG-1  flat: every distinct candidate scores the same (within a dollar / float noise)
 * ASG-2  not flat: any real slope, or fewer than two distinct candidates to compare
 * ASG-3  target out of reach: every candidate misses on the same side, beyond tolerance
 * ASG-4  target reachable: one lands within tolerance, or two straddle it
 * ASG-5  the target is compared in REAL dollars, and only for a Die-With-Target goal
 * ASG-6  through a real `advise()`: an absurd target is reported, and the recommendation stands
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import { adviceSignals }           from '../../src/finance/mpc/advice-signals.js';
import { OPTIMIZATION_OBJECTIVES } from '../../src/finance/optimization/optimization-objectives.js';
import { OptimizationProblem }     from '../../src/finance/optimization/optimization-problem.js';
import { CockpitController, COCKPIT_CONTROLS } from '../../src/finance/mpc/cockpit-controller.js';

const MAX_NW = OPTIMIZATION_OBJECTIVES.MAX_NET_WORTH;
const DWT    = OPTIMIZATION_OBJECTIVES.DIE_WITH_TARGET;
const key    = DWT.metric.key;

const cand = (x, score, result = {}) => ({ candidate: { x }, score, result });

test('ASG-1: flat when every distinct candidate scores the same', () => {
  const s = adviceSignals({ objective: MAX_NW, candidates: [
    cand(1, 7_000_000, { finalNetWorthUsd: 7_000_000 }),
    cand(2, 7_000_000.4, { finalNetWorthUsd: 7_000_000 }),   // under a dollar
    cand(3, 7_000_000, { finalNetWorthUsd: 7_000_000 }),
  ] });
  assert.equal(s.flat.flat, true);
  assert.equal(s.flat.distinct, 3);
  assert.equal(s.flat.metricSpread, 0);
});

test('ASG-2: not flat with any real slope, or with nothing to compare', () => {
  assert.equal(adviceSignals({ objective: MAX_NW,
    candidates: [cand(1, 7_000_000), cand(2, 7_000_050)] }).flat.flat, false);
  const one = adviceSignals({ objective: MAX_NW, candidates: [cand(1, 5), cand(1, 5)] });
  assert.equal(one.flat.flat, false, 'one distinct candidate is not a search');
  assert.equal(one.flat.distinct, 1);
});

test('ASG-3: the target is out of reach when every candidate misses on one side', () => {
  const s = adviceSignals({ objective: DWT, candidates: [
    cand(1, 1, { [key]: 900_000, terminalWealthTarget: 50_000 }),
    cand(2, 2, { [key]: 400_000, terminalWealthTarget: 50_000 }),
  ] });
  assert.deepEqual(s.target, { reachable: false, target: 50_000, nearest: 400_000, side: 'above' });
});

test('ASG-4: reachable when one lands within tolerance, or two straddle the target', () => {
  const near = adviceSignals({ objective: DWT, candidates: [
    cand(1, 1, { [key]: 50_600, terminalWealthTarget: 50_000 }),   // within $1,000
    cand(2, 2, { [key]: 90_000, terminalWealthTarget: 50_000 }),
  ] });
  assert.equal(near.target.reachable, true);
  const straddle = adviceSignals({ objective: DWT, candidates: [
    cand(1, 1, { [key]: 10_000, terminalWealthTarget: 50_000 }),
    cand(2, 2, { [key]: 90_000, terminalWealthTarget: 50_000 }),
  ] });
  assert.equal(straddle.target.reachable, true, 'a value between the two reaches it');
  assert.equal(straddle.target.side, null);
});

test('ASG-5: compared in REAL dollars, and only for a Die-With-Target goal', () => {
  // 100,000 nominal at a price level of 2 is 50,000 real: on target.
  const real = adviceSignals({ objective: DWT, candidates: [
    cand(1, 1, { [key]: 100_000, terminalPriceLevel: 2, terminalWealthTarget: 50_000 }),
    cand(2, 2, { [key]: 300_000, terminalPriceLevel: 2, terminalWealthTarget: 50_000 }),
  ] });
  assert.equal(real.target.reachable, true);
  assert.equal(adviceSignals({ objective: MAX_NW, candidates: [cand(1, 1)] }).target, null);
});

test('ASG-6: through a real advise(), an absurd target is reported and the move still stands', async () => {
  const SIM_START = new Date(Date.UTC(2026, 0, 1)), SIM_END = new Date(Date.UTC(2050, 0, 1));
  const base = { spendingStrategy: ['EXPLICIT_BANDS'],
    spendingExpenseBands: [{ startAge: 45, monthlyAmount: 9000 }], terminalWealthTarget: 1e12 };
  const quiet = async (fn) => {
    const l = console.log, w = console.warn;
    console.log = () => {}; console.warn = () => {};
    try { return await fn(); } finally { console.log = l; console.warn = w; }
  };
  const advice = await quiet(async () => {
    const snap = new OptimizationProblem({ variables: [], baseParams: base, objective: DWT,
      simStart: SIM_START, simEnd: SIM_END, initialState: { kind: 'compile', cfgTemplate: null } })
      .rollToSnapshot({}, new Date(Date.UTC(2040, 0, 1)));
    const c = new CockpitController({ simStart: SIM_START, simEnd: SIM_END, baseParams: base,
      objective: DWT, control: COCKPIT_CONTROLS.SPENDING });
    c.setSnapshot(snap);
    return c.advise({ solverKey: 'CEM', solverOptions: { budget: 8, seed: 1 }, fanSize: 1, seriesPoints: 2 });
  });
  assert.equal(advice.signals.target.reachable, false);
  assert.equal(advice.signals.target.side, 'below');
  assert.equal(advice.signals.target.target, 1e12);
  assert.ok(advice.recommended.label, 'the recommendation is reported beside, not replaced');
});
