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
 * evt-multi-savings.test.mjs
 *
 * Multiple savings accounts (design 55 §7 / Phase 6a). Savings interest is now
 * credited per-account by the stateKey the handler stamps, so a second savings
 * account (e.g. a spouse's) earns its own interest instead of having it
 * misattributed to the canonical single account.
 *
 * Run with: node --test tests/unit/evt-multi-savings.test.mjs
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import { makeAccount, makeServices }      from '../helpers/reducer-fixtures.js';
import { AuSavingsEarningsApplyReducer }  from '../../src/finance/account-rules/au/au-savings-classes.js';
import { UsSavingsInterestCreditReducer } from '../../src/finance/reducers/us-savings-interest-credit-reducer.js';
import { ACCOUNT_ROLES }                  from '../../src/finance/state/account-roles.js';

function savings(stateKey, balance) {
  return makeAccount({ stateKey, holdings: [{ id: `${stateKey}-h`, marketValue: balance, costBasis: balance }] });
}

test('AU savings earnings: credits the account named by action.stateKey (per-account)', () => {
  const state = {
    auSavingsAccount:       savings('auSavingsAccount', 50000),
    spouseAuSavingsAccount: savings('spouseAuSavingsAccount', 20000),
  };
  const next = new AuSavingsEarningsApplyReducer({}).reduce(
    state, { type: 'AU_SAVINGS_EARNINGS_APPLY', amount: 75, stateKey: 'spouseAuSavingsAccount', residency: 'AU' });
  assert.equal(next.spouseAuSavingsAccount.balance, 20075, 'the stamped (spouse) account earns its own interest');
  assert.equal(next.auSavingsAccount.balance, 50000, 'the primary account is untouched');
  assert.equal(state.spouseAuSavingsAccount.balance, 20000, 'input state not mutated (I1)');
});

test('AU savings earnings: falls back to auSavingsAccount when the action carries no stateKey (legacy)', () => {
  const state = { auSavingsAccount: savings('auSavingsAccount', 50000) };
  const next = new AuSavingsEarningsApplyReducer({}).reduce(
    state, { type: 'AU_SAVINGS_EARNINGS_APPLY', amount: 100, residency: 'AU' });
  assert.equal(next.auSavingsAccount.balance, 50100, 'legacy single-account path still credits auSavingsAccount');
});

test('US savings interest credit: credits the account named by action.stateKey (per-account)', () => {
  const svc   = makeServices();
  const state = {
    usSavingsAccount:       savings('usSavingsAccount', 40000),
    spouseUsSavingsAccount: savings('spouseUsSavingsAccount', 10000),
    usOrdinaryIncomeYTD: 0, people: {},
  };
  const r = new UsSavingsInterestCreditReducer({
    accountService: svc.accountService, stateRegistry: svc.stateRegistry,
    role: ACCOUNT_ROLES.US_SAVINGS, ownerId: 'primary',
  });
  // A single reducer (keyed to the primary) must still route a spouse account's
  // interest to the spouse account — the pre-6a bug landed it on the primary.
  const next = r.reduce(
    state, { type: 'US_SAVINGS_INTEREST_CREDIT', amount: 60, stateKey: 'spouseUsSavingsAccount' },
    new Date('2030-01-31'));
  assert.equal(Math.round(next.spouseUsSavingsAccount.balance), 10060, 'spouse account is credited');
  assert.equal(Math.round(next.usSavingsAccount.balance), 40000, 'primary account is untouched');
});
