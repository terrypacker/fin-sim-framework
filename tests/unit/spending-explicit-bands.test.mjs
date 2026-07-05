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

import { ExplicitBandsSpendingReducer, DEFAULT_EXPENSE_BANDS, repinExpensesIfChanged }
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
    s.explicitBandSpending = { appliedStartAge: 65, appliedAmount: 7000 };
    s.monthlyExpenses = 9999;            // some later inflation/guardrail-adjusted value
    const out = r.reduce(s, { type: 'US_PERIOD_ADVANCE' });
    close(out.monthlyExpenses, 9999);    // untouched — defers to inflation/reactive strategies
  });

  test('re-pins within a band when the amount itself changed (forward edit at "now")', () => {
    // apply-forward (design 39 §5): the freshly compiled reducer carries a new
    // band amount; the injected snapshot still holds the old appliedAmount, so
    // the next period advance must re-pin to the new amount.
    const r2 = new ExplicitBandsSpendingReducer({ bands: [{ startAge: 65, monthlyAmount: 9000 }] });
    const s = stateAt(1961, 2026);
    s.explicitBandSpending = { appliedStartAge: 65, appliedAmount: 7000 };
    s.monthlyExpenses = 7000;
    const out = r2.reduce(s, { type: 'US_PERIOD_ADVANCE' });
    close(out.monthlyExpenses, 9000);                          // re-pinned to the edited amount
    assert.strictEqual(out.explicitBandSpending.appliedAmount, 9000);
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

// ─── Immediate re-pin (design 39 Step 5b — forward-effective from "now") ───────

describe('repinExpensesIfChanged', () => {
  const asOf = year => Date.UTC(year, 5, 1);   // mid-year "now", off the period-advance grid

  // Active EXPLICIT_BANDS pin: age 65, currently pinned to 7000.
  function pinnedState(amount = 7000, priceLevel = 1.0) {
    const s = stateAt(1961, 2026, { priceLevel });
    s.explicitBandSpending = { appliedStartAge: 65, appliedAmount: amount };
    s.monthlyExpenses = 7000;
    s.expenses = { essential: 4900, discretionary: 2100 };  // 70/30
    return s;
  }

  test('re-pins immediately when the active band amount changed', () => {
    const patch = repinExpensesIfChanged(pinnedState(7000), [{ startAge: 65, monthlyAmount: 12000 }], asOf(2026));
    assert.ok(patch, 'a patch is returned for a changed amount');
    close(patch.monthlyExpenses, 12000);
    assert.strictEqual(patch.explicitBandSpending.appliedAmount, 12000);
    close(patch.expenses.discretionary, 12000 * 0.3);       // 70/30 ratio preserved
  });

  test('compounds the edited amount by the current residence price level', () => {
    const patch = repinExpensesIfChanged(pinnedState(7000, 1.25), [{ startAge: 65, monthlyAmount: 10000 }], asOf(2026));
    close(patch.monthlyExpenses, 10000 * 1.25);
  });

  test('returns null when the active band is unchanged (preserve within-band drift)', () => {
    const s = pinnedState(7000);
    s.monthlyExpenses = 9999;   // a reactive/inflation-bent value we must not clobber
    assert.strictEqual(repinExpensesIfChanged(s, [{ startAge: 65, monthlyAmount: 7000 }], asOf(2026)), null);
  });

  test('returns null when there is no active EXPLICIT_BANDS pin (e.g. AGE_BANDED run)', () => {
    const s = stateAt(1961, 2026);        // no explicitBandSpending stamp
    assert.strictEqual(repinExpensesIfChanged(s, [{ startAge: 65, monthlyAmount: 12000 }], asOf(2026)), null);
  });

  test('returns null below the first band start age', () => {
    const s = pinnedState(7000);
    s.people.p1.birthDate = '1980-01-01';   // age ~46 < 65
    assert.strictEqual(repinExpensesIfChanged(s, [{ startAge: 65, monthlyAmount: 12000 }], asOf(2026)), null);
  });
});
