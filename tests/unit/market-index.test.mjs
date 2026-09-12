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
 * market-index.test.mjs — design 101 §6 (M1): market and security index levels.
 *
 * The invariant that makes the index honest (§6.1): a lone β = 1 lot with no flows, in an
 * account on the bare market key, has marketValue / marketValue₀ × 100 equal to the index
 * at every year boundary — `total` on the wrapper path, `price` on the taxable one. It is
 * checked against the REAL growth function and the REAL shock reducer, so the index is
 * held to the thing it claims to summarise rather than to itself.
 */

import { test }  from 'node:test';
import assert    from 'node:assert/strict';

import {
  MarketIndexReducer, seedIndexLevels, stepIndexLevels, markDownIndexLevels,
  yearEndsBetween, lastYearEndBefore, INDEX_BASE,
} from '../../src/finance/economic-regimes/market-index.js';
import { RevalueAssetReducer }    from '../../src/finance/economic-regimes/revalue-asset-reducer.js';
import { computeHoldingsGrowth }  from '../../src/finance/holdings/holdings-earnings.js';
import { runReducer, assertStateUnchanged } from '../helpers/reducer-postconditions.js';
import { makeAction }             from '../helpers/reducer-fixtures.js';

const ms  = (y, m = 1, d = 1) => Date.UTC(y, m - 1, d);
const at  = (y, m = 1, d = 1) => new Date(ms(y, m, d));
const near = (a, b, rel = 1e-9) => Math.abs(a - b) <= rel * Math.max(1, Math.abs(b));

// ── Calendar helpers ────────────────────────────────────────────────────────

test('year-ends: the 31 Dec dates in (from, to]', () => {
  assert.equal(yearEndsBetween(ms(2025, 12, 31), ms(2027, 1, 1)), 1);
  assert.equal(yearEndsBetween(ms(2026, 12, 31), ms(2027, 1, 1)), 0, 'already counted');
  assert.equal(yearEndsBetween(ms(2026, 12, 31), ms(2027, 7, 1)), 0, 'the AU advance after the US one');
  assert.equal(yearEndsBetween(ms(2025, 12, 31), ms(2028, 1, 1)), 2);
  assert.equal(yearEndsBetween(ms(2025, 12, 31), ms(2026, 12, 31)), 1, 'inclusive of `to`');
  assert.equal(lastYearEndBefore(ms(2026, 1, 1)),   ms(2025, 12, 31));
  assert.equal(lastYearEndBefore(ms(2026, 12, 31)), ms(2025, 12, 31), 'a start ON 31 Dec still has that growth to come');
  assert.equal(lastYearEndBefore(ms(2026, 3, 1)),   ms(2025, 12, 31));
});

// ── Seeding ─────────────────────────────────────────────────────────────────

const BASE_STATE = {
  baseGrowthRates:      { EQUITY_US: 0.07, GOLD: 0.03 },
  effectiveGrowthRates: { EQUITY_US: 0.07, GOLD: 0.03, 'EQUITY_US::iraAccount': 0.09 },
  marketDividendYields: { EQUITY_US: 0.015 },
  securities: {
    'sec-auto-EQUITY_US': { id: 'sec-auto-EQUITY_US', rateKey: 'EQUITY_US' },
    'sec-emp':            { id: 'sec-emp', rateKey: 'EQUITY_US', dividendYield: 0.005 },
    'sec-odd':            { id: 'sec-odd', rateKey: 'NOT_A_MARKET' },
  },
};

test('seed: 100 for every market and every security tracking one; nothing without growth rates', () => {
  const seed = seedIndexLevels(BASE_STATE, ms(2026));
  assert.deepEqual(Object.keys(seed.marketIndex), ['EQUITY_US', 'GOLD'], 'per-account keys excluded (§6.1)');
  assert.deepEqual(seed.marketIndex.EQUITY_US, { price: INDEX_BASE, total: INDEX_BASE });
  assert.deepEqual(Object.keys(seed.securityIndex), ['sec-auto-EQUITY_US', 'sec-emp']);
  assert.equal(seed.marketIndexAsOfMs, ms(2025, 12, 31));
  assert.deepEqual(seedIndexLevels({ securities: {} }, ms(2026)), {});
});

// ── The step ────────────────────────────────────────────────────────────────

function seeded(extra = {}) {
  return { ...BASE_STATE, ...seedIndexLevels(BASE_STATE, ms(2026)), ...extra };
}

test('step: price by total − yield, total by the total; a security adds its overlay and its own yield', () => {
  const next = stepIndexLevels(seeded({ securityReturnOverlay: { 'sec-emp': 0.02 } }), 1);
  assert.ok(near(next.marketIndex.EQUITY_US.total, 107));
  assert.ok(near(next.marketIndex.EQUITY_US.price, 105.5));
  assert.ok(near(next.marketIndex.GOLD.price, 103), 'no yield: price = total');
  assert.ok(near(next.securityIndex['sec-auto-EQUITY_US'].price, 105.5), 'an identity security is its market');
  assert.ok(near(next.securityIndex['sec-emp'].total, 109), '0.07 + overlay 0.02');
  assert.ok(near(next.securityIndex['sec-emp'].price, 108.5), '0.07 − own yield 0.005 + 0.02');
});

