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
 * evt-section-988.test.mjs — design 86 G7 / P8.
 *
 * §988 exchange gain or loss on foreign-currency DEBT. Four groups:
 *
 *   S988-1..9   the pure arithmetic, including the §988(e) asymmetry that makes a
 *               personal exchange LOSS nondeductible while the matching gain is taxed.
 *   S988-10..13 booking-rate blending on added principal.
 *   S988-14..19 the payment path: stamping, realization on principal only, and the
 *               two structural silences (interest-only, fully offset).
 *   S988-20..23 the US return: where a gain lands, where a loss lands, and — the one
 *               that matters most — that a large loss does NOT break the §904
 *               partition the way design 86 G5b's rental loss did.
 *
 * Run with: node --test tests/unit/evt-section-988.test.mjs
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import { EventBus }       from '../../src/simulation-framework/event-bus.js';
import { Graph }          from '../../src/graph/graph.js';
import { GraphQueryApi }  from '../../src/graph/graph-query-api.js';
import { AccountService } from '../../src/finance/services/account-service.js';
import { AUD, USD }       from '../../src/finance/assets/account.js';
import {
  LoanPaymentHandler, LoanPaymentApplyReducer,
  computeSection988Gain, blendSection988BookingRate, section988BusinessFraction,
} from '../../src/finance/account-rules/loan-classes.js';
import { UsTaxModule2026 }  from '../../src/finance/tax/us/us-tax-module-2026.js';
import { UsTaxRates2026 }   from '../../src/finance/tax/us/us-tax-rates-2026.js';

// Rates are AUD per USD. Booking at 1.40, spot at 1.60 ⇒ the AUD WEAKENED, so the
// borrower discharges the debt with fewer dollars: a gain.
const BOOK = 1.40;
const WEAK = 1.60;   // AUD weaker than at booking ⇒ gain
const STRONG = 1.25; // AUD stronger than at booking ⇒ loss

// ─── the pure arithmetic ──────────────────────────────────────────────────────

test('S988-1: a weakened foreign currency produces a GAIN for the borrower', () => {
  const r = computeSection988Gain(100_000, BOOK, WEAK, 1);
  // 100k/1.40 = 71,428.57 booked; 100k/1.60 = 62,500 paid ⇒ 8,928.57 gain
  assert.ok(Math.abs(r.gross - (100_000 / BOOK - 100_000 / WEAK)) < 1e-9);
  assert.ok(r.gross > 0);
  assert.ok(Math.abs(r.recognized - r.gross) < 1e-9, 'fully income-producing ⇒ all recognized');
  assert.equal(r.disallowedLoss, 0);
});

test('S988-2: a strengthened foreign currency produces a LOSS', () => {
  const r = computeSection988Gain(100_000, BOOK, STRONG, 1);
  assert.ok(r.gross < 0);
  assert.ok(Math.abs(r.recognized - r.gross) < 1e-9, 'income-producing losses ARE recognized');
  assert.equal(r.disallowedLoss, 0);
});

test('S988-3: a PERSONAL exchange gain is fully taxable', () => {
  const r = computeSection988Gain(100_000, BOOK, WEAK, 0);
  assert.ok(r.gross > 0);
  assert.ok(Math.abs(r.recognized - r.gross) < 1e-9);
});

test('S988-4: a PERSONAL exchange loss is DISALLOWED — the foreign-mortgage trap', () => {
  const r = computeSection988Gain(100_000, BOOK, STRONG, 0);
  assert.ok(r.gross < 0, 'the taxpayer really did lose money');
  assert.equal(r.recognized, 0, 'and gets no deduction for it (§165(c))');
  assert.ok(Math.abs(r.disallowedLoss - -r.gross) < 1e-9);
});

test('S988-5: the §988(e) asymmetry is real — same move, opposite directions, not symmetric', () => {
  const gain = computeSection988Gain(100_000, BOOK, WEAK,   0);
  const loss = computeSection988Gain(100_000, BOOK, STRONG, 0);
  assert.ok(gain.recognized > 0);
  assert.equal(loss.recognized, 0);
});

test('S988-6: a personal gain of $200 or less is de minimis under §988(e)(2)', () => {
  // Size the principal so the personal gain lands just under $200.
  const small = computeSection988Gain(2_000, BOOK, 1.4050, 0);
  assert.ok(small.gross > 0 && small.gross <= 200, `expected a small gain, got ${small.gross}`);
  assert.equal(small.recognized, 0);
  assert.ok(Math.abs(small.deMinimis - small.gross) < 1e-9);
});

test('S988-7: a personal gain ABOVE the de minimis is recognized in full, not just the excess', () => {
  const r = computeSection988Gain(100_000, BOOK, WEAK, 0);
  assert.ok(r.gross > 200);
  assert.ok(Math.abs(r.recognized - r.gross) < 1e-9);
  assert.equal(r.deMinimis, 0);
});

