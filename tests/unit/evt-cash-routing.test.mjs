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
 * evt-cash-routing.test.mjs
 *
 * Shared cash routing (design 55 Phase 6b). Phase 6a routed only wages/expenses
 * through the flagged transaction account; 6b routes the remaining ~30 cash-debit
 * / -credit sites (retirement contributions & withdrawals, brokerage, RMDs, house
 * / collectible sales, mortgage/loan payments, income) through one shared helper
 * `resolveCashKey(stateRegistry, country, state, ownerId)`. A flagged NON-default
 * account is now honored everywhere; with nothing flagged the chain falls back to
 * the SAVINGS-role key, so pre-flag scenarios stay byte-for-byte.
 *
 *   CASH-1 : resolveCashKey fallback chain (flagged → savings → checking legacy)
 *   CASH-2 : 401k / IRA / Roth contributions DEBIT the flagged account, not savings
 *   CASH-3 : 401k withdrawal + stock sale CREDIT the flagged account
 *   CASH-4 : AU super contribution debits the flagged AU account
 *   CASH-5 : loan payment stamps the flagged cash key on LOAN_PAYMENT_APPLY
 *   CASH-6 : unflagged parity — contributions debit savings byte-for-byte
 *   CASH-7 : AU fixed-income earnings honor action.stateKey (per-account) + fallback
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import { makeAccount, makeServices } from '../helpers/reducer-fixtures.js';
import { resolveCashKey, resolveDestinationCashKey } from '../../src/finance/account-rules/cash-routing.js';
import { CompanySaleApplyReducer }   from '../../src/finance/account-rules/us/us-income-classes.js';

import { K401ContributionApplyReducer, K401WithdrawalApplyReducer } from '../../src/finance/account-rules/us/k401-classes.js';
import { IraContributionApplyReducer }   from '../../src/finance/account-rules/us/ira-classes.js';
import { RothContributionApplyReducer }  from '../../src/finance/account-rules/us/roth-classes.js';
import { StockWithdrawalApplyReducer }   from '../../src/finance/account-rules/us/us-brokerage-classes.js';
import { SuperContributionApplyReducer } from '../../src/finance/account-rules/au/au-super-classes.js';
import { LoanPaymentHandler }            from '../../src/finance/account-rules/loan-classes.js';
import { AuFixedIncomeEarningsApplyReducer } from '../../src/finance/account-rules/au/au-fixed-income-classes.js';

/**
 * Services bundle whose registry resolves the SAVINGS role AND lets a test flag a
 * transaction account. `txnKey` null = nothing flagged (legacy fallback path).
 */
function services(txnKey = null) {
  const s = makeServices({ stateKeyByRole: { 'us-savings': 'usSavingsAccount', 'au-savings': 'auSavingsAccount' } });
  s.stateRegistry.resolveTransactionAccountKey = () => txnKey;
  return s;
}

const bal = (state, key) => Math.round(state[key]?.balance ?? NaN);

// ─── CASH-1: the helper's fallback chain ────────────────────────────────────────

test('CASH-1: resolveCashKey prefers the flagged account, then savings, then checking', () => {
  const withBoth = { usSavingsAccount: { balance: 1 }, usCheckingAccount: { balance: 1 } };
  const reg = { resolveTransactionAccountKey: (c) => (c === 'US' ? 'usCheckingAccount' : null),
                getStateKey: (role) => (role === 'us-savings' ? 'usSavingsAccount' : null) };

  assert.equal(resolveCashKey(reg, 'US', withBoth), 'usCheckingAccount',
    'a flagged account wins the chain');
  assert.equal(resolveCashKey({ resolveTransactionAccountKey: () => null,
                                getStateKey: (r) => (r === 'us-savings' ? 'usSavingsAccount' : null) },
                              'US', withBoth), 'usSavingsAccount',
    'nothing flagged → SAVINGS-role key (byte-for-byte legacy)');
  // No registry + no savings in state → the checking literal (final tail).
  assert.equal(resolveCashKey(undefined, 'US', { checkingAccount: { balance: 5 } }), 'checkingAccount',
    'no registry + no savings → checkingAccount literal');
  // Registry resolves a key that is absent from state → guard falls back to legacy.
  assert.equal(resolveCashKey({ resolveTransactionAccountKey: () => 'ghostAccount' },
                              'US', withBoth), 'usSavingsAccount',
    'a resolved key missing from state is discarded for the legacy key');
});

// ─── CASH-2: retirement contributions debit the flagged account ─────────────────