test('reducer: steps once at the first advance after a 31 Dec, with the rates before the reset', () => {
  const r = new MarketIndexReducer();
  const s0 = seeded();
  const s1 = runReducer(r, s0, makeAction('US_PERIOD_ADVANCE', {}), at(2027, 1, 1));
  assert.ok(near(s1.marketIndex.EQUITY_US.total, 107));
  assert.equal(s1.marketIndexAsOfMs, ms(2026, 12, 31));
  // The AU advance six months later finds no new year-end: no second step.
  const s2 = runReducer(r, s1, makeAction('AU_PERIOD_ADVANCE', {}), at(2027, 7, 1));
  assertStateUnchanged(s1, s2);
});

test('reducer: an advance at sim start (before any 31 Dec) does not step', () => {
  const r = new MarketIndexReducer();
  const s0 = seeded();
  assertStateUnchanged(s0, runReducer(r, s0, makeAction('US_PERIOD_ADVANCE', {}), at(2026, 1, 1)));
});

test('reducer: no index in state (no regimes toolset) is a no-op', () => {
  const r = new MarketIndexReducer();
  const s0 = { effectiveGrowthRates: { EQUITY_US: 0.07 } };
  assertStateUnchanged(s0, runReducer(r, s0, makeAction('US_PERIOD_ADVANCE', {}), at(2027)));
});

test('reducer: priority sits after the period advance and before the regime reset', () => {
  const p = new MarketIndexReducer().priority;
  assert.ok(p > 10 && p < 11, `priority ${p}`);
});

// ── Shocks ──────────────────────────────────────────────────────────────────

test('shock: the market and its securities take the multiplier; other markets do not', () => {
  const patch = markDownIndexLevels(seeded(), 'EQUITY_US', -0.4);
  assert.ok(near(patch.marketIndex.EQUITY_US.price, 60));
  assert.deepEqual(patch.marketIndex.GOLD, { price: 100, total: 100 });
  assert.ok(near(patch.securityIndex['sec-emp'].total, 60));
  assert.deepEqual(markDownIndexLevels(seeded(), 'PROPERTY_US', -0.2), {}, 'no level for that key');
});

test('shock: RevalueAssetReducer marks the index down even with no account to revalue', () => {
  const next = new RevalueAssetReducer().reduce(seeded(),
    { type: 'REVALUE_ASSET_APPLY', rateKey: 'EQUITY_US', multiplier: -0.25, holdingsStateKeys: [], targetStateKeys: [] });
  assert.ok(near(next.marketIndex.EQUITY_US.total, 75));
});

// ── The invariant: a lone lot tracks its index (§6.1) ───────────────────────

/** Run `years` of real year-end growth + real advances + one real shock on a lone lot. */
function track({ yieldPaidSeparately }) {
  const r = new MarketIndexReducer();
  const shock = new RevalueAssetReducer();
  const mv0 = 10_000_000;
  let state = {
    ...seeded(),
    acct: { country: 'US', balance: mv0, holdings: [
      { id: 'h1', allocation: 'EQUITY', rateKey: 'EQUITY_US', securityId: 'sec-auto-EQUITY_US', marketValue: mv0, costBasis: mv0 },
    ] },
  };
  const rates = [0.07, -0.12, 0.21, 0.035, 0.0, 0.09, -0.3, 0.15];
  const pairs = [];
  rates.forEach((rate, i) => {
    const year = 2026 + i;
    state = { ...state, effectiveGrowthRates: { ...state.effectiveGrowthRates, EQUITY_US: rate } };
    if (i === 3) {   // a mid-year crash
      state = shock.reduce(state, { type: 'REVALUE_ASSET_APPLY', rateKey: 'EQUITY_US', multiplier: -0.35,
        holdingsStateKeys: ['acct'], targetStateKeys: [] });
    }
    // 31 Dec: the real growth path, as the earnings handlers call it.
    const { holdingActions } = computeHoldingsGrowth({
      state, stateKey: 'acct', fallbackRate: rate, fallbackRateKey: 'EQUITY_US', yieldPaidSeparately,
    });
    const h = state.acct.holdings[0];
    const delta = holdingActions[0]?.marketValueDelta ?? 0;
    state = { ...state, acct: { ...state.acct, holdings: [{ ...h, marketValue: h.marketValue + delta }] } };
    // 1 Jan: the advance steps the index with the same rate, before any reset.
    state = r.reduce(state, makeAction('US_PERIOD_ADVANCE', {}), at(year + 1, 1, 1));
    pairs.push([state.acct.holdings[0].marketValue / mv0 * 100, state.marketIndex.EQUITY_US]);
  });
  return pairs;
}

test('invariant: a wrapper lot tracks marketIndex.total through gains, losses and a crash', () => {
  for (const [lot, idx] of track({ yieldPaidSeparately: false })) {
    assert.ok(near(lot, idx.total, 1e-8), `lot ${lot} vs total ${idx.total}`);
  }
});

test('invariant: a taxable lot (yield paid out) tracks marketIndex.price', () => {
  for (const [lot, idx] of track({ yieldPaidSeparately: true })) {
    assert.ok(near(lot, idx.price, 1e-8), `lot ${lot} vs price ${idx.price}`);
  }
});
