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
 * evt-interest-only-loan.test.mjs — design 86 G2, interest-only loans.
 *
 * An interest-only loan derives its payment as the accrued interest on the effective
 * (offset-reduced) principal at the live rate, rather than paying a fixed
 * `monthlyPayment`. That makes the balance flat BY CONSTRUCTION, which is the point:
 * with a Prime-linked variable rate, no fixed number can express "pay exactly the
 * interest", and a number guessed too low produces unbounded negative amortization
 * that no headline result makes visible.
 *
 *   IO-LOAN-1: an IO loan's balance is flat; the same loan on P&I amortizes.
 *   IO-LOAN-2: the payment tracks the rate — a Prime hike raises the cash outflow and
 *              the balance STILL does not move, where a fixed-payment loan goes
 *              backwards.
 *   IO-LOAN-3: a fully offset IO loan accrues nothing, so it costs nothing — no
 *              payment, no cash debit, flat balance.
 *   IO-LOAN-4: `interestOnly` round-trips through the serializer, on both an authored
 *              LoanAccount and a mortgage synthesized from a property.
 *   IO-LOAN-5: absent the flag, the P&I path is untouched (regression guard).
 *
 * Run with: node --test tests/unit/evt-interest-only-loan.test.mjs
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import { EventBus }       from '../../src/simulation-framework/event-bus.js';
import { Graph }          from '../../src/graph/graph.js';
import { GraphQueryApi }  from '../../src/graph/graph-query-api.js';
import { AccountService } from '../../src/finance/services/account-service.js';
import { USD, LoanAccount } from '../../src/finance/assets/account.js';
import {
  LoanPaymentHandler, LoanPaymentApplyReducer, synthesizeLoanForProperty,
} from '../../src/finance/account-rules/loan-classes.js';
import { ScenarioSerializer } from '../../src/scenarios/scenario-serializer.js';

const RATE    = 0.06;
const BALANCE = 500_000;
const IO_PMT  = BALANCE * RATE / 12;   // 2,500 — the exact interest at t0

function makeSvc() {
  const g = new Graph();
  return new AccountService(g, new GraphQueryApi(g), new EventBus());
}

function loanEntry(overrides = {}) {
  return {
    type: 'loan', kind: 'account', stateKey: 'hLoan', balance: BALANCE,
    interestRate: RATE, monthlyPayment: 3_000, linkedPropertyKey: 'h',
    country: 'US', currency: USD, minimumBalance: 0, drawdownPriority: null, holdings: [],
    ...overrides,
  };
}

function cashEntry(balance = 1_000_000, overrides = {}) {
  return {
    type: 'savings', kind: 'account', stateKey: 'cash', balance,
    country: 'US', currency: USD, minimumBalance: 0, drawdownPriority: 1, holdings: [],
    ...overrides,
  };
}

/**
 * Drive `months` of LOAN_PAYMENT through the real handler + reducer, returning the
 * final state and the per-month payments. `paymentSourceKey` is pinned to the cash
 * entry so the shared cash resolver isn't consulted for this synthetic state.
 */
function runMonths(state, months, { rateAt } = {}) {
  const svc      = makeSvc();
  const handler  = new LoanPaymentHandler();
  const reducer  = new LoanPaymentApplyReducer({ accountService: svc });
  const payments = [];

  for (let m = 0; m < months; m++) {
    if (rateAt) {
      state = { ...state, effectiveInterestRates: { ...(state.effectiveInterestRates ?? {}), PRIME_US: rateAt(m) } };
    }
    for (const action of handler.call({ state })) {
      if (action.type !== 'LOAN_PAYMENT_APPLY') continue;
      payments.push(action.payment);
      state = reducer.reduce(state, action).state ?? reducer.reduce(state, action);
    }
  }
  return { state, payments };
}

// ── IO-LOAN-1 ────────────────────────────────────────────────────────────────

test('IO-LOAN-1: an interest-only loan holds its balance flat; P&I amortizes', () => {
  const io = runMonths(
    { hLoan: loanEntry({ interestOnly: true, paymentSourceKey: 'cash' }), cash: cashEntry() }, 120);
  const pi = runMonths(
    { hLoan: loanEntry({ paymentSourceKey: 'cash' }), cash: cashEntry() }, 120);

  assert.ok(Math.abs(io.state.hLoan.balance - BALANCE) < 0.01,
    `IO balance drifted: ${io.state.hLoan.balance}`);
  assert.ok(pi.state.hLoan.balance < BALANCE - 50_000,
    `P&I should have amortized, got ${pi.state.hLoan.balance}`);

  // Every IO payment is the interest on the full principal, unchanged month to month.
  for (const p of io.payments) assert.ok(Math.abs(p - IO_PMT) < 0.01, `IO payment ${p} != ${IO_PMT}`);
});

