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
 * windowed-horizon.test.mjs — design 41 (sliding fixed-length prediction window).
 *
 * Covers: the _scoreEnd clamp/gate, the H=remaining ≡ full-horizon identity, the
 * §5.1 fix (windowed MAX_AFTER_TAX_NET_WORTH gives the Roth lever a gradient where
 * full-horizon is flat), and the myopia guard (running goals ignore H).
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { OptimizationProblem }  from '../../src/finance/optimization/optimization-problem.js';
import { OPTIMIZATION_OBJECTIVES, OPT_PARAM_TYPES, objectiveIsWindowable }
  from '../../src/finance/optimization/optimization-objectives.js';

const Y = (y) => new Date(Date.UTC(y, 0, 1));

// ── _scoreEnd: clamp, slide, shrink, gate ──────────────────────────────────────

describe('_scoreEnd', () => {
  const mk = (horizonYears, objective, snapDate) => new OptimizationProblem({
    objective, horizonYears,
    simStart: Y(2026), simEnd: Y(2070),
    initialState: snapDate ? { kind: 'snapshot', snapshot: { date: snapDate } } : { kind: 'compile' },
  });

  test('null/0 H ⇒ full horizon (simEnd)', () => {
    assert.equal(+mk(null, OPTIMIZATION_OBJECTIVES.MAX_NET_WORTH, Y(2030))._scoreEnd(), +Y(2070));
    assert.equal(+mk(0,    OPTIMIZATION_OBJECTIVES.MAX_NET_WORTH, Y(2030))._scoreEnd(), +Y(2070));
  });

  test('windowable goal: scoreEnd = now + H', () => {
    assert.equal(+mk(10, OPTIMIZATION_OBJECTIVES.MAX_NET_WORTH, Y(2030))._scoreEnd(), +Y(2040));
  });

  test('clamps at simEnd and shrinks as "now" approaches it', () => {
    // now=2068, H=10 ⇒ 2078 clamped to 2070 (2-year effective window).
    assert.equal(+mk(10, OPTIMIZATION_OBJECTIVES.MAX_NET_WORTH, Y(2068))._scoreEnd(), +Y(2070));
  });

  test('H ≥ remaining recovers full horizon exactly', () => {
    assert.equal(+mk(44, OPTIMIZATION_OBJECTIVES.MAX_NET_WORTH, Y(2026))._scoreEnd(), +Y(2070));
  });

  test('non-windowable goals ignore H (forced to simEnd)', () => {
    assert.equal(+mk(5, OPTIMIZATION_OBJECTIVES.MIN_LIFETIME_TAXES, Y(2030))._scoreEnd(), +Y(2070));
    assert.equal(+mk(5, OPTIMIZATION_OBJECTIVES.DIE_WITH_TARGET,    Y(2030))._scoreEnd(), +Y(2070));
    assert.equal(+mk(5, OPTIMIZATION_OBJECTIVES.MAX_CRRA_UTILITY,   Y(2030))._scoreEnd(), +Y(2070));
  });

  test('compile-kind (no snapshot) measures the window from simStart', () => {
    assert.equal(+mk(10, OPTIMIZATION_OBJECTIVES.MAX_NET_WORTH, null)._scoreEnd(), +Y(2036));
  });
});

describe('objectiveIsWindowable', () => {
  test('only terminal-stock maximizers are windowable', () => {
    for (const k of ['MAX_NET_WORTH', 'MAX_AFTER_TAX_NET_WORTH', 'MAX_NET_LIQUIDITY',
                     'MAX_AFTER_TAX_NET_LIQUIDITY', 'MAX_ROTH_BALANCE']) {
      assert.equal(objectiveIsWindowable(OPTIMIZATION_OBJECTIVES[k]), true, `${k} windowable`);
    }
    for (const k of ['MIN_LIFETIME_TAXES', 'MAX_CRRA_UTILITY', 'DIE_WITH_TARGET',
                     'DIE_WITH_TARGET_LIQUID', 'CRRA_DIE_WITH_TARGET', 'MIN_DEFICIT']) {
      assert.equal(objectiveIsWindowable(OPTIMIZATION_OBJECTIVES[k]), false, `${k} NOT windowable`);
    }
  });
});

// ── End-to-end: the identity, the fix, and the myopia guard ─────────────────────

