/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { test, describe, beforeEach } from 'node:test';
import assert                         from 'node:assert/strict';

import { BondPriceAdjustReducer } from '../../src/finance/economic-regimes/bond-price-adjust-reducer.js';
import { ALLOCATION }             from '../../src/finance/holdings/allocation.js';
import { RATE_KEYS, RATE_KEY_META } from '../../src/finance/economic-regimes/rate-keys.js';
import { Holding }                from '../../src/finance/holdings/holding.js';

// ─── RATE_KEY_META defaults ───────────────────────────────────────────────────

describe('RATE_KEY_META', () => {
  test('FIXED_INCOME_US has defaultDuration 5.0', () => {
    assert.equal(RATE_KEY_META[RATE_KEYS.FIXED_INCOME_US]?.defaultDuration, 5.0);
  });

  test('FIXED_INCOME_AU has defaultDuration 5.0', () => {
    assert.equal(RATE_KEY_META[RATE_KEYS.FIXED_INCOME_AU]?.defaultDuration, 5.0);
  });

  test('EQUITY_US has no defaultDuration (non-bond)', () => {
    assert.equal(RATE_KEY_META[RATE_KEYS.EQUITY_US], undefined);
  });
});

// ─── BondPriceAdjustReducer ───────────────────────────────────────────────────

/**
 * Build a minimal state with one fixed-income account holding.
 */
function buildState({ effectiveRate, priorRate, marketValue, duration = null, rateKey = RATE_KEYS.FIXED_INCOME_US }) {
  const holding = new Holding({
    allocation:  ALLOCATION.BOND,
    marketValue,
    rateKey,
    duration,
  });
  holding.id = 'h1';

  return {
    effectiveInterestRates: { [rateKey]: effectiveRate },
    priorMarkRates:         { [rateKey]: priorRate },
    fixedIncomeAccount: {
      balance: marketValue,
      holdings: [holding],
    },
  };
}

