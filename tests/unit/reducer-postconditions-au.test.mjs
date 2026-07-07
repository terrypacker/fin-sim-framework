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
 * Group C — AU reducers (savings / super / brokerage / income / real property).
 * Design 37 §6 / §8.3.
 *
 *  - Contribution / withdrawal (savings, super): cash-pool transaction() on both
 *      sides → I3 (both), I5 (fee 0). Service-backed (no I1, §7.3).
 *  - AU stock withdrawal (sale): FIFO-consume holdings, credit AU cash → I3/I5.
 *  - AU dividends (franked/unfranked × resident/NR) + earnings: scalar balance/basis;
 *      §4.4 is event-level (handler emits computeHoldingsDividends/Growth actions —
 *      earnings-holdings-sync.test.mjs). Here: scalar contract + I1.
 *  - AU SE income / house sale: exogenous credit to AU cash pool → I3 on cash.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { assertBalanceInvariant, assertNonNegative, assertConserved } from '../helpers/reducer-postconditions.js';
import { makeAccount, makeServices } from '../helpers/reducer-fixtures.js';

import {
  AuSavingsContributionApplyReducer, AuSavingsWithdrawalApplyReducer, AuSavingsEarningsApplyReducer,
} from '../../src/finance/account-rules/au/au-savings-classes.js';
import {
  SuperContributionApplyReducer, SuperWithdrawalContribApplyReducer,
  SuperWithdrawalEarningsApplyReducer, SuperEarningsApplyReducer,
} from '../../src/finance/account-rules/au/au-super-classes.js';
import {
  AuDividendFrankedResidentApplyReducer, AuDividendFrankedNonResidentApplyReducer,
  AuDividendUnfrankedResidentApplyReducer, AuDividendUnfrankedNonResidentApplyReducer,
  AuStockEarningsApplyReducer, AuStockWithdrawalApplyReducer,
} from '../../src/finance/account-rules/au/au-brokerage-classes.js';
import { AuSeIncomeApplyReducer, AuWagesIncomeApplyReducer } from '../../src/finance/account-rules/au/au-income-classes.js';
import { AuHouseSaleApplyReducer } from '../../src/finance/account-rules/au/au-real-property-classes.js';

const DATE = new Date('2030-06-15');

function acct(stateKey, balance, currency = 'AUD', extra = {}) {
  return { ...makeAccount({ stateKey, currency, holdings: [{ id: `${stateKey}-h`, marketValue: balance, costBasis: balance }] }), ...extra };
}
function runAcct(reducer, state, action, { conserve, fee = 0 } = {}) {
  const prev = structuredClone(state);
  const next = reducer.reduce(state, action, DATE);
  assertBalanceInvariant(next);
  assertNonNegative(next);
  if (conserve) assertConserved(prev, next, conserve[0], conserve[1], { fee });
  return { prev, next };
}

// ─── AU savings ───────────────────────────────────────────────────────────────

test('AuSavingsContribution: checking → auSavings, synced + conserved (I3/I5)', () => {
  const state = { checkingAccount: acct('checkingAccount', 20000), auSavingsAccount: acct('auSavingsAccount', 30000) };
  const { next } = runAcct(new AuSavingsContributionApplyReducer(makeServices()), state,
    { type: 'AU_SAVINGS_CONTRIBUTION_APPLY', amount: 5000 }, { conserve: ['checkingAccount', 'auSavingsAccount'], fee: 0 });
  assert.equal(next.checkingAccount.balance, 15000);
  assert.equal(next.auSavingsAccount.balance, 35000);
});

test('AuSavingsWithdrawal: auSavings → checking, synced + conserved (I3/I5)', () => {
  const state = { checkingAccount: acct('checkingAccount', 5000), auSavingsAccount: acct('auSavingsAccount', 30000) };
  const { next } = runAcct(new AuSavingsWithdrawalApplyReducer(makeServices()), state,
    { type: 'AU_SAVINGS_WITHDRAWAL_APPLY', amount: 5000 }, { conserve: ['auSavingsAccount', 'checkingAccount'], fee: 0 });
  assert.equal(next.auSavingsAccount.balance, 25000);
  assert.equal(next.checkingAccount.balance, 10000);
});