function usState() {
  return {
    usSavingsAccount:  makeAccount({ stateKey: 'usSavingsAccount',  balance: 40000 }),
    usCheckingAccount: makeAccount({ stateKey: 'usCheckingAccount', balance: 50000 }),
    k401Account: { ...makeAccount({ stateKey: 'k401Account', balance: 100000 }), contributionBasis: 0, earningsBasis: 0 },
    iraAccount:  { ...makeAccount({ stateKey: 'iraAccount',  balance: 80000 }),  contributionBasis: 0, earningsBasis: 0 },
    rothAccount: { ...makeAccount({ stateKey: 'rothAccount', balance: 60000 }),  contributionBasis: 0, earningsBasis: 0 },
    usStockAccount: makeAccount({ stateKey: 'usStockAccount', holdings: [{ marketValue: 50000, costBasis: 30000 }] }),
  };
}

test('CASH-2: 401k / IRA / Roth contributions debit the flagged checking account', () => {
  for (const Reducer of [K401ContributionApplyReducer, IraContributionApplyReducer, RothContributionApplyReducer]) {
    const svc   = services('usCheckingAccount');
    const state = usState();
    new Reducer({ accountService: svc.accountService, stateRegistry: svc.stateRegistry })
      .reduce(state, { amount: 1000 });
    assert.equal(bal(state, 'usCheckingAccount'), 49000, `${Reducer.name}: flagged checking debited`);
    assert.equal(bal(state, 'usSavingsAccount'),  40000, `${Reducer.name}: savings spared`);
  }
});

// ─── CASH-3: withdrawals / sales credit the flagged account ─────────────────────

test('CASH-3: 401k withdrawal and stock sale credit the flagged checking account', () => {
  const svc1 = services('usCheckingAccount');
  const s1   = usState();
  new K401WithdrawalApplyReducer({ accountService: svc1.accountService, stateRegistry: svc1.stateRegistry })
    .reduce(s1, { amount: 2000, penaltyAmount: 0 });
  assert.equal(bal(s1, 'usCheckingAccount'), 52000, '401k withdrawal credits flagged checking');
  assert.equal(bal(s1, 'usSavingsAccount'),  40000, 'savings spared on withdrawal');

  const svc2 = services('usCheckingAccount');
  const s2   = usState();
  new StockWithdrawalApplyReducer({ accountService: svc2.accountService, stateRegistry: svc2.stateRegistry })
    .reduce(s2, { salePrice: 10000, costBasis: 6000, residency: 'US' });
  assert.equal(bal(s2, 'usCheckingAccount'), 60000, 'stock-sale proceeds credit flagged checking');
  assert.equal(bal(s2, 'usSavingsAccount'),  40000, 'savings spared on stock sale');
});

// ─── CASH-4: AU super contribution ──────────────────────────────────────────────

test('CASH-4: AU super contribution debits the flagged AU checking account', () => {
  const svc = services('auCheckingAccount');
  const state = {
    auSavingsAccount:  makeAccount({ stateKey: 'auSavingsAccount',  country: 'AU', currency: 'AUD', balance: 30000 }),
    auCheckingAccount: makeAccount({ stateKey: 'auCheckingAccount', country: 'AU', currency: 'AUD', balance: 20000 }),
    superAccount: { ...makeAccount({ stateKey: 'superAccount', country: 'AU', currency: 'AUD', balance: 90000 }), contributionBasis: 0 },
  };
  new SuperContributionApplyReducer({ accountService: svc.accountService, stateRegistry: svc.stateRegistry })
    .reduce(state, { amount: 1500 });
  assert.equal(bal(state, 'auCheckingAccount'), 18500, 'flagged AU checking debited');
  assert.equal(bal(state, 'auSavingsAccount'),  30000, 'AU savings spared');
});

// ─── CASH-5: loan payment stamps the flagged cash key ───────────────────────────

test('CASH-5: loan payment stamps the flagged cash key on LOAN_PAYMENT_APPLY', () => {
  const svc = services('usCheckingAccount');
  const state = {
    usSavingsAccount:  makeAccount({ stateKey: 'usSavingsAccount',  balance: 40000 }),
    usCheckingAccount: makeAccount({ stateKey: 'usCheckingAccount', balance: 50000 }),
    houseLoan: { type: 'loan', stateKey: 'houseLoan', balance: 200000, interestRate: 0.05, monthlyPayment: 1500, country: 'US' },
    people: {},
  };
  const actions = new LoanPaymentHandler({ stateRegistry: svc.stateRegistry }).call({ state });
  const apply   = actions.find(a => a?.type === 'LOAN_PAYMENT_APPLY');
  assert.ok(apply, 'a LOAN_PAYMENT_APPLY is emitted');
  assert.equal(apply.cashKey, 'usCheckingAccount', 'the payment is drawn from the flagged account');

  // An explicit paymentSourceKey still wins over the flagged transaction account.
  state.houseLoan.paymentSourceKey = 'usSavingsAccount';
  const withSource = new LoanPaymentHandler({ stateRegistry: svc.stateRegistry }).call({ state })
    .find(a => a?.type === 'LOAN_PAYMENT_APPLY');
  assert.equal(withSource.cashKey, 'usSavingsAccount', 'an explicit paymentSourceKey overrides the flag');
});

