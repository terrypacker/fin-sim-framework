/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { test, describe } from 'node:test';
import assert             from 'node:assert/strict';
import { AccumulateConsumptionUtilityReducer } from '../../src/finance/reducers/accumulate-consumption-utility-reducer.js';
import { OPTIMIZATION_OBJECTIVES } from '../../src/finance/optimization/optimization-objectives.js';

/*
 * Design 39 Step 4 — CRRA running-utility objective.
 *
 * Two properties matter: (1) the accumulator computes per-period CRRA utility of
 * real (base-year USD) consumption, and (2) because that utility is concave, a
 * SMOOTH spending path scores higher than the same total spent unevenly — i.e.
 * consumption smoothing falls out of the objective for free.
 */

describe('AccumulateConsumptionUtilityReducer', () => {
  test('log utility (γ=1) of real USD consumption', () => {
    const r = new AccumulateConsumptionUtilityReducer({ gamma: 1 });
    const state = {
      cumulativeConsumptionUtility: 0,
      usSavingsAccount: { currency: { code: 'USD' } },
      inflationAccumulator: { US: 1.1 },
    };
    // 1100 nominal / 1.1 price level = 1000 real ⇒ ln(1000).
    const out = r.reduce(state, { type: 'EXPENSE_DEBIT', amount: 1100, targetKey: 'usSavingsAccount' });
    assert.ok(Math.abs(out.cumulativeConsumptionUtility - Math.log(1000)) < 1e-9);
  });

  test('AUD spending is FX-converted then deflated before the utility transform', () => {
    const r = new AccumulateConsumptionUtilityReducer({ gamma: 1 });
    const state = {
      cumulativeConsumptionUtility: 0,
      auSavingsAccount: { currency: 'AUD' },
      effectiveExchangeRates: { USD_AUD: 1.5 },
      inflationAccumulator: { AU: 1.2 },
    };
    // 1800 AUD /1.5 = 1200 USD /1.2 = 1000 real ⇒ ln(1000).
    const out = r.reduce(state, { type: 'EXPENSE_DEBIT', amount: 1800, targetKey: 'auSavingsAccount' });
    assert.ok(Math.abs(out.cumulativeConsumptionUtility - Math.log(1000)) < 1e-9);
  });

  test('γ>1 power utility matches the closed form', () => {
    const gamma = 2;
    assert.equal(
      AccumulateConsumptionUtilityReducer.utility(1000, gamma),
      (Math.pow(1000, 1 - gamma) - 1) / (1 - gamma));
  });

  test('floor keeps utility finite at zero consumption', () => {
    const u = AccumulateConsumptionUtilityReducer.utility(0, 2, 1);
    assert.ok(Number.isFinite(u));
  });

  test('marginalUtility = c^{-γ} (1/c for log), floored', () => {
    assert.ok(Math.abs(AccumulateConsumptionUtilityReducer.marginalUtility(1000, 1.5) - Math.pow(1000, -1.5)) < 1e-15);
    assert.ok(Math.abs(AccumulateConsumptionUtilityReducer.marginalUtility(1000, 1)   - 1 / 1000) < 1e-15);
    assert.ok(Number.isFinite(AccumulateConsumptionUtilityReducer.marginalUtility(0, 2, 1)), 'floored at c→0');
  });

  test('accumulates marginal utility + a count so the run average u′(c̄) can be derived', () => {
    const r = new AccumulateConsumptionUtilityReducer({ gamma: 1.5 });
    let state = { inflationAccumulator: { US: 1 }, usSavingsAccount: { currency: { code: 'USD' } } };
    state = r.reduce(state, { type: 'EXPENSE_DEBIT', amount: 1000, targetKey: 'usSavingsAccount' });
    state = r.reduce(state, { type: 'EXPENSE_DEBIT', amount: 4000, targetKey: 'usSavingsAccount' });

    assert.equal(state.cumulativeConsumptionUtilityCount, 2);
    const expectedSum = Math.pow(1000, -1.5) + Math.pow(4000, -1.5);
    assert.ok(Math.abs(state.cumulativeConsumptionMarginalUtility - expectedSum) < 1e-15);
    // Run average (what _readResult surfaces as consumptionMarginalUtility).
    const avg = state.cumulativeConsumptionMarginalUtility / state.cumulativeConsumptionUtilityCount;
    assert.ok(Math.abs(avg - expectedSum / 2) < 1e-15);
  });

  test('concavity ⇒ a smooth path beats an uneven path of equal total', () => {
    // Two periods, same total (2000). Smooth = [1000,1000]; uneven = [200,1800].
    const u = (c) => AccumulateConsumptionUtilityReducer.utility(c, 2);
    const smooth = u(1000) + u(1000);
    const uneven = u(200)  + u(1800);
    assert.ok(smooth > uneven, `smooth ${smooth} should beat uneven ${uneven}`);
  });
});

describe('CRRA objectives in OPTIMIZATION_OBJECTIVES', () => {
  test('MAX_CRRA_UTILITY reads the windowed accumulator delta', () => {
    const obj = OPTIMIZATION_OBJECTIVES.MAX_CRRA_UTILITY;
    assert.equal(obj.direction, 'maximize');
    const result   = { lifetimeConsumptionUtility: 50 };
    const snapshot = { state: { cumulativeConsumptionUtility: 20 } };
    assert.equal(obj.evaluate(result, { snapshot }), 30);          // 50 − 20
    assert.equal(obj.evaluate(result), 50);                        // no snapshot ⇒ full
  });

  test('DIE_WITH_TARGET_LIQUID targets net LIQUIDITY, ignoring illiquid net worth', () => {
    const obj = OPTIMIZATION_OBJECTIVES.DIE_WITH_TARGET_LIQUID;
    assert.equal(obj.direction, 'maximize');
    const result = {
      lifetimeConsumption: 1000,
      finalNetWorthUsd: 4_000_000,   // dominated by an illiquid house — must NOT be used
      finalNetLiquidity: 10_000,     // on target
      terminalWealthTarget: 10_000,
      terminalWealthTargetPenalty: 10,
    };
    // Liquidity is on target ⇒ zero penalty ⇒ score is pure consumption.
    assert.equal(obj.evaluate(result), 1000);
    // Contrast: gross-net-worth DIE_WITH_TARGET would penalise the $4M heavily.
    assert.ok(OPTIMIZATION_OBJECTIVES.DIE_WITH_TARGET.evaluate(result) < -1_000_000);
  });

  test('CRRA_DIE_WITH_TARGET = utility − λ·|NW − target|', () => {
    const obj = OPTIMIZATION_OBJECTIVES.CRRA_DIE_WITH_TARGET;
    const result = {
      lifetimeConsumptionUtility: 100,
      finalNetWorthUsd: 50_000,
      terminalWealthTarget: 0,
      terminalWealthTargetPenalty: 0.001,
    };
    // 100 − 0.001·50000 = 50
    assert.ok(Math.abs(obj.evaluate(result) - 50) < 1e-9);
  });
});
