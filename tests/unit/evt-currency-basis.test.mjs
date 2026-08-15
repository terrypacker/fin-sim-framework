/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * evt-currency-basis.test.mjs — design 87 phases 1 & 2.
 *
 * §988 on foreign-currency CASH: the leg design 86 G7/P8 left unbuilt.
 *
 *   CB-1..8    the arithmetic and the mirror relationship to the debt leg.
 *   CB-9..13   the pool predicate, the business fraction, and basis acquisition.
 *   CB-14..18  the offset leg (phase 2 G3) and the cancellation that is the finding.
 *   CB-19..21  the de minimis moved to the leg it was written for (G4).
 *
 * Run with: node --test tests/unit/evt-currency-basis.test.mjs
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import { EventBus }       from '../../src/simulation-framework/event-bus.js';
import { Graph }          from '../../src/graph/graph.js';
import { GraphQueryApi }  from '../../src/graph/graph-query-api.js';
import { AccountService } from '../../src/finance/services/account-service.js';
import { AUD, USD }       from '../../src/finance/assets/account.js';
import {
  LoanPaymentHandler, LoanPaymentApplyReducer, computeSection988Gain,
} from '../../src/finance/account-rules/loan-classes.js';
import {
  computeCurrencyDisposition, blendCurrencyBasisRate, isForeignCurrencyPool,
  currencyPoolBusinessFraction, realizeCurrencyDisposition, acquireCurrencyBasis,
} from '../../src/finance/account-rules/currency-basis.js';
import { createCurrencyLotObserver } from '../../src/finance/account-rules/currency-lot-observer.js';
import { PERSONAL_CHARACTER } from '../../src/finance/account-rules/currency-lots.js';

// Rates are AUD per USD, matching effectiveExchangeRates.USD_AUD.
const ACQ    = 1.40;
const WEAKER = 1.60;  // AUD weaker than at acquisition ⇒ the HOLDER lost value
const STRONG = 1.25;  // AUD stronger ⇒ the holder gained

// ─── the arithmetic, and the mirror ───────────────────────────────────────────

test('CB-1: a STRENGTHENED foreign currency is a GAIN to the holder', () => {
  const r = computeCurrencyDisposition(100_000, ACQ, STRONG, 1);
  // 100k/1.40 = 71,428.57 basis; 100k/1.25 = 80,000 received ⇒ 8,571.43 gain
  assert.ok(Math.abs(r.gross - (100_000 / STRONG - 100_000 / ACQ)) < 1e-9);
  assert.ok(r.gross > 0, 'holding an appreciating currency gains');
});

test('CB-2: a WEAKENED foreign currency is a LOSS to the holder', () => {
  const r = computeCurrencyDisposition(100_000, ACQ, WEAKER, 1);
  assert.ok(r.gross < 0);
  assert.ok(Math.abs(r.recognized - r.gross) < 1e-9, 'income-producing losses ARE recognized');
});

test('CB-3: the deposit is the exact MIRROR of the debt — same move, opposite sign', () => {
  // This is design 87 §3's cancellation, at one payment date. Same units, same two
  // rates: the borrower's gain is the holder's loss to the cent.
  for (const spot of [STRONG, WEAKER]) {
    const debt    = computeSection988Gain(100_000, ACQ, spot, 1, false);
    const deposit = computeCurrencyDisposition(100_000, ACQ, spot, 1);
    assert.ok(Math.abs(debt.gross + deposit.gross) < 1e-9,
      `legs must cancel at spot ${spot}: ${debt.gross} vs ${deposit.gross}`);
  }
});

test('CB-4: a matched, same-rate facility is §988-neutral in BOTH directions', () => {
  for (const spot of [1.10, 1.25, 1.40, 1.60, 1.90]) {
    const net = computeSection988Gain(50_000, ACQ, spot, 1, false).recognized
              + computeCurrencyDisposition(50_000, ACQ, spot, 1).recognized;
    assert.ok(Math.abs(net) < 1e-9, `net must be 0 at spot ${spot}, got ${net}`);
  }
});

