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

// ── design 86 G3: deductibleFraction ────────────────────────────────────────

import { computeRentalMonth } from '../../src/finance/account-rules/rental-income-classes.js';

/** A renting property with a mortgage, and the loan behind it. */
function rentalSetup(deductibleFraction) {
  const loan = loanEntry({ balance: 400_000, interestRate: 0.06, deductibleFraction });
  const state = { hLoan: loan };
  const p = { stateKey: 'h', monthlyRent: 4_000, occupancyRate: 1, rentalExpenseRatio: 0.25,
              landValueRatio: 0.2, annualDepreciationOverride: 0 };
  return computeRentalMonth(p, { costBasis: 0 }, 'AU', 1, loan, state);
}

test('DEDUCT-1: deductibleFraction scales the rental interest deduction', () => {
  const full = rentalSetup(null);            // pre-86 default
  const one  = rentalSetup(1);
  const half = rentalSetup(0.5);
  const none = rentalSetup(0);

  assert.equal(full.deductibleInterest, 2_000, '400k at 6% ÷ 12');
  assert.equal(one.deductibleInterest,  2_000, 'null and 1 must agree — the flag is inert by default');
  assert.equal(half.deductibleInterest, 1_000);
  assert.equal(none.deductibleInterest, 0, 'a wholly private purpose deducts nothing');

  // …and the taxable rental moves the other way by exactly the lost deduction.
  assert.equal(none.taxableRental - full.taxableRental, 2_000);
});

test('DEDUCT-2: an out-of-range fraction is clamped, not trusted', () => {
  assert.equal(rentalSetup(5).deductibleInterest,  2_000);
  assert.equal(rentalSetup(-1).deductibleInterest, 0);
});

test('DEDUCT-3: deductibleFraction round-trips, and defaults to null', () => {
  const loan = new LoanAccount(BALANCE, { stateKey: 'hLoan', deductibleFraction: 0.4 });
  assert.equal(ScenarioSerializer._makeAccount(ScenarioSerializer._serializeAccount(loan)).deductibleFraction, 0.4);

  const legacy = ScenarioSerializer._serializeAccount(new LoanAccount(BALANCE, { stateKey: 'hLoan' }));
  delete legacy.deductibleFraction;
  assert.equal(ScenarioSerializer._makeAccount(legacy).deductibleFraction, null);

  const prop = { stateKey: 'h', mortgageBalance: 1, monthlyMortgage: 1, mortgageDeductibleFraction: 0.25 };
  assert.equal(synthesizeLoanForProperty(prop).deductibleFraction, 0.25);
  assert.equal(synthesizeLoanForProperty({ ...prop, mortgageDeductibleFraction: undefined }).deductibleFraction, null);
});

// ── design 86 G6: loan term and IO expiry ───────────────────────────────────

import { scheduledLoanPayment } from '../../src/finance/account-rules/loan-classes.js';

/** Run months with a period clock, so the term logic has a calendar year. */
function runYears(state, fromYear, toYear, opts = {}) {
  const payments = [];
  let s = state;
  for (let y = fromYear; y <= toYear; y++) {
    s = { ...s, currentPeriods: { US: { startMs: Date.UTC(y, 0, 1) } } };
    const { state: next, payments: p } = runMonths(s, 12, opts);
    s = next;
    payments.push({ y, first: p[0] ?? 0, balance: s.hLoan.balance });
  }
  return { state: s, byYear: payments };
}

test('TERM-1: an IO loan reverts to P&I at interestOnlyUntilYear and pays off by maturity', () => {
  const loan = loanEntry({
    balance: BALANCE, interestRate: RATE, interestOnly: true,
    interestOnlyUntilYear: 2031, maturityYear: 2041, paymentSourceKey: 'cash',
  });
  const { state: end, byYear } = runYears({ hLoan: loan, cash: cashEntry(5_000_000) }, 2026, 2041);

  // Flat through the IO window…
  const io = byYear.filter(r => r.y < 2031);
  for (const r of io) assert.ok(Math.abs(r.balance - BALANCE) < 0.01, `${r.y} balance moved`);
  assert.ok(Math.abs(io[0].first - IO_PMT) < 0.01, 'IO payment is the interest');

  // …then the payment steps UP and the balance starts falling.
  const firstPI = byYear.find(r => r.y === 2031);
  assert.ok(firstPI.first > IO_PMT * 1.4,
    `reversion should be a real step-up: ${IO_PMT.toFixed(0)} → ${firstPI.first.toFixed(0)}`);
  assert.ok(firstPI.balance < BALANCE, 'principal now amortizes');

  assert.ok(Math.abs(end.hLoan.balance) < 0.01,
    `must be discharged at maturity, got ${end.hLoan.balance}`);
});

