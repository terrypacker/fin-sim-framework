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
 * evt-loan.test.mjs — LoanAccount (liability) + interest accrual (design 54 P1).
 *
 * A standalone loan (car/student/personal, no property) must:
 *   - amortize: each LOAN_PAYMENT splits into interest (balance × rate / 12) and
 *     principal (payment − interest); the balance falls and the interest portion
 *     shrinks month over month;
 *   - grow under negative amortization (payment < interest) and flag it;
 *   - count as NEGATIVE net worth (owed principal);
 *   - be excluded from drawdown/replenish (never a source of cash);
 *   - round-trip through the serializer with its loan fields intact.
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import { EventBus }       from '../../src/simulation-framework/event-bus.js';
import { Graph }          from '../../src/graph/graph.js';
import { GraphQueryApi }  from '../../src/graph/graph-query-api.js';
import { AccountService } from '../../src/finance/services/account-service.js';
import { USD, AUD, CheckingAccount, SavingsAccount, LoanAccount } from '../../src/finance/assets/account.js';
import { LoanPaymentHandler, UsLoanPaymentHandler, AuLoanPaymentHandler, LoanPaymentApplyReducer } from '../../src/finance/account-rules/loan-classes.js';
import { computeNetWorth } from '../../src/finance/derived-metrics/net-worth.js';
import { ScenarioSerializer } from '../../src/scenarios/scenario-serializer.js';

const near = (a, b, eps = 0.01) => Math.abs(a - b) < eps;

function makeSvc() {
  const g = new Graph();
  return new AccountService(g, new GraphQueryApi(g), new EventBus());
}

/** One monthly cycle: run the handler, apply each LOAN_PAYMENT_APPLY via the reducer. */
function payOnce(svc, state) {
  const handler = new LoanPaymentHandler();
  const reducer = new LoanPaymentApplyReducer({ accountService: svc });
  const actions = handler.call({ state });
  let next = state;
  for (const a of actions) {
    if (a.type === 'LOAN_PAYMENT_APPLY') next = reducer.reduce(next, a);
  }
  return { next, actions };
}

// ── Amortization ──────────────────────────────────────────────────────────────

test('LOAN: one payment splits into interest + principal and debits cash', () => {
  const svc = makeSvc();
  const state = {
    usSavingsAccount: new SavingsAccount(50_000, { country: 'US', currency: USD }),
    carLoan: new LoanAccount(100_000, { country: 'US', currency: USD, interestRate: 0.06, monthlyPayment: 1_000 }),
  };
  const { next } = payOnce(svc, state);
  // interest = 100000 × 0.06/12 = 500; principal = 1000 − 500 = 500 → balance 99500.
  assert.ok(near(next.carLoan.balance, 99_500), `balance ${next.carLoan.balance}`);
  // Full P&I payment (1000) leaves the cash pool.
  assert.ok(near(next.usSavingsAccount.balance, 49_000), `cash ${next.usSavingsAccount.balance}`);
});

test('LOAN: amortizes over months — balance falls and the interest portion shrinks', () => {
  const svc = makeSvc();
  let state = {
    usSavingsAccount: new SavingsAccount(50_000, { country: 'US', currency: USD }),
    loan: new LoanAccount(100_000, { country: 'US', currency: USD, interestRate: 0.06, monthlyPayment: 1_000 }),
  };
  let prevBalance = state.loan.balance;
  let prevInterest = Infinity;
  for (let m = 0; m < 6; m++) {
    const interest = state.loan.balance * 0.06 / 12; // what this month accrues
    ({ next: state } = payOnce(svc, state));
    assert.ok(state.loan.balance < prevBalance, `month ${m}: balance should fall`);
    assert.ok(interest < prevInterest, `month ${m}: interest portion should shrink`);
    prevBalance = state.loan.balance;
    prevInterest = interest;
  }
});

// ── Negative amortization ───────────────────────────────────────────────────

test('LOAN: payment below interest grows the balance and flags negative amortization', () => {
  const svc = makeSvc();
  const state = {
    usSavingsAccount: new SavingsAccount(50_000, { country: 'US', currency: USD }),
    loan: new LoanAccount(100_000, { country: 'US', currency: USD, interestRate: 0.12, monthlyPayment: 500 }),
  };
  const { next, actions } = payOnce(svc, state);
  // interest = 100000 × 0.12/12 = 1000 > payment 500 → principal −500 → balance grows to 100500.
  assert.ok(near(next.loan.balance, 100_500), `balance ${next.loan.balance}`);
  assert.ok(actions.some(a => a.type === 'loan_negative_amortization'),
    'emits a negative-amortization flag');
});