test('CB-5: a PERSONAL currency loss is disallowed — §165(c), Quijano', () => {
  const r = computeCurrencyDisposition(100_000, ACQ, WEAKER, 0);
  assert.ok(r.gross < 0, 'the holder really did lose money');
  assert.equal(r.recognized, 0, 'and gets no deduction for it');
  assert.ok(Math.abs(r.disallowedLoss - -r.gross) < 1e-9);
});

test('CB-6: so a PERSONAL matched facility is taxed in either direction — the phantom', () => {
  // Perfectly hedged economically; one leg recognized, the other disallowed. This is
  // the design 87 §4 finding, and it is why a personal residence differs from a rental.
  //
  // The two legs are taxed in DIFFERENT POOLS, which is design 87 §14.4 item 6 and is why
  // this reads the debt leg's `recognized` and the deposit leg's `capitalGain`: the
  // obligor sold no capital asset, the holder did. So the phantom is measured as the sum
  // of whatever each leg actually puts on a return.
  for (const spot of [STRONG, WEAKER]) {
    const debt    = computeSection988Gain(100_000, ACQ, spot, 0, false, PERSONAL_CHARACTER.ORDINARY);
    const deposit = computeCurrencyDisposition(100_000, ACQ, spot, 0);
    const net = debt.recognized + debt.capitalGain + deposit.recognized + deposit.capitalGain;
    assert.ok(net > 0, `expected a phantom gain at spot ${spot}, got ${net}`);
    // Exactly one leg produced it, and the other produced a disallowed loss of the same
    // size. That is Quijano in two assertions.
    assert.ok(debt.disallowedLoss > 0 || deposit.disallowedLoss > 0);
    assert.ok(Math.abs(net - (debt.disallowedLoss + deposit.disallowedLoss)) < 1e-9);
  }
});

test('CB-6b: and the phantom lands in different POOLS on each leg — G10', () => {
  // The working-detector control for the character split: at the spot where the DEBT leg
  // gains, its gain is ordinary and its capital pool is empty; at the spot where the
  // DEPOSIT leg gains, the reverse. Without this the character branch could be inert and
  // CB-6 would still pass.
  const debtGains    = computeSection988Gain(100_000, ACQ, WEAKER, 0, false, PERSONAL_CHARACTER.ORDINARY);
  assert.ok(debtGains.recognized > 0 && debtGains.capitalGain === 0);
  const depositGains = computeCurrencyDisposition(100_000, ACQ, STRONG, 0);
  assert.ok(depositGains.capitalGain > 0 && depositGains.recognized === 0);
});

test('CB-7: on a RENTAL the same pair nets to zero — the trap is disarmed', () => {
  for (const spot of [STRONG, WEAKER]) {
    const net = computeSection988Gain(100_000, ACQ, spot, 1, false).recognized
              + computeCurrencyDisposition(100_000, ACQ, spot, 1).recognized;
    assert.ok(Math.abs(net) < 1e-9);
  }
});

test('CB-8: the harmonic blend preserves the pool\'s total USD basis', () => {
  const blended = blendCurrencyBasisRate(300_000, ACQ, 100_000, WEAKER);
  assert.ok(Math.abs(400_000 / blended - (300_000 / ACQ + 100_000 / WEAKER)) < 1e-6);
  assert.ok(blended > ACQ && blended < WEAKER);
});

// ─── the pool predicate and basis handling ────────────────────────────────────

test('CB-9: the pool test is keyed on CURRENCY, not on account type', () => {
  assert.equal(isForeignCurrencyPool({ type: 'savings', currency: AUD }), true);
  assert.equal(isForeignCurrencyPool({ type: 'offset',  currency: AUD }), true);
  assert.equal(isForeignCurrencyPool({ type: 'savings', currency: USD }), false,
    'the functional currency is not a §988 pool (§985(b)(1))');
  assert.equal(isForeignCurrencyPool({ type: 'super',   currency: AUD }), false,
    'a pension interest is not a bank deposit — design 87 §5 keeps it out');
  assert.equal(isForeignCurrencyPool(null), false);
});

