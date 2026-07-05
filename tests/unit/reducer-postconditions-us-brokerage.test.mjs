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
 * Group C — US brokerage (stock / fixed income) + collectible reducers.
 * Design 37 §6 / §8.3.
 *
 *  - Fixed-income contribution/withdrawal: two transaction() calls (cash + account)
 *      → I3 both, I5 (fee 0).
 *  - Stock contribution: cash debit + account credit (+contributionBasis) → I3/I5.
 *  - Stock dividend: stays in account, reinvested into holdings (distributeHoldingsCredit)
 *      → I3 (single account), no cross-account conservation.
 *  - Stock withdrawal (sale): FIFO-consume holdings, credit cash by salePrice → I3/I5.
 *  - Earnings: scalar (event-level §4.4, see earnings-holdings-sync) → I1.
 *  - Collectible sale: scalar `value` asset → credit cash by salePrice, value→0.
 *  - Collectible value change: scalar `value` += change (pure, I1).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { assertBalanceInvariant, assertNonNegative, assertConserved, sumHoldings } from '../helpers/reducer-postconditions.js';
import { makeAccount, makeServices } from '../helpers/reducer-fixtures.js';

import {
  FixedIncomeContributionApplyReducer, FixedIncomeWithdrawalApplyReducer, FixedIncomeEarningsApplyReducer,
  StockContributionApplyReducer, StockDividendApplyReducer, StockEarningsApplyReducer, StockWithdrawalApplyReducer,
} from '../../src/finance/account-rules/us/us-brokerage-classes.js';
import {
  CollectibleSaleApplyReducer, CollectibleValueChangeApplyReducer,
} from '../../src/finance/account-rules/us/us-collectible-classes.js';

const DATE = new Date('2030-06-15');

function acct(stateKey, balance, extra = {}) {
  return { ...makeAccount({ stateKey, holdings: [{ id: `${stateKey}-h`, marketValue: balance, costBasis: balance }] }), ...extra };
}
function usCashAcct(balance) {
  return makeAccount({ stateKey: 'usSavingsAccount', holdings: [{ id: 'cash-h', marketValue: balance, costBasis: balance }] });
}
function runAcct(reducer, state, action, { conserve, fee = 0 } = {}) {
  const prev = structuredClone(state);
  const next = reducer.reduce(state, action, DATE);
  assertBalanceInvariant(next);
  assertNonNegative(next);
  if (conserve) assertConserved(prev, next, conserve[0], conserve[1], { fee });
  return { prev, next };
}

// ─── Fixed income ─────────────────────────────────────────────────────────────

test('FixedIncomeContribution: cash debit + account credit, both synced + conserved (I3/I5)', () => {
  const state = { usSavingsAccount: usCashAcct(20000), fixedIncomeAccount: acct('fixedIncomeAccount', 30000) };
  const { next } = runAcct(new FixedIncomeContributionApplyReducer(makeServices()), state,
    { type: 'FIXED_INCOME_CONTRIBUTION_APPLY', amount: 5000 }, { conserve: ['usSavingsAccount', 'fixedIncomeAccount'], fee: 0 });
  assert.equal(next.usSavingsAccount.balance, 15000);
  assert.equal(next.fixedIncomeAccount.balance, 35000);
});

test('FixedIncomeWithdrawal: account debit + cash credit, both synced + conserved (I3/I5)', () => {
  const state = { usSavingsAccount: usCashAcct(5000), fixedIncomeAccount: acct('fixedIncomeAccount', 30000) };
  const { next } = runAcct(new FixedIncomeWithdrawalApplyReducer(makeServices()), state,
    { type: 'FIXED_INCOME_WITHDRAWAL_APPLY', amount: 5000 }, { conserve: ['fixedIncomeAccount', 'usSavingsAccount'], fee: 0 });
  assert.equal(next.fixedIncomeAccount.balance, 25000);
  assert.equal(next.usSavingsAccount.balance, 10000);
});

test('FixedIncomeEarnings: scalar balance increment, input not mutated (I1)', () => {
  const state = { fixedIncomeAccount: acct('fixedIncomeAccount', 30000) };
  const next = new FixedIncomeEarningsApplyReducer({}).reduce(state, { type: 'FIXED_INCOME_EARNINGS_APPLY', amount: 150, residency: 'US' });
  assert.equal(next.fixedIncomeAccount.balance, 30150);
  assert.equal(state.fixedIncomeAccount.balance, 30000, 'I1');
});