// ── Net worth (liability is negative) ─────────────────────────────────────────

test('LOAN: counts as NEGATIVE net worth (owed principal)', () => {
  const state = {
    usSavingsAccount: new SavingsAccount(50_000, { country: 'US', currency: USD }),
    loan: new LoanAccount(80_000, { country: 'US', currency: USD }),
  };
  // 50k asset − 80k liability = −30k.
  assert.ok(near(computeNetWorth(state, 'USD'), -30_000), `net worth ${computeNetWorth(state, 'USD')}`);
});

// ── Drawdown exclusion ────────────────────────────────────────────────────────

test('LOAN: is never a source of drawdown cash', () => {
  const svc = makeSvc();
  const state = {
    checkingAccount:  new CheckingAccount(0, { country: 'US', currency: USD }),
    usSavingsAccount: new SavingsAccount(3_000, { country: 'US', currency: USD, drawdownPriority: 1 }),
    loan: new LoanAccount(80_000, { country: 'US', currency: USD }),
  };
  const before = state.loan.balance;
  // Deficit larger than savings: only the loan's (large, positive) balance could cover
  // the shortfall if it were wrongly treated as a source. Because it is excluded, the
  // draw exhausts savings and reports InsufficientFunds instead of tapping the loan.
  assert.throws(
    () => svc.replenishSavings(state, 'checkingAccount', 10_000, new Date(2026, 0, 1)),
    /Insufficient funds/,
  );
  assert.strictEqual(state.loan.balance, before, 'loan balance untouched by drawdown');
  assert.strictEqual(state.loan.drawdownPriority, null, 'loan is excluded from drawdown');
});

// ── Per-country wiring (design 54 P2) ─────────────────────────────────────────

test('LOAN: country-scoped handlers each pay only their own country (no double-pay)', () => {
  const svc = makeSvc();
  const baseState = () => ({
    usSavingsAccount: new SavingsAccount(50_000, { country: 'US', currency: USD }),
    auSavingsAccount: new SavingsAccount(50_000, { country: 'AU', currency: USD }),
    usLoan: new LoanAccount(100_000, { country: 'US', currency: USD, interestRate: 0.06, monthlyPayment: 1_000 }),
    auLoan: new LoanAccount(100_000, { country: 'AU', currency: USD, interestRate: 0.06, monthlyPayment: 1_000 }),
  });

  const usHandler = new UsLoanPaymentHandler();
  assert.strictEqual(UsLoanPaymentHandler.eventType, 'US_LOAN_PAYMENT');
  assert.strictEqual(usHandler.country, 'US');
  let state = baseState();
  const reducer = new LoanPaymentApplyReducer({ accountService: svc });
  for (const a of usHandler.call({ state })) {
    if (a.type === 'LOAN_PAYMENT_APPLY') state = reducer.reduce(state, a);
  }
  // US loan amortized (99500); AU loan untouched.
  assert.ok(near(state.usLoan.balance, 99_500), `us ${state.usLoan.balance}`);
  assert.strictEqual(state.auLoan.balance, 100_000, 'AU loan untouched by US handler');

  const auHandler = new AuLoanPaymentHandler();
  assert.strictEqual(AuLoanPaymentHandler.eventType, 'AU_LOAN_PAYMENT');
  assert.strictEqual(auHandler.country, 'AU');
  state = baseState();
  for (const a of auHandler.call({ state })) {
    if (a.type === 'LOAN_PAYMENT_APPLY') state = reducer.reduce(state, a);
  }
  assert.ok(near(state.auLoan.balance, 99_500), `au ${state.auLoan.balance}`);
  assert.strictEqual(state.usLoan.balance, 100_000, 'US loan untouched by AU handler');
});