test('CB-10: a currency pool is PERSONAL by default', () => {
  assert.equal(currencyPoolBusinessFraction({ currency: AUD }), 0,
    'defaulting to business would silently deduct personal losses §165(c) denies');
  assert.equal(currencyPoolBusinessFraction({ deductibleFraction: 0.6 }), 0.6);
  assert.equal(currencyPoolBusinessFraction({ deductibleFraction: 9 }), 1, 'clamped');
});

test('CB-11: an unstamped pool is stamped at the live rate and realizes nothing', () => {
  const state = { effectiveExchangeRates: { USD_AUD: WEAKER } };
  const acct  = { type: 'savings', currency: AUD, balance: 100_000, fxBasisRate: null };
  const r = realizeCurrencyDisposition(state, 'auSav', acct, 10_000, 'US');
  assert.equal(r.actions.length, 0, 'no history ⇒ no gain invented');
  assert.equal(r.patch.fxBasisRate, WEAKER);
});

test('CB-12: a stamped pool realizes on a debit and carries key, currency and residency', () => {
  const state = { effectiveExchangeRates: { USD_AUD: STRONG } };
  const acct  = { type: 'savings', currency: AUD, balance: 100_000,
                  fxBasisRate: ACQ, deductibleFraction: 1 };
  const r = realizeCurrencyDisposition(state, 'auSav', acct, 100_000, 'AU');
  assert.equal(r.actions.length, 1);
  assert.equal(r.actions[0].type, 'SECTION_988_GAIN');
  assert.equal(r.actions[0].accountKey, 'auSav');
  assert.equal(r.actions[0].currency, 'AUD');
  assert.equal(r.actions[0].residency, 'AU');
  assert.ok(r.actions[0].amount > 0);
});

test('CB-13: acquiring currency realizes nothing and blends off the PRE-credit balance', () => {
  const state = { effectiveExchangeRates: { USD_AUD: WEAKER } };
  // balance already mutated to 400k by transaction(); the blend must use 300k.
  const acct  = { type: 'savings', currency: AUD, balance: 400_000, fxBasisRate: ACQ };
  const patch = acquireCurrencyBasis(state, acct, 300_000, 100_000);
  assert.ok(Math.abs(patch.fxBasisRate - blendCurrencyBasisRate(300_000, ACQ, 100_000, WEAKER)) < 1e-12);
});

// ─── the offset leg through the real payment path ─────────────────────────────

function makeSvc() {
  const g = new Graph();
  return new AccountService(g, new GraphQueryApi(g), new EventBus());
}

/** A fully-offset AUD P&I loan funded from the offset — the live-scenario shape. */
function offsetLoanState({ rate = STRONG, fxBasisRate = ACQ, bookingFxRate = ACQ,
                           deductibleFraction = null } = {}) {
  return {
    effectiveExchangeRates: { USD_AUD: rate },
    people: { primary: { residency: 'US' } },
    auHouseProperty: { rentalEnabled: true, stateKey: 'auHouseProperty', ownerId: 'primary' },
    hLoan: {
      type: 'loan', kind: 'account', stateKey: 'hLoan', balance: 300_000,
      monthlyPayment: 5_000, interestRate: 0.06, primeSpread: null, interestOnly: false,
      linkedPropertyKey: 'auHouseProperty', bookingFxRate,
      country: 'AU', currency: AUD, holdings: [],
    },
    off: {
      type: 'offset', kind: 'account', stateKey: 'off', balance: 310_000,
      offsetsPropertyKey: 'auHouseProperty', country: 'AU', currency: AUD,
      minimumBalance: 0, drawdownPriority: null, holdings: [],
      fxBasisRate, deductibleFraction,
    },
    cash: {
      type: 'savings', kind: 'account', stateKey: 'cash', balance: 5_000_000,
      country: 'AU', currency: AUD, minimumBalance: 0, drawdownPriority: 1, holdings: [],
    },
  };
}

/**
 * One loan payment, bracketed by the currency lot observer exactly as `_processReducers`
 * brackets it in a real run.
 *
 * Design 87 phase 3 moved the CASH leg out of `LoanPaymentApplyReducer` and onto the
 * observer, which the reducer signals with `section988: { kind: 'DISPOSE' }`. The debt leg
 * (design 86 P8) still comes from the reducer. Both legs are collected here so CB-14..18
 * keep asserting the same finding — the cancellation of §3 — at the level it now happens.
 */