// ─── Stock ────────────────────────────────────────────────────────────────────

test('StockContribution: cash debit + account credit (+basis), synced + conserved (I3/I5)', () => {
  const state = { usSavingsAccount: usCashAcct(20000), usStockAccount: acct('usStockAccount', 40000, { contributionBasis: 40000, earningsBasis: 0 }) };
  const { next } = runAcct(new StockContributionApplyReducer(makeServices()), state,
    { type: 'STOCK_CONTRIBUTION_APPLY', amount: 6000 }, { conserve: ['usSavingsAccount', 'usStockAccount'], fee: 0 });
  assert.equal(next.usStockAccount.balance, 46000);
  assert.equal(next.usStockAccount.contributionBasis, 46000);
});

test('StockDividend: reinvested into holdings, balance == Σmv (§4.4, single account)', () => {
  const state = { usStockAccount: acct('usStockAccount', 40000, { contributionBasis: 30000, earningsBasis: 10000 }) };
  const { next } = runAcct(new StockDividendApplyReducer({}), state,
    { type: 'STOCK_DIVIDEND_APPLY', amount: 800, residency: 'US' });
  assert.equal(next.usStockAccount.balance, 40800);
  assert.equal(sumHoldings(next.usStockAccount), 40800);
  assert.equal(next.usStockAccount.contributionBasis, 30800);
  assert.equal(next.usStockAccount.earningsBasis, 10800);
});

test('StockEarnings: scalar balance + earningsBasis, input not mutated (I1)', () => {
  const state = { usStockAccount: acct('usStockAccount', 40000, { earningsBasis: 0 }) };
  const next = new StockEarningsApplyReducer({}).reduce(state, { type: 'STOCK_EARNINGS_APPLY', amount: 4000, stateKey: 'usStockAccount' });
  assert.equal(next.usStockAccount.balance, 44000);
  assert.equal(next.usStockAccount.earningsBasis, 4000);
  assert.equal(state.usStockAccount.balance, 40000, 'I1');
});

test('StockWithdrawal: FIFO-consume holdings, credit cash by salePrice, synced + conserved (I3/I5)', () => {
  const state = {
    usSavingsAccount: usCashAcct(5000),
    usStockAccount: acct('usStockAccount', 50000, { contributionBasis: 30000, earningsBasis: 20000 }),
  };
  const { next } = runAcct(new StockWithdrawalApplyReducer(makeServices()), state,
    { type: 'STOCK_WITHDRAWAL_APPLY', salePrice: 10000, residency: 'US' },
    { conserve: ['usStockAccount', 'usSavingsAccount'], fee: 0 });
  assert.equal(next.usStockAccount.balance, 40000);
  assert.equal(next.usSavingsAccount.balance, 15000);
});

// ─── Collectible (scalar value asset) ─────────────────────────────────────────

test('CollectibleSale: credits cash by salePrice, zeroes collectible value (I3 on cash)', () => {
  const state = { usSavingsAccount: usCashAcct(1000), collectibleAccount: { value: 25000 } };
  const { next } = runAcct(new CollectibleSaleApplyReducer(makeServices()), state,
    { type: 'COLLECTIBLE_SALE_APPLY', salePrice: 30000, costBasis: 25000, residency: 'US', stateKey: 'collectibleAccount', destinationKey: 'usSavingsAccount' });
  assert.equal(next.usSavingsAccount.balance, 31000);
  assert.equal(next.collectibleAccount.value, 0);
});

test('CollectibleValueChange: scalar value += change (pure, I1); missing entry is a no-op (I7)', () => {
  const r = new CollectibleValueChangeApplyReducer({});
  const state = { collectibleAccount: { value: 25000 } };
  const next = r.reduce(state, { type: 'COLLECTIBLE_VALUE_CHANGE_APPLY', stateKey: 'collectibleAccount', change: 3000 });
  assert.equal(next.collectibleAccount.value, 28000);
  assert.equal(state.collectibleAccount.value, 25000, 'I1');

  const missing = r.reduce({ collectibleAccount: { value: 1 } }, { type: 'COLLECTIBLE_VALUE_CHANGE_APPLY', stateKey: 'nope', change: 5 });
  assert.equal(missing.collectibleAccount.value, 1, 'I7: unknown key leaves state unchanged');
});
