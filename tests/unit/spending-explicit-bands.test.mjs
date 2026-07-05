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
import assert from 'node:assert/strict';

import { ExplicitBandsSpendingReducer, DEFAULT_EXPENSE_BANDS }
  from '../../src/finance/spending/strategies/explicit-bands-spending-reducer.js';

const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);

/** State with a US-resident primary of the given birth year and expense split. */
function stateAt(birthYear, asOfYear, { essential = 3500, discretionary = 1500, priceLevel = 1.0 } = {}) {
  return {
    expenses: { essential, discretionary },
    monthlyExpenses: essential + discretionary,
    people: { p1: { residency: 'US', birthDate: `${birthYear}-01-01` } },
    currentPeriods: { US: { startMs: Date.UTC(asOfYear, 0, 1) } },
    inflationAccumulator: { US: priceLevel },
  };
}

describe('ExplicitBandsSpendingReducer', () => {
  const r = new ExplicitBandsSpendingReducer(); // DEFAULT_EXPENSE_BANDS: 65→7000, 75→6000, 85→5500

  test('sets monthlyExpenses to the band amount on entering a band', () => {
    const out = r.reduce(stateAt(1961, 2026), { type: 'US_PERIOD_ADVANCE' }); // age 65
    close(out.monthlyExpenses, 7000);
    close(out.expenses.essential + out.expenses.discretionary, 7000);
    assert.strictEqual(out.explicitBandSpending.appliedStartAge, 65);
  });

  test('preserves the discretionary share when materializing the slice', () => {
    const out = r.reduce(stateAt(1961, 2026, { essential: 3500, discretionary: 1500 }), { type: 'US_PERIOD_ADVANCE' });
    close(out.expenses.discretionary, 7000 * 0.3); // ratio 1500/5000 preserved
    close(out.expenses.essential, 7000 * 0.7);
  });

  test('compounds the base-year amount by the residence price level at the band transition', () => {
    const out = r.reduce(stateAt(1951, 2026, { priceLevel: 1.2 }), { type: 'US_PERIOD_ADVANCE' }); // age 75
    close(out.monthlyExpenses, 6000 * 1.2); // 75-band amount compounded
    assert.strictEqual(out.explicitBandSpending.appliedStartAge, 75);
  });

  test('is idempotent within a band (no re-pin when the band is unchanged)', () => {
    const s = stateAt(1961, 2026);
    s.explicitBandSpending = { appliedStartAge: 65 };
    s.monthlyExpenses = 9999;            // some later inflation/guardrail-adjusted value
    const out = r.reduce(s, { type: 'US_PERIOD_ADVANCE' });
    close(out.monthlyExpenses, 9999);    // untouched — defers to inflation/reactive strategies
  });

  test('residence-gated: ignores the non-residence country advance', () => {
    const out = r.reduce(stateAt(1961, 2026), { type: 'AU_PERIOD_ADVANCE' }); // US resident
    assert.strictEqual(out.monthlyExpenses, 5000);
    assert.strictEqual(out.explicitBandSpending, undefined);
  });

  test('no-op below the first band start age', () => {
    const out = r.reduce(stateAt(1970, 2026), { type: 'US_PERIOD_ADVANCE' }); // age 56 < 65
    assert.strictEqual(out.monthlyExpenses, 5000);
  });

  test('default bands are absolute monthly amounts', () => {
    assert.deepStrictEqual(DEFAULT_EXPENSE_BANDS.map(b => b.monthlyAmount), [7000, 6000, 5500]);
  });
});
