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

import { AccumulateTaxesPaidReducer }   from '../../src/finance/reducers/accumulate-taxes-paid-reducer.js';
import { AccumulateConsumptionReducer } from '../../src/finance/reducers/accumulate-consumption-reducer.js';

const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);

// ─── AccumulateTaxesPaidReducer ───────────────────────────────────────────────

describe('AccumulateTaxesPaidReducer', () => {
  const r = new AccumulateTaxesPaidReducer();

  test('reduces all three tax-settle action types', () => {
    assert.deepStrictEqual(
      r.reducedActionTypes,
      ['US_TAX_SETTLE_APPLY', 'AU_TAX_SETTLE_APPLY', 'STATE_TAX_SETTLE_APPLY']);
  });

  test('US tax accumulates as USD unchanged', () => {
    const out = r.reduce({ cumulativeTaxesPaid: 1000 }, { type: 'US_TAX_SETTLE_APPLY', tax: 250 });
    close(out.cumulativeTaxesPaid, 1250);
  });

  test('US-state tax accumulates as USD unchanged', () => {
    const out = r.reduce({ cumulativeTaxesPaid: 0 }, { type: 'STATE_TAX_SETTLE_APPLY', tax: 80 });
    close(out.cumulativeTaxesPaid, 80);
  });

  test('AU tax is FX-converted to USD before accumulating', () => {
    const state = { cumulativeTaxesPaid: 0, effectiveExchangeRates: { USD_AUD: 1.5 } };
    const out = r.reduce(state, { type: 'AU_TAX_SETTLE_APPLY', tax: 1500 }); // 1500 AUD / 1.5 = 1000 USD
    close(out.cumulativeTaxesPaid, 1000);
  });

  test('zero tax is a no-op (field preserved)', () => {
    const out = r.reduce({ cumulativeTaxesPaid: 42 }, { type: 'US_TAX_SETTLE_APPLY', tax: 0 });
    close(out.cumulativeTaxesPaid, 42);
  });
});

// ─── AccumulateConsumptionReducer ─────────────────────────────────────────────

describe('AccumulateConsumptionReducer', () => {
  const r = new AccumulateConsumptionReducer();

  test('USD spending is deflated to base-year dollars', () => {
    const state = {
      cumulativeConsumption: 0,
      usSavingsAccount: { currency: { code: 'USD' } },
      inflationAccumulator: { US: 1.1 },
    };
    const out = r.reduce(state, { type: 'EXPENSE_DEBIT', amount: 1100, targetKey: 'usSavingsAccount' });
    close(out.cumulativeConsumption, 1000); // 1100 nominal / 1.1 price level
  });

  test('AUD spending is FX-converted then deflated by the AU price level', () => {
    const state = {
      cumulativeConsumption: 0,
      auSavingsAccount: { currency: 'AUD' },
      effectiveExchangeRates: { USD_AUD: 1.5 },
      inflationAccumulator: { AU: 1.2 },
    };
    const out = r.reduce(state, { type: 'EXPENSE_DEBIT', amount: 1800, targetKey: 'auSavingsAccount' });
    close(out.cumulativeConsumption, 1000); // 1800 AUD /1.5 = 1200 USD /1.2 = 1000 real
  });

  test('missing price level defaults to no deflation', () => {
    const state = { cumulativeConsumption: 5, usSavingsAccount: { currency: { code: 'USD' } } };
    const out = r.reduce(state, { type: 'EXPENSE_DEBIT', amount: 100, targetKey: 'usSavingsAccount' });
    close(out.cumulativeConsumption, 105);
  });
});