test('AuSavingsEarnings: scalar balance increment, input not mutated (I1)', () => {
  const state = { auSavingsAccount: acct('auSavingsAccount', 30000) };
  const next = new AuSavingsEarningsApplyReducer({}).reduce(state, { type: 'AU_SAVINGS_EARNINGS_APPLY', amount: 120, residency: 'AU' });
  assert.equal(next.auSavingsAccount.balance, 30120);
  assert.equal(state.auSavingsAccount.balance, 30000, 'I1');
});

// ─── AU super ─────────────────────────────────────────────────────────────────

test('SuperContribution: auCash → super (+basis), synced + conserved (I3/I5)', () => {
  const state = { auSavingsAccount: acct('auSavingsAccount', 20000), superAccount: acct('superAccount', 50000, 'AUD', { contributionBasis: 50000, earningsBasis: 0 }) };
  const { next } = runAcct(new SuperContributionApplyReducer(makeServices()), state,
    { type: 'SUPER_CONTRIBUTION_APPLY', amount: 6000 }, { conserve: ['auSavingsAccount', 'superAccount'], fee: 0 });
  assert.equal(next.superAccount.balance, 56000);
  assert.equal(next.superAccount.contributionBasis, 56000);
});

for (const [label, Reducer, type] of [
  ['SuperWithdrawalContrib', SuperWithdrawalContribApplyReducer, 'SUPER_WITHDRAWAL_CONTRIB_APPLY'],
  ['SuperWithdrawalEarnings', SuperWithdrawalEarningsApplyReducer, 'SUPER_WITHDRAWAL_EARNINGS_APPLY'],
]) {
  test(`${label}: credits auCash, debits super, synced + conserved (I3/I5)`, () => {
    const state = { auSavingsAccount: acct('auSavingsAccount', 5000), superAccount: acct('superAccount', 50000, 'AUD', { contributionBasis: 30000, earningsBasis: 20000 }) };
    const { next } = runAcct(new Reducer(makeServices()), state, { type, amount: 8000, blocked: false },
      { conserve: ['superAccount', 'auSavingsAccount'], fee: 0 });
    assert.equal(next.superAccount.balance, 42000);
    assert.equal(next.auSavingsAccount.balance, 13000);
  });

  test(`${label}: blocked withdrawal moves no money (only sets flag)`, () => {
    const state = { auSavingsAccount: acct('auSavingsAccount', 5000), superAccount: acct('superAccount', 50000, 'AUD', { contributionBasis: 30000, earningsBasis: 20000 }) };
    const { next } = runAcct(new Reducer(makeServices()), state, { type, amount: 8000, blocked: true });
    assert.equal(next.superAccount.balance, 50000);
    assert.equal(next.auSavingsAccount.balance, 5000);
    assert.equal(next.superWithdrawalBlocked, true);
  });
}

test('SuperEarnings: scalar balance + earningsBasis, input not mutated (I1)', () => {
  const state = { superAccount: acct('superAccount', 50000, 'AUD', { earningsBasis: 0 }) };
  const next = new SuperEarningsApplyReducer({}).reduce(state, { type: 'SUPER_EARNINGS_APPLY', amount: 3000, stateKey: 'superAccount', taxRate: 0.15 });
  assert.equal(next.superAccount.balance, 53000);
  assert.equal(next.superAccount.earningsBasis, 3000);
  assert.equal(state.superAccount.balance, 50000, 'I1');
});

// ─── AU brokerage ─────────────────────────────────────────────────────────────