test('S988-8: a part-business loan splits — business loss deductible, personal half is not', () => {
  const r = computeSection988Gain(100_000, BOOK, STRONG, 0.6);
  assert.ok(Math.abs(r.recognized - r.gross * 0.6) < 1e-9);
  assert.ok(Math.abs(r.disallowedLoss - -r.gross * 0.4) < 1e-9);
});

test('S988-9: degenerate inputs recognize nothing rather than producing NaN', () => {
  for (const args of [[0, BOOK, WEAK, 1], [-5, BOOK, WEAK, 1], [100, 0, WEAK, 1], [100, BOOK, 0, 1]]) {
    const r = computeSection988Gain(...args);
    assert.equal(r.recognized, 0);
    assert.equal(r.gross, 0);
  }
});

// ─── booking-rate blending ────────────────────────────────────────────────────

test('S988-10: blending preserves the debt\'s total USD booking value', () => {
  const blended = blendSection988BookingRate(300_000, BOOK, 100_000, WEAK);
  const usdBefore = 300_000 / BOOK + 100_000 / WEAK;
  assert.ok(Math.abs(400_000 / blended - usdBefore) < 1e-6);
});

test('S988-11: the blend lies between the two rates', () => {
  const blended = blendSection988BookingRate(300_000, BOOK, 100_000, WEAK);
  assert.ok(blended > BOOK && blended < WEAK, `expected ${BOOK} < ${blended} < ${WEAK}`);
});

test('S988-12: nothing added leaves the booking rate untouched', () => {
  assert.equal(blendSection988BookingRate(300_000, BOOK, 0, WEAK), BOOK);
});

test('S988-13: an unstamped loan takes the spot rate wholesale', () => {
  assert.equal(blendSection988BookingRate(300_000, null, 100_000, WEAK), WEAK);
});

// ─── business fraction ────────────────────────────────────────────────────────

test('S988-14: businessFraction reuses deductibleFraction, else the property\'s rental status', () => {
  const renting = { auHouseProperty: { rentalEnabled: true } };
  const vacant  = { auHouseProperty: { rentalEnabled: false } };
  const linked  = { linkedPropertyKey: 'auHouseProperty' };

  assert.equal(section988BusinessFraction(renting, { ...linked }), 1, 'renting ⇒ income-producing');
  assert.equal(section988BusinessFraction(vacant,  { ...linked }), 0, 'not renting ⇒ personal');
  assert.equal(section988BusinessFraction({}, {}), 0, 'a standalone loan is personal by default');
  assert.equal(section988BusinessFraction(vacant, { ...linked, deductibleFraction: 0.5 }), 0.5,
    'an explicit fraction overrides the property');
  assert.equal(section988BusinessFraction({}, { deductibleFraction: 4 }), 1, 'clamped');
});

// ─── the payment path ─────────────────────────────────────────────────────────

function makeSvc() {
  const g = new Graph();
  return new AccountService(g, new GraphQueryApi(g), new EventBus());
}

function auLoanState({ balance = 300_000, monthlyPayment = 5_000, rate = WEAK,
                       interestOnly = false, bookingFxRate = BOOK, offset = 0 } = {}) {
  return {
    effectiveExchangeRates: { USD_AUD: rate },
    auHouseProperty: { rentalEnabled: true, stateKey: 'auHouseProperty' },
    hLoan: {
      type: 'loan', kind: 'account', stateKey: 'hLoan', balance,
      monthlyPayment, interestRate: 0.06, primeSpread: null, interestOnly,
      linkedPropertyKey: 'auHouseProperty', paymentSourceKey: 'cash',
      bookingFxRate, country: 'AU', currency: AUD, holdings: [],
    },
    ...(offset > 0 ? {
      off: {
        type: 'offset', kind: 'account', stateKey: 'off', balance: offset,
        offsetsPropertyKey: 'auHouseProperty', country: 'AU', currency: AUD,
        minimumBalance: 0, drawdownPriority: null, holdings: [],
      },
    } : {}),
    cash: {
      type: 'savings', kind: 'account', stateKey: 'cash', balance: 5_000_000,
      country: 'AU', currency: AUD, minimumBalance: 0, drawdownPriority: 1, holdings: [],
    },
  };
}

/** One LOAN_PAYMENT cycle; returns the next state and any SECTION_988_GAIN emitted. */
function payOnce(state) {
  const handler = new LoanPaymentHandler();
  const reducer = new LoanPaymentApplyReducer({ accountService: makeSvc() });
  let emitted = [];
  for (const action of handler.call({ state })) {
    if (action.type !== 'LOAN_PAYMENT_APPLY') continue;
    const res = reducer.reduce(state, action);
    state   = res.state ?? res;
    emitted = emitted.concat((res.next ?? []).filter(a => a.type === 'SECTION_988_GAIN'));
  }
  return { state, emitted };
}

test('S988-15: an unstamped loan is booked at the live rate and recognizes nothing', () => {
  const { state, emitted } = payOnce(auLoanState({ bookingFxRate: null }));
  assert.equal(emitted.length, 0, 'no history ⇒ no gain invented');
  assert.equal(state.hLoan.bookingFxRate, WEAK, 'stamped at the rate in force');
});