test('TERM-2: maturity forces payoff even if the IO period never ended', () => {
  const loan = loanEntry({
    balance: BALANCE, interestRate: RATE, interestOnly: true,
    maturityYear: 2030, paymentSourceKey: 'cash',
  });
  const { state: end } = runYears({ hLoan: loan, cash: cashEntry(5_000_000) }, 2026, 2030);
  assert.ok(Math.abs(end.hLoan.balance) < 0.01, 'a balloon repayment at maturity');
});

test('TERM-3: no term means no change — an IO loan runs flat forever', () => {
  const loan = loanEntry({ balance: BALANCE, interestRate: RATE, interestOnly: true,
                           paymentSourceKey: 'cash' });
  const { state: end } = runYears({ hLoan: loan, cash: cashEntry(5_000_000) }, 2026, 2060);
  assert.ok(Math.abs(end.hLoan.balance - BALANCE) < 0.01);
});

test('TERM-U1: scheduledLoanPayment, at each branch', () => {
  const io = { interestOnly: true, monthlyPayment: 99, interestOnlyUntilYear: 2031, maturityYear: 2041 };
  // inside the IO window → the interest
  assert.equal(scheduledLoanPayment(io, 500_000, 2_500, 0.06, 2030), 2_500);
  // past maturity → balance + interest
  assert.equal(scheduledLoanPayment(io, 500_000, 2_500, 0.06, 2041), 502_500);
  // reverted → amortising over the months left, above the interest and below payoff
  const rev = scheduledLoanPayment(io, 500_000, 2_500, 0.06, 2031);
  assert.ok(rev > 2_500 && rev < 502_500, rev);
  // no term at all → the authored fixed payment, capped at payoff
  assert.equal(scheduledLoanPayment({ monthlyPayment: 3_000 }, 500_000, 2_500, 0.06, 2031), 3_000);
  assert.equal(scheduledLoanPayment({ monthlyPayment: 3_000 }, 1_000, 5, 0.06, 2031), 1_005);
  // unknown year (a synthetic state with no period) → IO stays IO, never a surprise balloon
  assert.equal(scheduledLoanPayment(io, 500_000, 2_500, 0.06, null), 2_500);
});

// ── design 86 G6, corrected: the post-IO payment is ANCHORED ─────────────────
//
// The reverted-to-P&I payment used to be re-amortised from the LIVE balance over the
// months remaining. That is an identity — and so harmless — only while the balance
// tracks its own schedule. A fully offset loan accrues no interest, so the whole
// payment is principal and the balance runs AHEAD of schedule; re-amortising then cut
// the payment, which let it run further ahead, which cut the payment again. The loan
// never retired early, it drifted to its stated maturity. No lender behaves that way.

/** An offset large enough to zero the interest, so every dollar paid is principal. */
function fullyOffset(loanOverrides = {}) {
  return {
    hLoan: loanEntry({
      balance: BALANCE, interestRate: RATE, interestOnly: true,
      interestOnlyUntilYear: 2031, maturityYear: 2056,
      paymentSourceKey: 'cash', ...loanOverrides,
    }),
    off:  { type: 'offset', kind: 'account', stateKey: 'off', balance: BALANCE,
            offsetsPropertyKey: 'h', country: 'US', currency: USD,
            drawdownPriority: null, holdings: [] },
    cash: cashEntry(5_000_000),
  };
}

test('TERM-6: a fully offset IO loan retires EARLY, and its payment does not decay', () => {
  // Anchored on the IO-expiry principal: 500k over the 25-year post-IO term at 6%.
  const anchored = fullyOffset({ postIoPrincipal: BALANCE });
  const { byYear } = runYears(anchored, 2026, 2055);

  const pi = byYear.filter(r => r.y >= 2031 && r.first > 0);
  const first = pi[0].first, last = pi.at(-1).first;
  assert.ok(Math.abs(first - last) < 0.01,
    `payment must be FIXED across the P&I period, got ${first.toFixed(0)} → ${last.toFixed(0)}`);
  assert.ok(Math.abs(first - 3_221) < 5, `expected ~3,221/mo, got ${first.toFixed(0)}`);

  // Zero interest ⇒ every dollar is principal ⇒ 500k / 3,221 ≈ 156 months ≈ 2044,
  // twelve years before the stated 2056 maturity.
  const paidOff = byYear.find(r => r.balance < 0.01);
  assert.ok(paidOff && paidOff.y <= 2045,
    `must retire EARLY, not drift to maturity — paid off ${paidOff?.y ?? 'never'}`);
});

