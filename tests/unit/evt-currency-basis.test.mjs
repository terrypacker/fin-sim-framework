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
  for (const spot of [STRONG, WEAKER]) {
    const net = computeSection988Gain(100_000, ACQ, spot, 0, false).recognized
              + computeCurrencyDisposition(100_000, ACQ, spot, 0).recognized;
    assert.ok(net > 0, `expected a phantom gain at spot ${spot}, got ${net}`);
  }
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
  const debt = computeSection988Gain(2_000, ACQ, 1.4051, 0, false);
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