for (const [label, Reducer, type] of [
  ['AuDividendFrankedResident', AuDividendFrankedResidentApplyReducer, 'AU_DIVIDEND_FRANKED_RESIDENT_APPLY'],
  ['AuDividendFrankedNonResident', AuDividendFrankedNonResidentApplyReducer, 'AU_DIVIDEND_FRANKED_NONRESIDENT_APPLY'],
  ['AuDividendUnfrankedResident', AuDividendUnfrankedResidentApplyReducer, 'AU_DIVIDEND_UNFRANKED_RESIDENT_APPLY'],
  ['AuDividendUnfrankedNonResident', AuDividendUnfrankedNonResidentApplyReducer, 'AU_DIVIDEND_UNFRANKED_NONRESIDENT_APPLY'],
]) {
  test(`${label}: scalar balance increment, input not mutated (I1; §4.4 event-level)`, () => {
    const state = { auStockAccount: acct('auStockAccount', 40000, 'AUD') };
    const next = new Reducer({}).reduce(state, { type, amount: 700 });
    // Brokerage basis is no longer tracked (design 53 P1).
    assert.equal(next.auStockAccount.balance, 40700);
    assert.equal(state.auStockAccount.balance, 40000, 'I1');
  });
}

test('AuStockEarnings: scalar balance increment, input not mutated (I1)', () => {
  const state = { auStockAccount: acct('auStockAccount', 40000, 'AUD') };
  const next = new AuStockEarningsApplyReducer({}).reduce(state, { type: 'AU_STOCK_EARNINGS_APPLY', amount: 3500 });
  assert.equal(next.auStockAccount.balance, 43500);
  assert.equal(state.auStockAccount.balance, 40000, 'I1');
});

test('AuStockWithdrawal: FIFO-consume holdings, credit AU cash by salePrice, synced + conserved (I3/I5)', () => {
  const state = {
    auSavingsAccount: acct('auSavingsAccount', 5000),
    auStockAccount: acct('auStockAccount', 50000, 'AUD', { contributionBasis: 30000, earningsBasis: 20000 }),
  };
  const { next } = runAcct(new AuStockWithdrawalApplyReducer(makeServices()), state,
    { type: 'AU_STOCK_WITHDRAWAL_APPLY', salePrice: 10000, residency: 'AU' },
    { conserve: ['auStockAccount', 'auSavingsAccount'], fee: 0 });
  assert.equal(next.auStockAccount.balance, 40000);
  assert.equal(next.auSavingsAccount.balance, 15000);
});

// ─── AU income + real property ────────────────────────────────────────────────

test('AuSeIncome: credits AU cash pool, keeps §4.4 on cash (I3)', () => {
  const state = { auSavingsAccount: acct('auSavingsAccount', 10000) };
  const { next } = runAcct(new AuSeIncomeApplyReducer(makeServices()), state, { type: 'SE_INCOME_AU_APPLY', amount: 4000, residency: 'AU' });
  assert.equal(next.auSavingsAccount.balance, 14000);
});

test('AuWagesIncome: credits AU cash pool with native AUD (I3)', () => {
  const state = { auSavingsAccount: acct('auSavingsAccount', 10000) };
  const { next } = runAcct(new AuWagesIncomeApplyReducer(makeServices()), state, { type: 'AU_WAGES_INCOME_APPLY', amount: 2000, residency: 'US', personKey: 'spouse' });
  assert.equal(next.auSavingsAccount.balance, 12000);
});

test('AuHouseSale: credits net proceeds to AU cash, zeroes property (I3)', () => {
  const state = {
    auSavingsAccount: acct('auSavingsAccount', 1000),
    auHouse: { value: 800000, mortgageBalance: 200000 },
  };
  const { next } = runAcct(new AuHouseSaleApplyReducer(makeServices()), state, {
    type: 'AU_HOUSE_SALE_APPLY', salePrice: 900000, costBasis: 500000, mortgageBalance: 200000,
    residency: 'AU', stateKey: 'auHouse', destinationKey: 'auSavingsAccount',
  });
  assert.equal(next.auSavingsAccount.balance, 701000); // 900000 - 200000 mortgage + 1000
  assert.equal(next.auHouse.value, 0);
  assert.equal(next.auHouse.mortgageBalance, 0);
});