function payOnce(state) {
  const handler  = new LoanPaymentHandler();
  const reducer  = new LoanPaymentApplyReducer({ accountService: makeSvc() });
  const observer = createCurrencyLotObserver();
  const date     = new Date('2030-06-30');
  let emitted = [];
  for (const action of handler.call({ state })) {
    if (action.type !== 'LOAN_PAYMENT_APPLY') continue;
    const token = observer.before(state);
    const res   = reducer.reduce(state, action);
    state       = res.state ?? res;
    const obs   = observer.after(state, token, action, date);
    emitted = emitted.concat(
      [...(res.next ?? []), ...obs].filter(a => a.type === 'SECTION_988_GAIN'));
  }
  return { state, emitted };
}

test('CB-14: a fully-offset P&I loan realizes §988 on BOTH legs, not one', () => {
  const { emitted } = payOnce(offsetLoanState({ deductibleFraction: 1 }));
  assert.equal(emitted.length, 2, 'the debt leg and the currency leg');
  assert.equal(emitted.filter(a => a.loanKey).length, 1);
  assert.equal(emitted.filter(a => a.accountKey === 'off').length, 1);
});

test('CB-15: on a matched rental facility the two legs CANCEL — design 87 §3', () => {
  const { emitted } = payOnce(offsetLoanState({ deductibleFraction: 1 }));
  const net = emitted.reduce((s, a) => s + a.amount, 0);
  assert.ok(Math.abs(net) < 1e-6,
    `a matched facility is §988-neutral; got ${net} from ${JSON.stringify(emitted)}`);
});

test('CB-16: they cancel whichever way the currency moved', () => {
  for (const rate of [STRONG, WEAKER]) {
    const { emitted } = payOnce(offsetLoanState({ rate, deductibleFraction: 1 }));
    const net = emitted.reduce((s, a) => s + a.amount, 0);
    assert.ok(Math.abs(net) < 1e-6, `net must be 0 at ${rate}, got ${net}`);
  }
});

test('CB-17: MISMATCHED endpoints do not cancel — the case worth modelling', () => {
  // The offset was funded at a different rate from the loan's origination, so the two
  // legs share no measuring window.
  const { emitted } = payOnce(offsetLoanState({ fxBasisRate: 1.30, deductibleFraction: 1 }));
  const net = emitted.reduce((s, a) => s + a.amount, 0);
  assert.ok(Math.abs(net) > 1, `expected a real residual, got ${net}`);
});

test('CB-18: an unstamped offset is stamped and realizes only its debt leg that period', () => {
  const { state, emitted } = payOnce(offsetLoanState({ fxBasisRate: null, deductibleFraction: 1 }));
  assert.equal(emitted.filter(a => a.accountKey === 'off').length, 0);
  assert.equal(state.off.fxBasisRate, STRONG, 'stamped at the rate in force');
});

// ─── the de minimis, on the leg §988(e)(2) was written for ────────────────────

test('CB-19: a personal currency gain of $200 or less is de minimis', () => {
  const small = computeCurrencyDisposition(2_000, ACQ, 1.3949, 0);
  assert.ok(small.gross > 0 && small.gross <= 200, `expected a small gain, got ${small.gross}`);
  assert.equal(small.recognized, 0);
});

test('CB-20: the DEBT leg no longer applies the de minimis — design 87 G4', () => {
  // §988(e)(2) reaches dispositions of nonfunctional currency; retiring a debt is not
  // one. Same inputs, opposite answers, and that is the point.
  const debt = computeSection988Gain(2_000, ACQ, 1.4051, 0, false, PERSONAL_CHARACTER.ORDINARY);
  assert.ok(debt.gross > 0 && debt.gross <= 200);
  assert.ok(Math.abs(debt.recognized - debt.gross) < 1e-9, 'recognized in full');
  assert.equal(debt.deMinimis, 0);
});

test('CB-21: the de minimis never rescues a loss, on either leg', () => {
  const small = computeCurrencyDisposition(2_000, ACQ, 1.4051, 0);
  assert.ok(small.gross < 0);
  assert.equal(small.deMinimis, 0, '§988(e)(2) is written for gain only');
  assert.ok(small.disallowedLoss > 0);
});

