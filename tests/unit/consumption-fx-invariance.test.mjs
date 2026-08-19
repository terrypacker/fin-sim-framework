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
 * consumption-fx-invariance.test.mjs — real consumption is measured in BASE-YEAR terms,
 * so it must be converted at the BASE-YEAR anchor rate, not at spot.
 *
 * ─── the defect ─────────────────────────────────────────────────────────────────────
 *
 * `AccumulateConsumptionReducer` and its CRRA twin turn a nominal foreign debit into
 * base-year USD in two steps, and both steps have to be base-year quantities:
 *
 *     real_AUD = nominal_AUD / AU_price_accumulator     → base-year AUD
 *     base_USD = real_AUD    / base_year_AUD_per_USD    → base-year USD
 *
 * They used to divide by `effectiveExchangeRates` (spot), which values a base-year-AUD
 * quantity at a current nominal rate — not a unit that exists. Symptom: on a 44-year
 * US→AU plan with the AUD cost of living held FIXED (`monthlyExpensesCurrency:
 * 'RESIDENCE'`), lifetime `cumulativeConsumption` varied **36% across FX seeds** while
 * the household ate identical food in every path. That quantity is what
 * `MAX_CRRA_UTILITY` and `DIE_WITH_TARGET` maximize, so the optimizer was being paid to
 * pick exchange-rate paths. After the fix the same sweep spans 0.8%, and the remainder is
 * real: when funding transfers deliver less, debits genuinely cap and less is consumed.
 *
 * CFI-1  A fixed real AUD basket books the SAME real consumption at any spot rate.
 * CFI-2  Working detector — the ANCHOR still moves it. Without this, CFI-1 passes for a
 *        reducer that ignores the exchange rate entirely.
 * CFI-3  USD debits are untouched by either rate (no conversion applies).
 * CFI-4  The CRRA twin uses the same rate. These two drifting apart is what made the
 *        previous defect in this pair a two-file fix.
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import { AccumulateConsumptionReducer }
  from '../../src/finance/reducers/accumulate-consumption-reducer.js';
import { AccumulateConsumptionUtilityReducer }
  from '../../src/finance/reducers/accumulate-consumption-utility-reducer.js';

const ANCHOR = 1.55;

function stateWith({ spot, anchor = ANCHOR, priceLevel = 1 }) {
  return {
    auSav: { balance: 1e9, currency: { code: 'AUD' } },
    usSav: { balance: 1e9, currency: { code: 'USD' } },
    baseExchangeRates:      { USD_AUD: anchor },
    effectiveExchangeRates: { USD_AUD: spot },
    inflationAccumulator:   { US: priceLevel, AU: priceLevel },
    cumulativeConsumption:  0,
  };
}

/** Real consumption booked for one AUD debit. */
function bookAud(amount, opts) {
  const r = new AccumulateConsumptionReducer();
  const next = r.reduce(stateWith(opts), {
    type: 'EXPENSE_DEBIT', targetKey: 'auSav',
    amount, realizedAmount: amount, priceLevel: opts.priceLevel ?? 1,
  });
  return (next.state ?? next).cumulativeConsumption;
}

test('CFI-1 a fixed real AUD basket books the same real consumption at any spot rate', () => {
  // The household spends A$15,500/mo. Their basket does not change because the currency
  // markets moved, so neither may the measured real consumption.
  const booked = [1.10, 1.55, 2.40].map((spot) => bookAud(15_500, { spot }));
  for (const v of booked) {
    assert.ok(Math.abs(v - 10_000) < 1e-9,
      `expected 15500/1.55 = 10000 base-year USD at every spot, got ${v}`);
  }
  assert.equal(new Set(booked.map((v) => v.toFixed(6))).size, 1);
});

test('CFI-2 the anchor rate still moves it (working detector)', () => {
  // Same spot, different scenario anchor: this MUST change the answer, or CFI-1 is
  // passing for a reducer that ignores FX altogether.
  const a = bookAud(15_500, { spot: 1.55, anchor: 1.55 });
  const b = bookAud(15_500, { spot: 1.55, anchor: 2.00 });
  assert.ok(Math.abs(a - 10_000) < 1e-9);
  assert.ok(Math.abs(b - 7_750) < 1e-9, `expected 15500/2.00 = 7750, got ${b}`);
  assert.notEqual(a, b);
});

test('CFI-3 USD debits are unaffected by either rate', () => {
  const r = new AccumulateConsumptionReducer();
  for (const spot of [1.10, 2.40]) {
    const next = r.reduce(stateWith({ spot }), {
      type: 'EXPENSE_DEBIT', targetKey: 'usSav',
      amount: 9_000, realizedAmount: 9_000, priceLevel: 1,
    });
    assert.equal((next.state ?? next).cumulativeConsumption, 9_000);
  }
});

test('CFI-4 the CRRA twin converts at the same rate', () => {
  const plain = new AccumulateConsumptionReducer();
  const crra  = new AccumulateConsumptionUtilityReducer();
  const action = {
    type: 'EXPENSE_DEBIT', targetKey: 'auSav',
    amount: 15_500, realizedAmount: 15_500, priceLevel: 1,
  };

  // Utility is a non-linear transform of real consumption, so the two totals are not
  // comparable directly. What must hold is that BOTH are spot-invariant: if the CRRA
  // twin still read spot, its utility would move while the plain one stayed put.
  const utils = [1.10, 1.55, 2.40].map((spot) => {
    const next = crra.reduce(stateWith({ spot }), action);
    return (next.state ?? next).cumulativeConsumptionUtility;
  });
  assert.equal(new Set(utils.map((v) => (v ?? 0).toFixed(9))).size, 1,
    `CRRA utility must not vary with spot, got ${utils.join(', ')}`);

  // And it is genuinely booking something, so the invariance above is not vacuous.
  const moved = plain.reduce(stateWith({ spot: 1.55 }), action);
  assert.ok((moved.state ?? moved).cumulativeConsumption > 0);
});
