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
 * Group C — US retirement reducers (IRA / 401k / Roth / Roth-conversion /
 * Roth-rollover / IRA-rollover). Design 37 §6 / §8.3.
 *
 * Patterns:
 *  - Contribution: debit usCash, credit account (balance + basis + scaleHoldings).
 *      → I3 (both sides), I5 (cash↔account, fee 0). Service-backed (no I1, §7.3).
 *  - Withdrawal (contrib/earnings): credit usCash net of penalty, debit account
 *      (scaleHoldings). → I3, I5 with fee = penalty.
 *  - RMD: credit usCash by amount, debit account. → I3, I5 (fee 0).
 *  - Conversion: debit IRA, credit Roth (both scaleHoldings). → I3 (both), I5.
 *  - Earnings: scalar balance + earningsBasis; §4.4 is event-level (see
 *      earnings-holdings-sync.test.mjs). Here: scalar contract + I1 (pure).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { assertBalanceInvariant, assertNonNegative, assertConserved } from '../helpers/reducer-postconditions.js';
import { makeAccount, makeServices } from '../helpers/reducer-fixtures.js';

import {
  IraContributionApplyReducer, IraWithdrawalContribApplyReducer,
  IraWithdrawalEarningsApplyReducer, IraEarningsApplyReducer,
} from '../../src/finance/account-rules/us/ira-classes.js';
import {
  K401ContributionApplyReducer, K401WithdrawalApplyReducer,
  K401RmdApplyReducer, K401EarningsApplyReducer,
} from '../../src/finance/account-rules/us/k401-classes.js';
import {
  RothContributionApplyReducer, RothWithdrawalContribApplyReducer,
  RothWithdrawalEarningsApplyReducer, RothEarningsApplyReducer,
} from '../../src/finance/account-rules/us/roth-classes.js';
import { RothConversionApplyReducer } from '../../src/finance/account-rules/us/roth-conversion-classes.js';
import {
  RothRolloverContributionApplyReducer, RothRolloverWithdrawalContribApplyReducer,
  RothRolloverWithdrawalEarningsApplyReducer, RothRolloverEarningsApplyReducer,
} from '../../src/finance/account-rules/us/roth-rollover-classes.js';
import {
  IraRolloverWithdrawalApplyReducer, IraRmdApplyReducer,
} from '../../src/finance/account-rules/us/ira-rollover-classes.js';

const DATE = new Date('2030-06-15');

/** Account node with a single holding sized to `balance`, plus scalar basis fields. */
function acct(stateKey, balance, extra = {}) {
  return { ...makeAccount({ stateKey, holdings: [{ id: `${stateKey}-h`, marketValue: balance, costBasis: balance }] }), ...extra };
}

/** US cash pool fixture. */
function usCashAcct(balance) {
  return makeAccount({ stateKey: 'usSavingsAccount', holdings: [{ id: 'cash-h', marketValue: balance, costBasis: balance }] });
}

/**
 * Run a service-backed account reducer and assert the standard bundle:
 * I3 (balance sync, all accounts), I4 (non-negative), and optional I5 conservation.
 * I1 is intentionally not checked — transaction() mutates in place (§7.3).
 */
function runAcct(reducer, state, action, { conserve, fee = 0 } = {}) {
  const prev = structuredClone(state);
  const next = reducer.reduce(state, action, DATE);
  assertBalanceInvariant(next);
  assertNonNegative(next);
  if (conserve) assertConserved(prev, next, conserve[0], conserve[1], { fee });
  return { prev, next };
}

// ─── Contributions ────────────────────────────────────────────────────────────

for (const [label, Reducer, type, key, basisField] of [
  ['IraContribution', IraContributionApplyReducer, 'IRA_CONTRIBUTION_APPLY', 'iraAccount', 'contributionBasis'],
  ['K401Contribution', K401ContributionApplyReducer, 'K401_CONTRIBUTION_APPLY', 'k401Account', 'contributionBasis'],
  ['RothContribution', RothContributionApplyReducer, 'ROTH_CONTRIBUTION_APPLY', 'rothAccount', 'contributionBasis'],
  ['RothRolloverContribution', RothRolloverContributionApplyReducer, 'ROTH_ROLLOVER_CONTRIBUTION_APPLY', 'rothAccount', 'rolloverContribBasis'],
]) {
  test(`${label}: debits cash, credits account, keeps §4.4 + conservation (I3/I5)`, () => {
    const services = makeServices();
    const state = {
      usSavingsAccount: usCashAcct(20000),
      [key]: acct(key, 50000, { contributionBasis: 50000, earningsBasis: 0, rolloverContribBasis: 50000 }),
    };
    const { next } = runAcct(new Reducer(services), state, { type, amount: 6000 },
      { conserve: ['usSavingsAccount', key], fee: 0 });
    assert.equal(next.usSavingsAccount.balance, 14000);
    assert.equal(next[key].balance, 56000);
    assert.equal(next[key][basisField], 56000);
  });
}

// ─── Withdrawals (penalty leaks out → fee = penalty) ──────────────────────────