// ─── G9: foreign-currency BONDS are §988 property, equity and gold are not ────

import { BondMaturityReducer } from '../../src/finance/economic-regimes/bond-maturity-reducer.js';
import { ALLOCATION }          from '../../src/finance/holdings/allocation.js';
import { section988ForBondPrincipal } from '../../src/finance/account-rules/bond-currency-basis.js';
import { consumeHoldings as _consumeHoldings } from '../../src/finance/holdings/holdings-fifo.js';

const MATURED = new Date(Date.UTC(2029, 0, 1)).toISOString();

function maturityState({ allocation = ALLOCATION.BOND, currency = AUD, fxBasisRate = ACQ,
                         rate = STRONG, type = 'brokerage' } = {}) {
  return {
    currentPeriods: { AU: { startMs: Date.UTC(2030, 0, 1) } },
    effectiveExchangeRates: { USD_AUD: rate },
    effectiveInterestRates: {}, yieldCurve: {},
    people: { primary: { residency: 'US' } },
    auBrokerage: {
      type, kind: 'account', stateKey: 'auBrokerage', balance: 100_000,
      country: 'AU', currency, ownerId: 'primary',
      holdings: [{
        id: 'h1', allocation, rateKey: 'BOND_AU', marketValue: 100_000, costBasis: 100_000,
        faceValue: 100_000, maturityDate: MATURED, fxBasisRate,
      }],
    },
  };
}

const redeemOnce = (state) => {
  const res = new BondMaturityReducer().reduce(state, { type: 'AU_PERIOD_ADVANCE' });
  return (res.next ?? []).filter(a => a.type === 'SECTION_988_GAIN');
};

test('CB-22: redeeming an AUD BOND realizes §988 on principal — Reg. 1.988-2(b)(5)', () => {
  const emitted = redeemOnce(maturityState());
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].holdingId, 'h1');
  assert.equal(emitted[0].currency, 'AUD');
  assert.ok(emitted[0].amount > 0, 'AUD strengthened ⇒ the holder gained');
});

test('CB-23: an EQUITY holding realizes NOTHING — not on the §988(c)(1)(B) list', () => {
  // The currency move rides inside the capital gain via §1001. Booking §988 here would
  // double-count it AND recharacterise capital gain as ordinary.
  assert.equal(redeemOnce(maturityState({ allocation: ALLOCATION.EQUITY })).length, 0);
});

test('CB-24: a USD bond is not a §988 transaction', () => {
  assert.equal(redeemOnce(maturityState({ currency: USD })).length, 0);
});

test('CB-25: an unstamped bond realizes nothing rather than inventing a rate', () => {
  assert.equal(redeemOnce(maturityState({ fxBasisRate: null })).length, 0);
});

test('CB-26: super is out of scope — a pension interest is its own regime', () => {
  assert.equal(redeemOnce(maturityState({ type: 'super' })).length, 0);
});

test('CB-27: the sign follows the HOLDER, opposite to the obligor', () => {
  const gain = redeemOnce(maturityState({ rate: STRONG }));
  const loss = redeemOnce(maturityState({ rate: WEAKER }));
  assert.ok(gain[0].amount > 0, 'AUD stronger ⇒ the holder of AUD gained');
  assert.ok(loss[0].amount < 0, 'AUD weaker ⇒ the holder lost');
});

// ─── G9 second half: "or the instrument is DISPOSED OF" ───────────────────────
// Reg. §1.988-2(b)(5) has two triggers and only the first (principal received) was
// built. These cover the second, which runs through `consumeHoldings` — a completely
// different seam from the maturity reducer.

const auBondAccount = ({ fxBasisRate = ACQ, faceValue = 100_000 } = {}) => ({
  type: 'brokerage', kind: 'account', stateKey: 'auBrokerage', balance: 100_000,
  country: 'AU', currency: AUD, ownerId: 'primary',
  holdings: [{
    id: 'b1', allocation: ALLOCATION.BOND, rateKey: 'BOND_AU',
    marketValue: 100_000, costBasis: 100_000, faceValue,
    purchaseDate: new Date(Date.UTC(2020, 0, 1)), maturityDate: MATURED, fxBasisRate,
  }],
});