test('S988-16: a principal repayment against a weaker AUD realizes a §988 GAIN', () => {
  const { emitted } = payOnce(auLoanState({ rate: WEAK }));
  assert.equal(emitted.length, 1);
  assert.ok(emitted[0].amount > 0, `expected a gain, got ${emitted[0].amount}`);
  assert.equal(emitted[0].currency, 'AUD');
});

test('S988-17: the same repayment against a stronger AUD realizes a LOSS', () => {
  const { emitted } = payOnce(auLoanState({ rate: STRONG }));
  assert.equal(emitted.length, 1);
  assert.ok(emitted[0].amount < 0);
});

test('S988-18: an INTEREST-ONLY loan recognizes nothing — §988 bites on repayment, not on holding', () => {
  const { emitted, state } = payOnce(auLoanState({ interestOnly: true, rate: WEAK }));
  assert.equal(emitted.length, 0, 'no principal repaid ⇒ no realization');
  assert.ok(Math.abs(state.hLoan.balance - 300_000) < 0.01, 'and the balance is flat');
});

test('S988-19: a FULLY OFFSET interest-only loan is likewise silent', () => {
  const { emitted } = payOnce(auLoanState({ interestOnly: true, offset: 300_000, rate: WEAK }));
  assert.equal(emitted.length, 0);
});

test('S988-20: a USD loan is not a §988 transaction at all', () => {
  const state = auLoanState();
  state.hLoan = { ...state.hLoan, currency: USD, country: 'US' };
  state.cash  = { ...state.cash,  currency: USD, country: 'US' };
  const { emitted } = payOnce(state);
  assert.equal(emitted.length, 0, 'the taxpayer\'s functional currency (§985(b)(1))');
});

// ─── the US return ────────────────────────────────────────────────────────────

const usModule = new UsTaxModule2026();
const classify = (type) => usModule.getReducerFns().get(type);

test('S988-21: a §988 GAIN joins US ordinary income', () => {
  const fn = classify('SECTION_988_GAIN');
  assert.ok(fn, 'the classifier must be registered');
  const next = fn({ usOrdinaryIncomeYTD: 100_000 },
    { type: 'SECTION_988_GAIN', amount: 9_000, disallowedLoss: 0 });
  assert.equal(next.usOrdinaryIncomeYTD, 109_000);
  assert.equal(next.usSection988GainYTD, 9_000);
});

test('S988-22: a §988 LOSS does NOT reduce usOrdinaryIncomeYTD — that is the G5b trap', () => {
  const fn = classify('SECTION_988_GAIN');
  const next = fn({ usOrdinaryIncomeYTD: 100_000 },
    { type: 'SECTION_988_GAIN', amount: -9_000, disallowedLoss: 0 });
  assert.equal(next.usOrdinaryIncomeYTD, 100_000,
    'reducing gross income without reducing a basket breaks the §904 partition');
  assert.equal(next.usSection988LossYTD, 9_000, 'it is carried as a deduction instead');
});

test('S988-23: a disallowed personal loss is recorded but deducted nowhere', () => {
  const fn = classify('SECTION_988_GAIN');
  const next = fn({ usOrdinaryIncomeYTD: 100_000 },
    { type: 'SECTION_988_GAIN', amount: 0, disallowedLoss: 7_000 });
  assert.equal(next.usSection988DisallowedLossYTD, 7_000);
  assert.equal(next.usSection988LossYTD ?? 0, 0);
  assert.equal(next.usOrdinaryIncomeYTD, 100_000);
});

test('S988-24: the loss reduces AGI and taxable income', () => {
  const rates = new UsTaxRates2026();
  const base  = rates.computeTax({ usOrdinaryIncomeYTD: 200_000 });
  const withLoss = rates.computeTax({ usOrdinaryIncomeYTD: 200_000, usSection988LossYTD: 30_000 });
  assert.ok(Math.abs((base.adjustedGrossIncome - withLoss.adjustedGrossIncome) - 30_000) < 0.01);
  assert.ok(withLoss.netLiability < base.netLiability);
});

test('S988-25: a large §988 loss beside foreign income leaves the §904 partition intact', () => {
  // The G5b regression, in the shape §988 could reintroduce: a big ordinary loss
  // alongside foreign-source income with foreign tax paid. If the loss had been
  // netted into usOrdinaryIncomeYTD, basket gross would exceed total gross income
  // and _assertFtcInvariants would throw (it is strict in tests).
  const rates = new UsTaxRates2026();
  const state = {
    usOrdinaryIncomeYTD:     60_000,
    foreignPassiveIncomeYTD: 55_000,
    foreignGeneralIncomeYTD: 0,
    ftcCurrentPassive:       12_000,
    usSection988LossYTD:     45_000,
  };
  assert.doesNotThrow(() => rates.computeTax(state));
  const out = rates.computeTax(state);
  assert.ok(out.netLiability >= 0);
});