test('TERM-7: without an offset the anchored schedule is the ordinary one', () => {
  // The regression that matters: for a normal loan, re-amortising the live balance
  // over the months left IS the fixed payment, so anchoring must change nothing.
  const loan = loanEntry({
    balance: BALANCE, interestRate: RATE, interestOnly: true,
    interestOnlyUntilYear: 2031, maturityYear: 2041,
    postIoPrincipal: BALANCE, paymentSourceKey: 'cash',
  });
  const { state: end, byYear } = runYears({ hLoan: loan, cash: cashEntry(5_000_000) }, 2026, 2041);
  const pi = byYear.filter(r => r.y >= 2031 && r.y < 2041);
  for (const r of pi) assert.ok(Math.abs(r.first - pi[0].first) < 0.01, `${r.y} payment moved`);
  assert.ok(Math.abs(end.hLoan.balance) < 0.01, 'still discharged by maturity');
});

test('TERM-8: an unanchored legacy loan keeps the pre-correction behaviour exactly', () => {
  // A state entry authored before postIoPrincipal existed must not change underneath
  // itself, so the live-balance path is preserved when the anchor is absent.
  const legacy = fullyOffset();                     // no postIoPrincipal
  delete legacy.hLoan.postIoPrincipal;
  const { byYear } = runYears(legacy, 2026, 2055);
  const pi = byYear.filter(r => r.y >= 2032 && r.first > 0);
  assert.ok(pi.at(-1).first < pi[0].first * 0.6,
    'legacy schedule self-damps: the payment should decay');
  assert.ok(byYear.at(-1).balance > 1,
    'and the loan should NOT be retired before its stated maturity');
});

test('TERM-U2: scheduledLoanPayment — anchored is flat, unanchored follows the balance', () => {
  const base = { interestOnly: true, interestOnlyUntilYear: 2031, maturityYear: 2056 };
  const anch = { ...base, postIoPrincipal: 500_000 };
  // Same payment whatever the live balance has done, because the anchor is fixed.
  const a2032 = scheduledLoanPayment(anch, 480_000, 0, 0.06, 2032);
  const a2040 = scheduledLoanPayment(anch, 200_000, 0, 0.06, 2040);
  assert.ok(Math.abs(a2032 - a2040) < 0.01, `anchored payment moved: ${a2032} vs ${a2040}`);
  // …but it still tracks the RATE, which was the original design intent.
  assert.ok(scheduledLoanPayment(anch, 480_000, 0, 0.09, 2032) > a2032 * 1.2,
    'a rate rise must still raise the payment');
  // Unanchored: the payment follows the live balance down.
  assert.ok(scheduledLoanPayment(base, 200_000, 0, 0.06, 2040)
          < scheduledLoanPayment(base, 480_000, 0, 0.06, 2032));
  // Capped at payoff, and never below it, in both modes.
  assert.equal(scheduledLoanPayment(anch, 1_000, 5, 0.06, 2040), 1_005);
});

test('TERM-9: postIoPrincipal defaults from the balance and round-trips', () => {
  // ctor: an IO loan is anchored automatically; a P&I loan is not.
  assert.equal(new LoanAccount(BALANCE, { interestOnly: true }).postIoPrincipal, BALANCE);
  assert.equal(new LoanAccount(BALANCE, { interestOnly: false }).postIoPrincipal, null);
  assert.equal(new LoanAccount(BALANCE, { interestOnly: true, postIoPrincipal: 123 }).postIoPrincipal, 123);

  // synthesized from a property record
  assert.equal(synthesizeLoanForProperty(
    { stateKey: 'h', mortgageBalance: 400_000, mortgageInterestOnly: true }).postIoPrincipal, 400_000);
  assert.equal(synthesizeLoanForProperty(
    { stateKey: 'h', mortgageBalance: 400_000 }).postIoPrincipal, null);

  // serializer: survives save/load, or the next load silently reverts the schedule
  const acct = new LoanAccount(BALANCE, {
    stateKey: 'hLoan', interestOnly: true, interestOnlyUntilYear: 2031, maturityYear: 2056,
  });
  const wire = ScenarioSerializer._serializeAccount(acct);
  assert.equal(wire.postIoPrincipal, BALANCE, 'must be written to the wire');
  assert.equal(ScenarioSerializer._makeAccount(wire).postIoPrincipal, BALANCE);

  // …and a legacy save with no anchor still re-anchors from its balance on load,
  // because an IO loan's balance has not amortised. Nothing silently loses the fix.
  const legacy = { ...wire }; delete legacy.postIoPrincipal;
  assert.equal(ScenarioSerializer._makeAccount(legacy).postIoPrincipal, BALANCE);
});