for (const [label, Reducer, type, key] of [
  ['IraWithdrawalContrib', IraWithdrawalContribApplyReducer, 'IRA_WITHDRAWAL_CONTRIB_APPLY', 'iraAccount'],
  ['IraWithdrawalEarnings', IraWithdrawalEarningsApplyReducer, 'IRA_WITHDRAWAL_EARNINGS_APPLY', 'iraAccount'],
  ['K401Withdrawal', K401WithdrawalApplyReducer, 'K401_WITHDRAWAL_APPLY', 'k401Account'],
  ['RothWithdrawalEarnings', RothWithdrawalEarningsApplyReducer, 'ROTH_WITHDRAWAL_EARNINGS_APPLY', 'rothAccount'],
  ['RothRolloverWithdrawalContrib', RothRolloverWithdrawalContribApplyReducer, 'ROTH_ROLLOVER_WITHDRAWAL_CONTRIB_APPLY', 'rothAccount'],
  ['RothRolloverWithdrawalEarnings', RothRolloverWithdrawalEarningsApplyReducer, 'ROTH_ROLLOVER_WITHDRAWAL_EARNINGS_APPLY', 'rothAccount'],
]) {
  test(`${label}: credits cash net of penalty, debits account, keeps §4.4 (I3/I5 fee=penalty)`, () => {
    const services = makeServices();
    const state = {
      usSavingsAccount: usCashAcct(1000),
      [key]: acct(key, 50000, { contributionBasis: 30000, earningsBasis: 20000, rolloverContribBasis: 30000, rolloverEarningsBasis: 20000 }),
    };
    const penaltyAmount = 1000;
    const { next } = runAcct(new Reducer(services), state,
      { type, amount: 10000, penaltyAmount, residency: 'US' },
      { conserve: [key, 'usSavingsAccount'], fee: penaltyAmount });
    assert.equal(next[key].balance, 40000);
    assert.equal(next.usSavingsAccount.balance, 1000 + (10000 - penaltyAmount)); // 10000
  });
}

// Roth *contribution* withdrawals are penalty-free (basis already taxed) → fee 0.
test('RothWithdrawalContrib: credits cash by full amount, debits account, keeps §4.4 (I3/I5 fee=0)', () => {
  const services = makeServices();
  const state = {
    usSavingsAccount: usCashAcct(1000),
    rothAccount: acct('rothAccount', 50000, { contributionBasis: 30000, earningsBasis: 20000 }),
  };
  const { next } = runAcct(new RothWithdrawalContribApplyReducer(services), state,
    { type: 'ROTH_WITHDRAWAL_CONTRIB_APPLY', amount: 10000, penaltyAmount: 0 },
    { conserve: ['rothAccount', 'usSavingsAccount'], fee: 0 });
  assert.equal(next.rothAccount.balance, 40000);
  assert.equal(next.usSavingsAccount.balance, 11000);
});

// ─── RMDs (no penalty) ────────────────────────────────────────────────────────

for (const [label, Reducer, type, key] of [
  ['IraRmd', IraRmdApplyReducer, 'IRA_RMD_APPLY', 'iraAccount'],
  ['K401Rmd', K401RmdApplyReducer, 'K401_RMD_APPLY', 'k401Account'],
  ['IraRolloverWithdrawal', IraRolloverWithdrawalApplyReducer, 'IRA_ROLLOVER_WITHDRAWAL_APPLY', 'iraAccount'],
]) {
  test(`${label}: credits cash, debits account, keeps §4.4 + conservation (I3/I5)`, () => {
    const services = makeServices();
    const state = {
      usSavingsAccount: usCashAcct(5000),
      [key]: acct(key, 40000, { contributionBasis: 25000, earningsBasis: 15000 }),
    };
    const { next } = runAcct(new Reducer(services), state, { type, amount: 4000, residency: 'US' },
      { conserve: [key, 'usSavingsAccount'], fee: 0 });
    assert.equal(next[key].balance, 36000);
    assert.equal(next.usSavingsAccount.balance, 9000);
  });
}

// ─── Roth conversion (IRA → Roth, no cash pool) ───────────────────────────────

test('RothConversion: debits IRA, credits Roth, keeps §4.4 on both, conserves value (I3/I5)', () => {
  const state = {
    iraAccount: acct('iraAccount', 40000, { contributionBasis: 25000, earningsBasis: 15000 }),
    rothAccount: acct('rothAccount', 10000, { rolloverContribBasis: 0, rolloverConversions: [] }),
  };
  const { next } = runAcct(new RothConversionApplyReducer({}),
    state, { type: 'ROTH_CONVERSION_APPLY', amount: 12000, iraKey: 'iraAccount', rothKey: 'rothAccount', residency: 'US' },
    { conserve: ['iraAccount', 'rothAccount'], fee: 0 });
  assert.equal(next.iraAccount.balance, 28000);
  assert.equal(next.rothAccount.balance, 22000);
});

// ─── Earnings (scalar contract + I1; §4.4 is event-level) ─────────────────────

for (const [label, Reducer, type, key, basisField] of [
  ['IraEarnings', IraEarningsApplyReducer, 'IRA_EARNINGS_APPLY', 'iraAccount', 'earningsBasis'],
  ['K401Earnings', K401EarningsApplyReducer, 'K401_EARNINGS_APPLY', 'k401Account', 'earningsBasis'],
  ['RothEarnings', RothEarningsApplyReducer, 'ROTH_EARNINGS_APPLY', 'rothAccount', 'earningsBasis'],
  ['RothRolloverEarnings', RothRolloverEarningsApplyReducer, 'ROTH_ROLLOVER_EARNINGS_APPLY', 'rothAccount', 'rolloverEarningsBasis'],
]) {
  test(`${label}: increments scalar balance + basis, does not mutate input (I1)`, () => {
    const reducer = new Reducer({});
    const state = { [key]: acct(key, 50000, { earningsBasis: 1000, rolloverEarningsBasis: 1000 }) };
    const next = reducer.reduce(state, { type, amount: 2500, stateKey: key });
    assert.equal(next[key].balance, 52500);
    assert.equal(next[key][basisField], 3500);
    assert.equal(state[key].balance, 50000, 'I1: input not mutated');
  });
}