describe('windowed horizon drives the Roth lever (real IntlRetirement rollout)', () => {
  const KEY = 'rothConversionSchedule[0].incomeTarget';
  const mkProblem = (objective, horizonYears) => new OptimizationProblem({
    variables: [{ paramKey: KEY, type: OPT_PARAM_TYPES.CONTINUOUS, min: 0, max: 400_000, step: 1_000 }],
    // `moveYear` past simEnd keeps this US-domestic. The subject here is the WINDOW
    // (design 41), and the reference scenario otherwise moves US→AU in 2031 — inside
    // the 8-year window below. Since design 84 G1 an AU-resident Roth is discounted
    // for its s99B earnings, which reverses the sign of the conversion gradient and
    // would make this test fail for a reason that has nothing to do with windowing.
    // The reversal itself is asserted in after-tax.test.mjs, where it belongs.
    baseParams: {
      rothConversionEnabled: true,
      rothConversionSchedule: [{ year: 2030, incomeTarget: 0 }],
      moveYear: 2061,
    },
    objective,
    simStart: Y(2026), simEnd: Y(2060),
    // A 2030 snapshot is unavailable here; compile-from-t0 measures the window
    // from simStart (2026), which is fine for these directional assertions.
    initialState: { kind: 'compile' },
    horizonYears,
  });

  test('IDENTITY: H = remaining years ≡ full horizon, metric-for-metric', () => {
    const full = mkProblem(OPTIMIZATION_OBJECTIVES.MAX_AFTER_TAX_NET_WORTH, null).evaluate({ [KEY]: 0 }).result;
    const win  = mkProblem(OPTIMIZATION_OBJECTIVES.MAX_AFTER_TAX_NET_WORTH, 34).evaluate({ [KEY]: 0 }).result; // 2026→2060
    assert.equal(Math.round(win.finalAfterTaxNetWorth), Math.round(full.finalAfterTaxNetWorth));
    assert.equal(Math.round(win.finalNetWorthUsd),      Math.round(full.finalNetWorthUsd));
    assert.equal(Math.round(win.cumulativeTaxesPaid),   Math.round(full.cumulativeTaxesPaid));
  });

  test('FIX: the window is a real, distinct horizon and still sees conversion value at its edge', () => {
    const obj = OPTIMIZATION_OBJECTIVES.MAX_AFTER_TAX_NET_WORTH;
    const fullOff = mkProblem(obj, null).evaluate({ [KEY]: 0 }).result.finalAfterTaxNetWorth;
    const fullOn  = mkProblem(obj, null).evaluate({ [KEY]: 200_000 }).result.finalAfterTaxNetWorth;
    // Short 8-year window (2026→2034): scored at the edge, where the converted
    // pre-tax pile still exists.
    const winOff  = mkProblem(obj, 8).evaluate({ [KEY]: 0 }).result.finalAfterTaxNetWorth;
    const winOn   = mkProblem(obj, 8).evaluate({ [KEY]: 200_000 }).result.finalAfterTaxNetWorth;

    const fullDelta = fullOn - fullOff;
    const winDelta  = winOn  - winOff;
    // (1) Converting still raises windowed after-tax net worth — the metric's
    //     embedded-liability mechanism works at the edge, not just at simEnd.
    assert.ok(winDelta > 0, `windowed after-tax net worth should rise with conversion: ${Math.round(winDelta)}`);
    // (2) The window genuinely changes what is optimized (different horizon ⇒
    //     materially different score) — it is not a no-op vs full horizon.
    assert.ok(Math.round(winDelta) !== Math.round(fullDelta),
      `window should score a different gradient than full life: win=${Math.round(winDelta)} full=${Math.round(fullDelta)}`);
    // NB: whether the window exposes MORE gradient than full (the design 40 §5.1
    // spend-down inversion) is scenario-dependent — it holds when full-life spends
    // the pre-tax pile to zero by death; verified in the browser, not asserted on
    // this non-spend-down default scenario where the pile survives to simEnd.
  });

  test('MYOPIA GUARD: MIN_LIFETIME_TAXES ignores the window (scored at full horizon either way)', () => {
    const obj = OPTIMIZATION_OBJECTIVES.MIN_LIFETIME_TAXES;
    const a = mkProblem(obj, 5).evaluate({ [KEY]: 100_000 }).result.cumulativeTaxesPaid;
    const b = mkProblem(obj, null).evaluate({ [KEY]: 100_000 }).result.cumulativeTaxesPaid;
    assert.equal(Math.round(a), Math.round(b), 'windowed == full for a non-windowable goal');
  });
});