const saleState = (rate = STRONG, opts) => ({
  currentPeriods: { AU: { startMs: Date.UTC(2026, 0, 1) } },
  effectiveExchangeRates: { USD_AUD: rate },
  people: { primary: { residency: 'US' } },
  auBrokerage: auBondAccount(opts),
});

test('CB-33: consumeHoldings tallies the §988 PRINCIPAL of a foreign bond it consumes', () => {
  const acct = auBondAccount();
  const r = consumeHoldings(acct.holdings, 40_000, { terms: { asOfMs: Date.UTC(2026, 0, 1), countries: ['US'] } });
  assert.ok(r.section988, 'a foreign BOND lot must produce a tally');
  // 40% of the lot consumed ⇒ 40% of PAR, not 40% of proceeds. Those coincide here on
  // purpose so a later test can separate them.
  assert.equal(r.section988.principal, 40_000);
  assert.ok(Math.abs(r.section988.usdBasis - 40_000 / ACQ) < 1e-6);
  assert.ok(r.section988.weightedDays > 365 * 5, 'held since 2020');
});

test('CB-34: and it measures PAR, not proceeds — a bond marked below par', () => {
  // The whole point of Reg. §1.988-2(b)(5): the instrument's own price movement stays
  // capital under §1001, and only the exchange component of PRINCIPAL is §988. A lot
  // marked at 90 must still book §988 on 100 of par when it is fully sold.
  const acct = auBondAccount();
  acct.holdings[0].marketValue = 90_000;
  const r = consumeHoldings(acct.holdings, 90_000, {});
  assert.equal(r.section988.principal, 100_000, 'par, not the 90,000 of proceeds');
});

test('CB-35: an EQUITY sale produces NO tally — the working-detector control', () => {
  // Byte-identical numbers, one field different. Without this, CB-33 would pass equally
  // well against a tally that fired on every lot.
  const acct = auBondAccount();
  acct.holdings[0].allocation = ALLOCATION.EQUITY;
  assert.equal(consumeHoldings(acct.holdings, 40_000, {}).section988, null);
});

test('CB-36: an unstamped bond produces no tally rather than inventing a rate', () => {
  const acct = auBondAccount({ fxBasisRate: null });
  assert.equal(consumeHoldings(acct.holdings, 40_000, {}).section988, null);
});

test('CB-37: a partly-sold bond keeps only the UNSOLD part of its faceValue', () => {
  // Before design 87 G9 went looking, `faceValue` rode through the partial spread whole,
  // so a half-sold bond redeemed the FULL original par at maturity — and would have
  // booked §988 on the same units twice.
  const acct = auBondAccount();
  const r = consumeHoldings(acct.holdings, 40_000, {});
  assert.equal(r.newHoldings.length, 1);
  assert.equal(r.newHoldings[0].faceValue, 60_000);
  assert.equal(r.section988.principal + r.newHoldings[0].faceValue, 100_000,
    'principal disposed of + principal remaining must conserve');
});

test('CB-38: selling an AU bond before maturity emits SECTION_988_GAIN', () => {
  const state = saleState(STRONG);
  const r = consumeHoldings(state.auBrokerage.holdings, 100_000,
                            { terms: { asOfMs: Date.UTC(2026, 0, 1), countries: ['US'] } });
  const acts = section988ForBondPrincipal(state, 'auBrokerage', state.auBrokerage, r.section988);
  assert.equal(acts.length, 1);
  assert.ok(acts[0].amount > 0, 'AUD strengthened ⇒ the holder gained');
  assert.equal(acts[0].longTerm, true, 'held since 2020 — and a bond CAN date itself');
  // The same principal, at the same two rates, must give the same answer whichever
  // trigger fired. If these ever diverge, one of the two seams has drifted.
  const atMaturity = redeemOnce(maturityState({ rate: STRONG }));
  assert.ok(Math.abs(acts[0].gross - atMaturity[0].gross) < 1e-6,
    'sale and redemption must value the same principal identically');
});

