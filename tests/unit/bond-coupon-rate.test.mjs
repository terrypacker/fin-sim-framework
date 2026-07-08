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
 * Holding.couponRate (design 53 §4) — a per-holding FIXED bond coupon.
 *
 * A non-null `couponRate` is the bond's own contractual coupon: it pays that
 * stated rate on the fixed-income growth path regardless of where the
 * `effectiveInterestRates` regime moves, while its PRICE still marks to market
 * via `duration` (design 28). A null `couponRate` preserves today's behavior
 * (the coupon floats with the regime-adjusted rateKey rate). The override is
 * gated to the fixed-income path so equity growth never consults it.
 */

import { test, describe }        from 'node:test';
import assert                    from 'node:assert/strict';

import { computeHoldingsGrowth } from '../../src/finance/holdings/holdings-earnings.js';
import { BondPriceAdjustReducer } from '../../src/finance/economic-regimes/bond-price-adjust-reducer.js';
import { Holding }               from '../../src/finance/holdings/holding.js';
import { ALLOCATION }            from '../../src/finance/holdings/allocation.js';
import { RATE_KEYS }             from '../../src/finance/economic-regimes/rate-keys.js';

// ─── field plumbing ───────────────────────────────────────────────────────────

describe('Holding.couponRate field', () => {
  test('defaults to null', () => {
    const h = new Holding({ allocation: ALLOCATION.BOND });
    assert.equal(h.couponRate, null);
  });

  test('round-trips through toJSON/fromJSON', () => {
    const h  = new Holding({ allocation: ALLOCATION.BOND, couponRate: 0.055 });
    const h2 = Holding.fromJSON(h.toJSON());
    assert.equal(h2.couponRate, 0.055);
  });

  test('null couponRate round-trips', () => {
    const h  = new Holding({ allocation: ALLOCATION.BOND, couponRate: null });
    const h2 = Holding.fromJSON(h.toJSON());
    assert.equal(h2.couponRate, null);
  });
});

// ─── fixed coupon vs regime move (income) ─────────────────────────────────────

describe('computeHoldingsGrowth — couponRate on the fixed-income path', () => {
  const bondState = (couponRate, effRate) => {
    const h = new Holding({
      id: 'h1', allocation: ALLOCATION.BOND, marketValue: 100_000,
      rateKey: RATE_KEYS.FIXED_INCOME_US, couponRate,
    });
    h.id = 'h1';
    return {
      bondAccount: { balance: 100_000, holdings: [h] },
      effectiveInterestRates: { [RATE_KEYS.FIXED_INCOME_US]: effRate },
    };
  };

  test('a fixed couponRate pays its stated coupon even when the rate regime moves', () => {
    // Regime rate is 0.06, but the bond's fixed coupon is 0.04 → pays 0.04.
    const { amount } = computeHoldingsGrowth({
      state: bondState(0.04, 0.06), stateKey: 'bondAccount',
      fallbackRate: 0.05, fallbackRateKey: RATE_KEYS.FIXED_INCOME_US,
      rateSource: 'effectiveInterestRates',
    });
    assert.equal(amount, +(100_000 * 0.04).toFixed(2));
  });

  test('the fixed coupon is invariant across two different regime rates', () => {
    const opts = (state) => ({
      state, stateKey: 'bondAccount', fallbackRate: 0.05,
      fallbackRateKey: RATE_KEYS.FIXED_INCOME_US, rateSource: 'effectiveInterestRates',
    });
    const low  = computeHoldingsGrowth(opts(bondState(0.045, 0.02))).amount;
    const high = computeHoldingsGrowth(opts(bondState(0.045, 0.09))).amount;
    assert.equal(low, +(100_000 * 0.045).toFixed(2));
    assert.equal(high, low); // coupon untouched by the regime
  });

  test('null couponRate floats with the regime-adjusted rateKey rate (today\'s behavior)', () => {
    const { amount } = computeHoldingsGrowth({
      state: bondState(null, 0.06), stateKey: 'bondAccount',
      fallbackRate: 0.05, fallbackRateKey: RATE_KEYS.FIXED_INCOME_US,
      rateSource: 'effectiveInterestRates',
    });
    assert.equal(amount, +(100_000 * 0.06).toFixed(2));
  });

  test('a handler rateOverride still wins over a fixed couponRate (precedence)', () => {
    const { amount } = computeHoldingsGrowth({
      state: bondState(0.04, 0.06), stateKey: 'bondAccount',
      fallbackRate: 0.05, fallbackRateKey: RATE_KEYS.FIXED_INCOME_US,
      rateSource: 'effectiveInterestRates', rateOverride: 0.10,
    });
    assert.equal(amount, +(100_000 * 0.10).toFixed(2));
  });

  test('couponRate is monthly-scaled by factor like the rateKey rate', () => {
    const { amount } = computeHoldingsGrowth({
      state: bondState(0.06, 0.03), stateKey: 'bondAccount',
      fallbackRate: 0.05, fallbackRateKey: RATE_KEYS.FIXED_INCOME_US,
      rateSource: 'effectiveInterestRates', factor: 1 / 12,
    });
    assert.equal(amount, +(100_000 * 0.06 / 12).toFixed(2));
  });
});

// ─── gated off the equity growth path ─────────────────────────────────────────

describe('computeHoldingsGrowth — couponRate is ignored on the equity path', () => {
  test('a stray couponRate on the effectiveGrowthRates path does not override the growth rate', () => {
    const h = new Holding({
      id: 'h1', allocation: ALLOCATION.EQUITY, marketValue: 100_000,
      rateKey: RATE_KEYS.EQUITY_US, couponRate: 0.01, // stray; must be ignored
    });
    h.id = 'h1';
    const state = {
      equityAccount: { balance: 100_000, holdings: [h] },
      effectiveGrowthRates: { [RATE_KEYS.EQUITY_US]: 0.07 },
    };
    const { amount } = computeHoldingsGrowth({
      state, stateKey: 'equityAccount', fallbackRate: 0.07,
      fallbackRateKey: RATE_KEYS.EQUITY_US, // rateSource defaults to effectiveGrowthRates
    });
    assert.equal(amount, +(100_000 * 0.07).toFixed(2));
  });
});

// ─── price still marks to market via duration ─────────────────────────────────

describe('couponRate composes with duration mark-to-market', () => {
  test('a fixed-coupon bond\'s PRICE still moves when rates change; costBasis untouched', () => {
    const mv       = 100_000;
    const duration = 5.0;
    const prior    = 0.03;
    const current  = 0.05; // regime rise
    const h = new Holding({
      allocation: ALLOCATION.BOND, marketValue: mv, costBasis: mv,
      rateKey: RATE_KEYS.FIXED_INCOME_US, duration, couponRate: 0.04, // fixed coupon
    });
    h.id = 'h1';
    const state = {
      effectiveInterestRates: { [RATE_KEYS.FIXED_INCOME_US]: current },
      priorMarkRates:         { [RATE_KEYS.FIXED_INCOME_US]: prior },
      bondAccount: { balance: mv, holdings: [h] },
    };

    const next    = new BondPriceAdjustReducer().reduce(state, { type: 'US_PERIOD_ADVANCE' });
    const marked  = next.bondAccount.holdings[0];
    const expected = mv + (-(duration * (current - prior) * mv));
    assert.ok(Math.abs(marked.marketValue - expected) < 0.02,
      `Price should mark to ≈${expected}, got ${marked.marketValue}`);
    assert.equal(marked.costBasis, mv, 'costBasis is not moved by the duration mark');
    assert.equal(marked.couponRate, 0.04, 'the fixed coupon rides through unchanged');
  });
});