// ─── CASH-6: unflagged parity ───────────────────────────────────────────────────

test('CASH-6: with nothing flagged, contributions debit savings (byte-for-byte legacy)', () => {
  const svc   = services(null);   // resolveTransactionAccountKey → null
  const state = usState();
  new K401ContributionApplyReducer({ accountService: svc.accountService, stateRegistry: svc.stateRegistry })
    .reduce(state, { amount: 1000 });
  assert.equal(bal(state, 'usSavingsAccount'),  39000, 'legacy path debits savings');
  assert.equal(bal(state, 'usCheckingAccount'), 50000, 'checking untouched when unflagged');
});

// ─── CASH-7: AU fixed-income per-account earnings (folded-in latent-key fix) ─────

test('CASH-7: AU fixed-income earnings credit the account named by action.stateKey', () => {
  const state = {
    auFixedIncomeAccount:       { balance: 50000 },
    spouseAuFixedIncomeAccount: { balance: 20000 },
  };
  const next = new AuFixedIncomeEarningsApplyReducer({}).reduce(
    state, { type: 'AU_FIXED_INCOME_EARNINGS_APPLY', amount: 100, stateKey: 'spouseAuFixedIncomeAccount', residency: 'AU' });
  assert.equal(next.spouseAuFixedIncomeAccount.balance, 20100, 'the stamped account accrues its own earnings');
  assert.equal(next.auFixedIncomeAccount.balance, 50000, 'the canonical account is untouched');

  const legacy = new AuFixedIncomeEarningsApplyReducer({}).reduce(
    { auFixedIncomeAccount: { balance: 50000 } },
    { type: 'AU_FIXED_INCOME_EARNINGS_APPLY', amount: 100, residency: 'AU' });
  assert.equal(legacy.auFixedIncomeAccount.balance, 50100, 'no stateKey → canonical key (legacy dispatchers)');
});

// ─── CASH-8: a stamped-but-absent destinationKey routes back to the flagged hub ─
// Regression: a sale handler stamps a legacy destinationKey (e.g. the canonical
// `usSavingsAccount`) that is later DELETED or reflagged. The bare
// `destinationKey ?? resolveCashKey(...)` idiom only caught null, so an absent-but-
// non-null key hit `transaction(undefined)` → "Cannot read properties of undefined
// (reading 'balance')". resolveDestinationCashKey guards existence and re-resolves
// through the flag-aware chain.

test('CASH-8: resolveDestinationCashKey guards a stale/absent stamped destinationKey', () => {
  const state = { usSavings2Account: { balance: 100 } };            // only the flagged hub exists
  const reg   = { resolveTransactionAccountKey: (c) => (c === 'US' ? 'usSavings2Account' : null) };

  // A valid explicit destination still wins.
  assert.equal(resolveDestinationCashKey(reg, 'US', state, 'usSavings2Account'), 'usSavings2Account');
  // A stamped key absent from state (the deleted canonical savings) is discarded
  // for the flag-aware resolution — NOT trusted just because it is non-null.
  assert.equal(resolveDestinationCashKey(reg, 'US', state, 'usSavingsAccount'), 'usSavings2Account');
  // No stamped key → resolve from scratch.
  assert.equal(resolveDestinationCashKey(reg, 'US', state, null), 'usSavings2Account');
});

test('CASH-8: CompanySaleApplyReducer credits the flagged hub when destinationKey was deleted', () => {
  const svc   = services('usSavings2Account');
  const state = { usSavings2Account: makeAccount({ stateKey: 'usSavings2Account', balance: 30000 }) };
  // The action carries a stale destinationKey pointing at the now-deleted savings account.
  const next = new CompanySaleApplyReducer({ accountService: svc.accountService, stateRegistry: svc.stateRegistry })
    .reduce(state, { salePrice: 500000, costBasis: 100000, residency: null,
                     stateKey: null, destinationKey: 'usSavingsAccount' });
  assert.equal(bal(next, 'usSavings2Account'), 530000, 'proceeds land in the flagged hub, no crash');
});
