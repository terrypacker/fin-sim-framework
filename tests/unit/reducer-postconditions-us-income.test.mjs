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
 * Group C — US income + real-property reducers. Design 37 §6 / §8.3.
 *
 * Income reducers credit/debit the US cash pool via transaction() against an
 * exogenous source (wages/SS/SE/bonus/company sale), so there is no cross-account
 * conservation — they pin I3 (cash balance == Σ holdings) + the expected delta.
 * WagesWithheld also bumps usWithheldYTD. UsHouseSale credits net proceeds and
 * zeroes the (scalar) property's value + mortgage.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { assertBalanceInvariant, assertNonNegative } from '../helpers/reducer-postconditions.js';
import { makeAccount, makeServices } from '../helpers/reducer-fixtures.js';

import {
  SsIncomeApplyReducer, WagesIncomeApplyReducer, WagesWithheldApplyReducer,
  SeIncomeUsApplyReducer, BonusApplyReducer, CompanySaleApplyReducer,
} from '../../src/finance/account-rules/us/us-income-classes.js';
import { UsHouseSaleApplyReducer } from '../../src/finance/account-rules/us/us-real-property-classes.js';

const DATE = new Date('2030-06-15');

function usCashAcct(balance) {
  return makeAccount({ stateKey: 'usSavingsAccount', holdings: [{ id: 'cash-h', marketValue: balance, costBasis: balance }] });
}
function runAcct(reducer, state, action) {
  const next = reducer.reduce(state, action, DATE);
  assertBalanceInvariant(next);
  assertNonNegative(next);
  return next;
}

// ─── Income credits (exogenous source → I3 on cash only) ──────────────────────

for (const [label, Reducer, type] of [
  ['SsIncome', SsIncomeApplyReducer, 'SS_INCOME_APPLY'],
  ['WagesIncome', WagesIncomeApplyReducer, 'WAGES_INCOME_APPLY'],
  ['SeIncomeUs', SeIncomeUsApplyReducer, 'SE_INCOME_US_APPLY'],
  ['Bonus', BonusApplyReducer, 'BONUS_APPLY'],
]) {
  test(`${label}: credits US cash pool, keeps §4.4 on cash (I3)`, () => {
    const state = { usSavingsAccount: usCashAcct(10000) };
    const next = runAcct(new Reducer(makeServices()), state, { type, amount: 4000, residency: 'US' });
    assert.equal(next.usSavingsAccount.balance, 14000);
  });
}

test('WagesWithheld: debits US cash pool and increments usWithheldYTD (I3)', () => {
  const state = { usSavingsAccount: usCashAcct(10000), usWithheldYTD: 500 };
  const next = runAcct(new WagesWithheldApplyReducer(makeServices()), state, { type: 'WAGES_WITHHELD_APPLY', amount: 1200 });
  assert.equal(next.usSavingsAccount.balance, 8800);
  assert.equal(next.usWithheldYTD, 1700);
});

test('CompanySale: credits US cash pool with sale proceeds (I3)', () => {
  const state = { usSavingsAccount: usCashAcct(5000) };
  const next = runAcct(new CompanySaleApplyReducer(makeServices()), state,
    { type: 'COMPANY_SALE_APPLY', salePrice: 250000, costBasis: 100000, residency: 'US' });
  assert.equal(next.usSavingsAccount.balance, 255000);
});

// ─── Real property (scalar value asset) ───────────────────────────────────────

test('UsHouseSale: credits net proceeds to cash, zeroes property value + mortgage (I3)', () => {
  const state = {
    usSavingsAccount: usCashAcct(1000),
    usHouse: { value: 800000, mortgageBalance: 300000 },
  };
  const next = runAcct(new UsHouseSaleApplyReducer(makeServices()), state, {
    type: 'US_HOUSE_SALE_APPLY', salePrice: 900000, costBasis: 500000, mortgageBalance: 300000,
    stateKey: 'usHouse', destinationKey: 'usSavingsAccount',
  });
  // net proceeds = salePrice - mortgage = 600000
  assert.equal(next.usSavingsAccount.balance, 601000);
  assert.equal(next.usHouse.value, 0);
  assert.equal(next.usHouse.mortgageBalance, 0);
});