describe('BondPriceAdjustReducer', () => {
  let reducer;
  beforeEach(() => { reducer = new BondPriceAdjustReducer(); });

  test('rate rise drops bond price: Δprice ≈ -D × Δr × P', () => {
    const mv       = 100_000;
    const duration = 7.0;
    const prior    = 0.03;
    const current  = 0.04;
    const state    = buildState({ effectiveRate: current, priorRate: prior, marketValue: mv, duration });

    const next = reducer.reduce(state, { type: 'US_PERIOD_ADVANCE' });
    const nextHolding = next.fixedIncomeAccount.holdings[0];
    const expected = mv + (-(duration * (current - prior) * mv));
    assert.ok(Math.abs(nextHolding.marketValue - expected) < 0.02, `Expected ≈${expected}, got ${nextHolding.marketValue}`);
  });

  test('rate fall raises bond price', () => {
    const mv       = 100_000;
    const duration = 5.0;
    const prior    = 0.05;
    const current  = 0.03;
    const state    = buildState({ effectiveRate: current, priorRate: prior, marketValue: mv, duration });

    const next = reducer.reduce(state, { type: 'US_PERIOD_ADVANCE' });
    const nextHolding = next.fixedIncomeAccount.holdings[0];
    assert.ok(nextHolding.marketValue > mv, 'Rate fall should raise bond price');
  });

  test('costBasis is unchanged', () => {
    const state = buildState({ effectiveRate: 0.04, priorRate: 0.03, marketValue: 100_000, duration: 5.0 });
    state.fixedIncomeAccount.holdings[0].costBasis = 95_000;

    const next = reducer.reduce(state, { type: 'US_PERIOD_ADVANCE' });
    assert.equal(next.fixedIncomeAccount.holdings[0].costBasis, 95_000);
  });

  test('holding.duration ?? RATE_KEY_META default is used when duration is null', () => {
    const mv    = 100_000;
    const prior = 0.03;
    const cur   = 0.04;
    const meta  = RATE_KEY_META[RATE_KEYS.FIXED_INCOME_US].defaultDuration;

    const state1 = buildState({ effectiveRate: cur, priorRate: prior, marketValue: mv, duration: null });
    const state2 = buildState({ effectiveRate: cur, priorRate: prior, marketValue: mv, duration: meta });

    const next1 = reducer.reduce(state1, { type: 'US_PERIOD_ADVANCE' });
    const next2 = reducer.reduce(state2, { type: 'US_PERIOD_ADVANCE' });

    assert.equal(
      next1.fixedIncomeAccount.holdings[0].marketValue,
      next2.fixedIncomeAccount.holdings[0].marketValue,
    );
  });

  test('non-bond holding under same rate key is not adjusted', () => {
    const equityH = new Holding({
      allocation: ALLOCATION.EQUITY, marketValue: 50_000,
      rateKey:    RATE_KEYS.FIXED_INCOME_US,
    });
    equityH.id = 'h2';

    const state = {
      effectiveInterestRates: { [RATE_KEYS.FIXED_INCOME_US]: 0.04 },
      priorMarkRates:         { [RATE_KEYS.FIXED_INCOME_US]: 0.03 },
      equityAccount: { balance: 50_000, holdings: [equityH] },
    };

    const next = reducer.reduce(state, { type: 'US_PERIOD_ADVANCE' });
    assert.equal(next.equityAccount.holdings[0].marketValue, 50_000);
  });

  test('no-duration rateKey (e.g. EQUITY_US) is a no-op', () => {
    const bondH = new Holding({
      allocation:  ALLOCATION.BOND,
      marketValue: 100_000,
      rateKey:     RATE_KEYS.EQUITY_US,
      duration:    null,
    });
    bondH.id = 'h3';

    const state = {
      effectiveInterestRates: { [RATE_KEYS.EQUITY_US]: 0.07 },
      priorMarkRates:         { [RATE_KEYS.EQUITY_US]: 0.05 },
      bondAccount: { balance: 100_000, holdings: [bondH] },
    };

    const next = reducer.reduce(state, { type: 'US_PERIOD_ADVANCE' });
    assert.equal(next.bondAccount.holdings[0].marketValue, 100_000, 'No-duration key should be a no-op');
  });

  test('first period (empty priorMarkRates) is a no-op', () => {
    const state = buildState({ effectiveRate: 0.04, priorRate: 0.04, marketValue: 100_000, duration: 5.0 });
    state.priorMarkRates = {};

    const next = reducer.reduce(state, { type: 'US_PERIOD_ADVANCE' });
    assert.equal(next.fixedIncomeAccount.holdings[0].marketValue, 100_000);
  });

  test('priorMarkRates is updated after each period', () => {
    const state = buildState({ effectiveRate: 0.04, priorRate: 0.03, marketValue: 100_000, duration: 5.0 });
    const next  = reducer.reduce(state, { type: 'US_PERIOD_ADVANCE' });
    assert.equal(next.priorMarkRates[RATE_KEYS.FIXED_INCOME_US], 0.04);
  });

  test('balance re-syncs to Σ marketValue after mark', () => {
    const mv    = 100_000;
    const state = buildState({ effectiveRate: 0.04, priorRate: 0.03, marketValue: mv, duration: 5.0 });
    const next  = reducer.reduce(state, { type: 'US_PERIOD_ADVANCE' });
    const holding = next.fixedIncomeAccount.holdings[0];
    assert.equal(next.fixedIncomeAccount.balance, +holding.marketValue.toFixed(2));
  });
});

// ─── Holding.duration field ───────────────────────────────────────────────────

describe('Holding.duration', () => {
  test('defaults to null', () => {
    const h = new Holding({ allocation: ALLOCATION.BOND });
    assert.equal(h.duration, null);
  });

  test('round-trips through toJSON/fromJSON', () => {
    const h = new Holding({ allocation: ALLOCATION.BOND, duration: 7.5 });
    const h2 = Holding.fromJSON(h.toJSON());
    assert.equal(h2.duration, 7.5);
  });

  test('null duration round-trips', () => {
    const h  = new Holding({ allocation: ALLOCATION.BOND, duration: null });
    const h2 = Holding.fromJSON(h.toJSON());
    assert.equal(h2.duration, null);
  });
});