test('CB-39: a USD bond sale emits nothing — currency is what decides', () => {
  const state = saleState(STRONG);
  state.auBrokerage.currency = USD;
  const r = consumeHoldings(state.auBrokerage.holdings, 100_000, {});
  assert.equal(section988ForBondPrincipal(state, 'auBrokerage', state.auBrokerage, r.section988).length, 0);
});

test('CB-40: a ROLL re-stamps fxBasisRate at the roll rate — no double-count', () => {
  // The matured principal was just realized, and the roll BUYS a different instrument.
  // Carrying the old rate would measure the next redemption against a rate that never
  // applied to the new bond, recognizing the same movement a second time.
  const state = maturityState({ rate: STRONG });
  state.auBrokerage.holdings[0].rollAtMaturity = true;
  state.auBrokerage.holdings[0].purchaseDate   = new Date(Date.UTC(2020, 0, 1));
  const res = new BondMaturityReducer().reduce(state, { type: 'AU_PERIOD_ADVANCE' });
  const rolled = res.auBrokerage.holdings[0];
  assert.equal(rolled.allocation, ALLOCATION.BOND, 'still a bond');
  assert.equal(rolled.fxBasisRate, STRONG, 're-stamped at the roll rate, not carried');
});

test('CB-41: redeeming to CASH clears fxBasisRate — a cash pool banks its basis on the ACCOUNT', () => {
  const state = maturityState({ rate: STRONG });
  const res = new BondMaturityReducer().reduce(state, { type: 'AU_PERIOD_ADVANCE' });
  const cash = res.auBrokerage.holdings[0];
  assert.equal(cash.allocation, ALLOCATION.CASH);
  assert.equal(cash.fxBasisRate, null,
    'a per-holding rate here would be a second, contradictory basis for the same money');
});

// ─── §11: CASH realizes no capital gain, on EVERY disposal path ───────────────

import { consumeHoldings } from '../../src/finance/holdings/holdings-fifo.js';
import { Holding }         from '../../src/finance/holdings/holding.js';

const staleCash = () => ([{ id: 'c1', allocation: ALLOCATION.CASH, marketValue: 34_000,
                            costBasis: 920.78, rateKey: 'SAVINGS_US' }]);

test('CB-28: consuming CASH realizes NO gain, whatever basis the lot carries', () => {
  // The drawdown path used to book the whole proceeds as gain when basis was stale.
  // rebalance-to-target-apply-reducer has always excluded CASH; this path did not.
  const r = consumeHoldings(staleCash(), 10_000, {});
  assert.ok(Math.abs(r.realizedBasis - 10_000) < 1e-6,
    `basis must equal proceeds for cash, got ${r.realizedBasis}`);
});

test('CB-29: the working-detector control — EQUITY with identical numbers DOES realize', () => {
  // Without this, CB-28 would pass just as well against a function that realized
  // nothing at all.
  const eq = [{ ...staleCash()[0], allocation: ALLOCATION.EQUITY, rateKey: 'EQUITY_US' }];
  const r  = consumeHoldings(eq, 10_000, {});
  assert.ok(10_000 - r.realizedBasis > 9_000, 'a stale equity basis still produces gain');
});

test('CB-30: a partial CASH consume leaves basis == value, never negative', () => {
  // basis(921) − proceeds(10,000) would be −9,079 if the remainder subtracted.
  const r = consumeHoldings(staleCash(), 10_000, {});
  const rest = r.newHoldings[0];
  assert.equal(rest.marketValue, 24_000);
  assert.equal(rest.costBasis,   24_000);
});

test('CB-31: CASH is never indexed — inflation cannot create a loss on money', () => {
  const r = consumeHoldings(staleCash(), 10_000, {
    indexation: { country: 'AU', asOfMs: Date.UTC(2040, 0, 1), level: 2.0 },
  });
  // `realizedBasisByCountry` is only keyed for lots carrying a per-country override;
  // callers read it as `?? realizedBasis`, which is the quantity that matters here.
  assert.ok(Math.abs((r.realizedBasisByCountry?.AU ?? r.realizedBasis) - 10_000) < 1e-6);
  assert.ok(Math.abs((r.realizedIndexedBasisByCountry?.AU ?? 0) - 10_000) < 1e-6,
    'an index factor of 2 must not double a currency balance\'s basis');
  assert.ok(Math.abs(r.realizedDiscountableGainByCountry?.AU ?? 0) < 1e-6,
    'and no discountable gain, because there is no gain');
});