test('LOAN: the base handler (country=null) still pays every loan', () => {
  const svc = makeSvc();
  const handler = new LoanPaymentHandler();
  assert.strictEqual(handler.country, null);
  let state = {
    usSavingsAccount: new SavingsAccount(50_000, { country: 'US', currency: USD }),
    auSavingsAccount: new SavingsAccount(50_000, { country: 'AU', currency: USD }),
    usLoan: new LoanAccount(100_000, { country: 'US', currency: USD, interestRate: 0.06, monthlyPayment: 1_000 }),
    auLoan: new LoanAccount(100_000, { country: 'AU', currency: USD, interestRate: 0.06, monthlyPayment: 1_000 }),
  };
  const reducer = new LoanPaymentApplyReducer({ accountService: svc });
  for (const a of handler.call({ state })) {
    if (a.type === 'LOAN_PAYMENT_APPLY') state = reducer.reduce(state, a);
  }
  assert.ok(near(state.usLoan.balance, 99_500), `us ${state.usLoan.balance}`);
  assert.ok(near(state.auLoan.balance, 99_500), `au ${state.auLoan.balance}`);
});

// ── Cross-currency payment (design 54 P4) ─────────────────────────────────────

test('LOAN: an AUD loan paid from a USD account FX-converts the debit (not 1:1)', () => {
  const svc = makeSvc();
  const handler = new LoanPaymentHandler();
  const reducer = new LoanPaymentApplyReducer({ accountService: svc });
  // 1 USD = 1.55 AUD. A$2,000 payment ⇒ 2000 ÷ 1.55 ≈ US$1,290.32 leaves the USD pool.
  let state = {
    effectiveExchangeRates: { USD_AUD: 1.55 },
    usSavingsAccount: new SavingsAccount(50_000, { country: 'US', currency: USD }),
    // AUD loan, 0% so interest doesn't muddy the FX math; paid from the USD account.
    auHouseLoan: new LoanAccount(100_000, { country: 'AU', currency: AUD, interestRate: 0, monthlyPayment: 2_000, paymentSourceKey: 'usSavingsAccount' }),
  };
  for (const a of handler.call({ state })) {
    if (a.type === 'LOAN_PAYMENT_APPLY') state = reducer.reduce(state, a);
  }
  // Cash cost is FX-converted (the bug was debiting a flat 2000 USD).
  assert.ok(near(state.usSavingsAccount.balance, 50_000 - 1_290.32), `cash ${state.usSavingsAccount.balance}`);
  // The loan still receives A$2,000 of value → balance falls by 2000 in loan currency.
  assert.ok(near(state.auHouseLoan.balance, 98_000), `loan ${state.auHouseLoan.balance}`);
});

test('LOAN: the same AUD payment from an AUD account debits 1:1 (currency parity)', () => {
  const svc = makeSvc();
  const handler = new LoanPaymentHandler();
  const reducer = new LoanPaymentApplyReducer({ accountService: svc });
  let state = {
    effectiveExchangeRates: { USD_AUD: 1.55 },
    auSavingsAccount: new SavingsAccount(50_000, { country: 'AU', currency: AUD }),
    auHouseLoan: new LoanAccount(100_000, { country: 'AU', currency: AUD, interestRate: 0, monthlyPayment: 2_000, paymentSourceKey: 'auSavingsAccount' }),
  };
  for (const a of handler.call({ state })) {
    if (a.type === 'LOAN_PAYMENT_APPLY') state = reducer.reduce(state, a);
  }
  // Same-currency: A$2,000 debits A$2,000 — no conversion, loan also falls by 2000.
  assert.ok(near(state.auSavingsAccount.balance, 48_000), `cash ${state.auSavingsAccount.balance}`);
  assert.ok(near(state.auHouseLoan.balance, 98_000), `loan ${state.auHouseLoan.balance}`);
});

// ── Serializer round-trip ─────────────────────────────────────────────────────

test('LOAN: round-trips through the serializer with its loan fields intact', () => {
  const loan = new LoanAccount(120_000, {
    id: 'L1', name: 'Mortgage', country: 'AU', currency: USD,
    interestRate: 0.055, monthlyPayment: 2_100, linkedPropertyKey: 'auHouse', paymentSourceKey: 'auSavingsAccount',
  });
  const round = ScenarioSerializer._makeAccount(ScenarioSerializer._serializeAccount(loan));
  assert.ok(round instanceof LoanAccount);
  assert.strictEqual(round.type, 'loan');
  assert.strictEqual(round.balance, 120_000);
  assert.strictEqual(round.interestRate, 0.055);
  assert.strictEqual(round.monthlyPayment, 2_100);
  assert.strictEqual(round.linkedPropertyKey, 'auHouse');
  assert.strictEqual(round.paymentSourceKey, 'auSavingsAccount');
  assert.strictEqual(round.drawdownPriority, null);
});
