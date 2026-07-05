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
 * §4.4 for the *EarningsApplyReducer family is an EVENT-LEVEL invariant
 * (design 37 §2 I3, §7.2). The earnings *reducer* updates only the scalar
 * account.balance (CASH_FLOW); the active earnings *handler* emits, in the same
 * batch, one HoldingTransactAction per sleeve (marketValueDelta = growth,
 * costBasisDelta = 0 — appreciation does not raise basis), which
 * HoldingTransactReducer (POSITION_UPDATE) applies and re-syncs balance to
 * Σ marketValue. So §4.4 holds after the action batch, not after the earnings
 * reducer alone.
 *
 * These tests drive that real two-step path (computeHoldingsGrowth →
 * *_EARNINGS_APPLY reducer → HOLDING_TRANSACT) and assert §4.4 holds — single
 * and multi-holding. This is the green replacement for the earlier `todo`
 * (which asserted §4.4 after the reducer alone, the wrong granularity).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { computeHoldingsGrowth } from '../../src/finance/holdings/holdings-earnings.js';
import { HoldingTransactReducer } from '../../src/finance/holdings/holding-reducers.js';
import { assertBalanceInvariant, sumHoldings } from '../helpers/reducer-postconditions.js';
import { makeAccount } from '../helpers/reducer-fixtures.js';

import { AuFixedIncomeEarningsApplyReducer } from '../../src/finance/account-rules/au/au-fixed-income-classes.js';
import { StockEarningsApplyReducer } from '../../src/finance/account-rules/us/us-brokerage-classes.js';

/**
 * Replay one earnings event the way the active handler does: compute per-holding
 * growth, run the *_EARNINGS_APPLY reducer (scalar balance), then apply each
 * paired HOLDING_TRANSACT and re-sync. Returns the resulting state + total.
 */
function runEarningsEvent(reducer, applyType, state, stateKey, rate, { rateSource = 'effectiveGrowthRates', factor = 1, actionExtra = {} } = {}) {
  const { amount, holdingActions } = computeHoldingsGrowth({
    state, stateKey, fallbackRate: rate, fallbackRateKey: null, rateSource, factor, rateOverride: rate,
  });
  let s = reducer.reduce(state, { type: applyType, amount, stateKey, ...actionExtra });
  const htr = new HoldingTransactReducer();
  for (const a of holdingActions) s = htr.reduce(s, a);
  return { next: s, amount, holdingActions };
}

test('AU fixed income earnings: balance + paired HOLDING_TRANSACT keeps §4.4 (single holding)', () => {
  const state = {
    effectiveInterestRates: {},
    auFixedIncomeAccount: makeAccount({ stateKey: 'auFixedIncomeAccount', currency: 'AUD', holdings: [{ id: 'h1', marketValue: 10000, costBasis: 10000 }] }),
  };
  const { next, amount } = runEarningsEvent(
    new AuFixedIncomeEarningsApplyReducer({}), 'AU_FIXED_INCOME_EARNINGS_APPLY',
    state, 'auFixedIncomeAccount', 0.06, { rateSource: 'effectiveInterestRates', actionExtra: { residency: 'AU' } },
  );
  assert.equal(amount, 600);
  assert.equal(next.auFixedIncomeAccount.balance, 10600);
  assert.equal(sumHoldings(next.auFixedIncomeAccount), 10600);
  // costBasis unchanged — appreciation creates unrealized gain, does not raise basis.
  assert.equal(next.auFixedIncomeAccount.holdings[0].costBasis, 10000);
  assertBalanceInvariant(next, ['auFixedIncomeAccount']);
});

test('US stock earnings: §4.4 holds across a multi-holding (60/40) sleeve split', () => {
  const account = makeAccount({
    stateKey: 'usStockAccount', currency: 'USD',
    holdings: [
      { id: 'eq', marketValue: 6000, costBasis: 4000 },
      { id: 'bd', marketValue: 4000, costBasis: 4000 },
    ],
  });
  const state = { effectiveGrowthRates: {}, usStockAccount: { ...account, earningsBasis: 0 } };
  const { next, amount } = runEarningsEvent(
    new StockEarningsApplyReducer({}), 'STOCK_EARNINGS_APPLY', state, 'usStockAccount', 0.10,
  );
  // 10% on each sleeve: 600 + 400 = 1000.
  assert.equal(amount, 1000);
  assert.equal(next.usStockAccount.balance, 11000);
  assert.equal(sumHoldings(next.usStockAccount), 11000);
  // Each sleeve grew its marketValue; basis untouched.
  assert.equal(next.usStockAccount.holdings.find(h => h.id === 'eq').marketValue, 6600);
  assert.equal(next.usStockAccount.holdings.find(h => h.id === 'eq').costBasis, 4000);
  assert.equal(next.usStockAccount.holdings.find(h => h.id === 'bd').marketValue, 4400);
  assertBalanceInvariant(next, ['usStockAccount']);
});

test('earnings event with zero rate is a clean no-op (no holding actions, §4.4 trivially holds)', () => {
  const state = {
    effectiveGrowthRates: {},
    usStockAccount: { ...makeAccount({ stateKey: 'usStockAccount', holdings: [{ id: 'h1', marketValue: 5000, costBasis: 5000 }] }), earningsBasis: 0 },
  };
  const { next, amount, holdingActions } = runEarningsEvent(
    new StockEarningsApplyReducer({}), 'STOCK_EARNINGS_APPLY', state, 'usStockAccount', 0,
  );
  assert.equal(amount, 0);
  assert.equal(holdingActions.length, 0);
  assert.equal(next.usStockAccount.balance, 5000);
  assertBalanceInvariant(next, ['usStockAccount']);
});