test('CB-32: the Holding constructor enforces CASH basis == value', () => {
  const h = new Holding({ allocation: ALLOCATION.CASH, marketValue: 364_000,
                          costBasis: 675_675.68, rateKey: 'SAVINGS_AU' });
  assert.equal(h.costBasis, 364_000, 'a stale ratio must not survive construction');

  // EQUITY keeps whatever basis it is given — that is real CGT data.
  const e = new Holding({ allocation: ALLOCATION.EQUITY, marketValue: 364_000,
                          costBasis: 675_675.68, rateKey: 'EQUITY_AU' });
  assert.equal(e.costBasis, 675_675.68);
});

// ─── G6: the consumption method is an ELECTION, and it has to actually reach the ledger ──
//
// `§1.988-2(a)(2)(iii)(B)(1)` requires the method be "consistently applied from year to
// year by the taxpayer to all accounts", which makes it a property of the taxpayer rather
// than of a run — so a scenario carries it and a saved plan must not silently revert.
//
// These exist because the first wiring of that election was SILENTLY INERT: the observer
// read the field at construction, inside `buildSim()`, while the toolset's state patch is
// not applied until `ScenarioLoader.load()` runs afterwards. Every run quietly used
// pro-rata whatever the scenario said, and the only visible symptom was that FIFO's
// `fxLots` never appeared. The end-to-end case is the one that catches that class of bug;
// the unit case alone would have passed throughout.

import { loadScenarioSim } from '../helpers/scenario-harness.js';
import { LEDGER_METHOD }   from '../../src/finance/account-rules/currency-lots.js';

test('CB-42: state.fxBasisMethod selects the convention — FIFO publishes lots, pro-rata does not', () => {
  const observer = createCurrencyLotObserver();
  const run = (method) => {
    const state = {
      fxBasisMethod: method,
      effectiveExchangeRates: { USD_AUD: ACQ },
      auSavings: { type: 'savings', currency: AUD, balance: 10_000, drawdownPriority: 1 },
    };
    const token = observer.before(state);
    state.auSavings.balance = 15_000;                        // a credit ⇒ acquire a lot
    observer.after(state, token, { type: 'X' }, '2026-01-01');
    return state.auSavings;
  };
  assert.ok(Array.isArray(run(LEDGER_METHOD.FIFO).fxLots), 'FIFO must publish its lots');
  assert.equal(run(LEDGER_METHOD.PRO_RATA).fxLots, undefined,
    'pro-rata never consults a lot, so publishing hundreds would bury every golden diff');
  assert.equal(run('nonsense').fxLots, undefined,
    'an unreadable election falls back to the incumbent rather than throwing — it arrives from state');
});

test('CB-43: the election survives the BUILD ORDER and reaches a real run end-to-end', () => {
  const endState = (fxBasisMethod) => loadScenarioSim({
    params: { fxBasisMethod, fxProcessModel: 'MEAN_REVERTING', fxVolatility: 0.1, randomSeed: 1 },
    simStart: new Date(Date.UTC(2026, 0, 1)),
    simEnd:   new Date(Date.UTC(2030, 0, 1)),
    stepTo:   new Date(Date.UTC(2030, 0, 1)),
    telemetry: 'off',
  }).sim.state;

  const fifo = endState('fifo');
  const pro  = endState('pro-rata');
  assert.equal(fifo.fxBasisMethod, 'fifo', 'the parameter must reach state at all');
  // The working detector: an AU pool must actually carry lots under FIFO. Asserting only
  // on `state.fxBasisMethod` would have passed against the inert wiring, because the
  // field DID reach state — it was the observer that never read it.
  const lotsUnder = (s) => Object.values(s)
    .filter(v => v && typeof v === 'object' && Array.isArray(v.fxLots)).length;
  assert.ok(lotsUnder(fifo) > 0, 'FIFO must leave lot ledgers on the AU pools');
  assert.equal(lotsUnder(pro), 0, 'pro-rata must leave none');
});