// ── IO-LOAN-2 ────────────────────────────────────────────────────────────────

test('IO-LOAN-2: the IO payment tracks a mid-run rate hike; the balance still does not move', () => {
  // Prime-linked: rate = PRIME_US + spread. Hike Prime by 2pp at month 60.
  const SPREAD = 0.015;
  const rateAt = (m) => (m < 60 ? 0.045 : 0.065);
  const linked = (extra) => loanEntry({ interestRate: 0, primeSpread: SPREAD, paymentSourceKey: 'cash', ...extra });

  const io = runMonths({ hLoan: linked({ interestOnly: true }), cash: cashEntry() }, 120, { rateAt });
  const pi = runMonths({ hLoan: linked({ monthlyPayment: BALANCE * (0.045 + SPREAD) / 12 }), cash: cashEntry() },
                       120, { rateAt });

  assert.ok(Math.abs(io.state.hLoan.balance - BALANCE) < 0.01,
    `IO balance moved through a rate hike: ${io.state.hLoan.balance}`);
  assert.ok(io.payments.at(-1) > io.payments[0] * 1.2,
    `IO payment should rise with Prime: ${io.payments[0]} → ${io.payments.at(-1)}`);

  // The fixed-payment loan was exactly interest-covering BEFORE the hike, so after it
  // the payment is short and the balance goes backwards — the failure mode IO removes.
  assert.ok(pi.state.hLoan.balance > BALANCE,
    `fixed payment should negatively amortize after the hike, got ${pi.state.hLoan.balance}`);
});

// ── IO-LOAN-3 ────────────────────────────────────────────────────────────────

test('IO-LOAN-3: a fully offset interest-only loan accrues nothing and costs nothing', () => {
  const state = {
    hLoan: loanEntry({ interestOnly: true, paymentSourceKey: 'cash' }),
    off:   { type: 'offset', kind: 'account', stateKey: 'off', balance: BALANCE,
             offsetsPropertyKey: 'h', country: 'US', currency: USD,
             drawdownPriority: null, holdings: [] },
    cash:  cashEntry(),
  };
  const { state: end, payments } = runMonths(state, 60);

  assert.strictEqual(payments.length, 0, 'a fully offset IO loan should emit no payment');
  assert.ok(Math.abs(end.hLoan.balance - BALANCE) < 0.01, 'balance must be flat');
  assert.ok(Math.abs(end.cash.balance - 1_000_000) < 0.01, 'no cash should have moved');
  assert.ok(Math.abs(end.off.balance - BALANCE) < 0.01, 'the offset cash stays liquid and untouched');
});

// ── IO-LOAN-4 ────────────────────────────────────────────────────────────────

test('IO-LOAN-4: interestOnly round-trips through the serializer', () => {
  const loan = new LoanAccount(BALANCE, {
    stateKey: 'hLoan', interestRate: RATE, monthlyPayment: 3_000, interestOnly: true,
  });
  const back = ScenarioSerializer._makeAccount(ScenarioSerializer._serializeAccount(loan));
  assert.strictEqual(back.interestOnly, true);

  // …and a legacy save with no flag deserializes to the P&I default.
  const legacy = ScenarioSerializer._serializeAccount(loan);
  delete legacy.interestOnly;
  assert.strictEqual(ScenarioSerializer._makeAccount(legacy).interestOnly, false);
});

test('IO-LOAN-4b: a mortgage synthesizes an interest-only loan from mortgageInterestOnly', () => {
  const prop = {
    stateKey: 'h', mortgageBalance: BALANCE, monthlyMortgage: 3_000,
    mortgageInterestRate: RATE, mortgageInterestOnly: true, country: 'US',
  };
  assert.strictEqual(synthesizeLoanForProperty(prop).interestOnly, true);
  assert.strictEqual(synthesizeLoanForProperty({ ...prop, mortgageInterestOnly: undefined }).interestOnly, false);
});

// ── IO-LOAN-5 ────────────────────────────────────────────────────────────────

test('IO-LOAN-5: without the flag the P&I path is byte-for-byte unchanged', () => {
  const base   = runMonths({ hLoan: loanEntry({ paymentSourceKey: 'cash' }), cash: cashEntry() }, 36);
  const withIO = runMonths({ hLoan: loanEntry({ paymentSourceKey: 'cash', interestOnly: false }), cash: cashEntry() }, 36);

  assert.strictEqual(base.state.hLoan.balance, withIO.state.hLoan.balance);
  assert.deepStrictEqual(base.payments, withIO.payments);

  // Payoff still caps the final payment so the balance lands exactly at 0.
  const small = runMonths({ hLoan: loanEntry({ balance: 5_000, paymentSourceKey: 'cash' }), cash: cashEntry() }, 24);
  assert.strictEqual(small.state.hLoan.balance, 0);
});
