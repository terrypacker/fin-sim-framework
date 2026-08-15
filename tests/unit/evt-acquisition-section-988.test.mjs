/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * evt-acquisition-section-988.test.mjs — design 87 §14.4 items 3 and 4.
 *
 * The low-volume dispositions: currency exchanged for property, paid into super, or
 * paid against a legacy scalar mortgage. Each is a `§1.988-2(a)(2)(ii)(B)` disposition —
 * a sale of the units for USD at spot, then a purchase for those dollars — and until it
 * was declared, each read as a `(a)(1)(iii)(C)` non-recognition withdrawal.
 *
 * The interesting question in all three is the §988(e)(3) FRACTION, and the answers do
 * not all go the same way:
 *
 *   ACQ988-1..3  property purchase — §212 on a rental, personal on a home.
 *                `§1.988-1(a)(9)(ii)` Example 1 is why a CAPITALIZED price is still §212.
 *   ACQ988-4..5  super contributions (ordinary and downsizer) — personal, deliberately.
 *   ACQ988-6..7  the legacy AU mortgage path, and how it differs from the loan path.
 *
 * Run with: node --test tests/unit/evt-acquisition-section-988.test.mjs
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import { AuPropertyPurchaseHandler, PropertyPurchaseApplyReducer }
  from '../../src/finance/account-rules/property-purchase.js';
import { SuperContributionApplyReducer } from '../../src/finance/account-rules/au/au-super-classes.js';
import { SuperDownsizerContributionApplyReducer }
  from '../../src/finance/account-rules/au/downsizer-contribution.js';
import { AuMortgagePaymentHandler, AuMortgagePaymentApplyReducer }
  from '../../src/finance/account-rules/mortgage-payment-classes.js';
import { createCurrencyLotObserver } from '../../src/finance/account-rules/currency-lot-observer.js';
import { AccountService } from '../../src/finance/services/account-service.js';
import { ALLOCATION }     from '../../src/finance/holdings/allocation.js';
import { ACCOUNT_ROLES }  from '../../src/finance/state/account-roles.js';

const STRONG = 1.30;
const WEAK   = 1.55;
const DATE   = new Date('2030-06-30');

function deposit({ stateKey, balance, currency = 'AUD', country = 'AU', role, ...rest }) {
  return {
    id: stateKey, stateKey, country, role,
    currency: { code: currency, symbol: '$' },
    balance, minimumBalance: 0, ownerId: 'primary',
    holdings: [{ id: `${stateKey}-cash`, allocation: ALLOCATION.CASH,
                 marketValue: balance, costBasis: balance }],
    ...rest,
  };
}

/** Base state: an AUD pool whose basis rate differs from spot, so a disposal is visible. */
function baseState({ rate = STRONG, basisRate = WEAK, balance = 2000000, extra = {} } = {}) {
  return {
    effectiveExchangeRates: { USD_AUD: rate },
    inflationAccumulator: { AU: 1, US: 1 },
    currentPeriods: { AU: { startMs: Date.UTC(2030, 6, 1) }, US: { startMs: Date.UTC(2030, 0, 1) } },
    people: { primary: { id: 'primary', residency: 'AU', birthDate: new Date('1966-01-01') } },
    auSavingsAccount: deposit({ stateKey: 'auSavingsAccount', balance,
                                role: ACCOUNT_ROLES.AU_SAVINGS, fxBasisRate: basisRate }),
    ...extra,
  };
}

const registry = {
  getStateKey: () => 'auSavingsAccount',
  resolveTransactionAccountKey: () => 'auSavingsAccount',
  getFlaggedStateKey: () => null,
};

/** Run one reducer inside an observer bracket and return what it realized. */
function observe(reducer, state, action, observer = createCurrencyLotObserver()) {
  const token  = observer.before(state);
  const result = reducer.reduce(state, action, DATE);
  if (result?.state) Object.assign(state, result.state);
  else if (result && !result.next) Object.assign(state, result);
  return observer.after(state, token, action, DATE);
}

// ─── ACQ988-1..3 · property purchase ──────────────────────────────────────────────────

function purchaseAction({ rentalEnabled }) {
  const state = baseState({ extra: {
    auHouse: { stateKey: 'auHouse', value: 0, country: 'AU', currency: { code: 'AUD' },
               purchasePrice: 900000, rentalEnabled },
  } });
  const h = new AuPropertyPurchaseHandler({ stateRegistry: registry });
  const actions = h.call({ data: { stateKey: 'auHouse', purchaseYear: 2030, startYear: 2026 }, state });
  return { state, apply: actions.find(a => a.type === 'PROPERTY_PURCHASE_APPLY') };
}

test('ACQ988-1 buying property with AUD is a disposition, priced at spot', () => {
  const { state, apply } = purchaseAction({ rentalEnabled: false });
  assert.ok(apply, 'the purchase fired');
  assert.equal(apply.section988.kind, 'DISPOSE');
  assert.equal(apply.section988.accountKey, 'auSavingsAccount');

  const emitted = observe(new PropertyPurchaseApplyReducer({
    accountService: new AccountService(), stateRegistry: registry }), state, apply);

  assert.equal(emitted.length, 1, 'the currency spent on the house realized');
  // 900,000 AUD of basis at 1.55 = 580,645 USD; spent at 1.30 it buys 692,308 USD of
  // house. A strengthening AUD is a gain.
  const expected = 900000 / STRONG - 900000 / WEAK;
  assert.ok(Math.abs(emitted[0].gross - expected) < 0.5,
    `gross ${emitted[0].gross} should be ${expected}`);
});

test('ACQ988-2 a RENTAL purchase is §212 ordinary; a HOME purchase is personal', () => {
  // `§1.988-1(a)(9)(ii)` Example 1: X buys pounds and immediately acquires a
  // pound-denominated bond, and the reg holds BOTH are §988 transactions "because
  // expenses properly allocable to such transactions meet the requirements of section
  // 212" — even though a purchase price is capitalized rather than deducted. Example 2's
  // holiday spending is the other side of the same line.
  const rental = purchaseAction({ rentalEnabled: true });
  const home   = purchaseAction({ rentalEnabled: false });
  assert.equal(rental.apply.section988.businessFraction, 1);
  assert.equal(home.apply.section988.businessFraction, 0);
  assert.equal(rental.apply.cashDue, home.apply.cashDue,
    'CONTROL: identical money, and only the character differs');

  const gR = observe(new PropertyPurchaseApplyReducer({
    accountService: new AccountService(), stateRegistry: registry }), rental.state, rental.apply)[0];
  const gH = observe(new PropertyPurchaseApplyReducer({
    accountService: new AccountService(), stateRegistry: registry }), home.state, home.apply)[0];

  assert.ok(Math.abs(gR.gross - gH.gross) < 0.01, 'the same gain');
  assert.ok(gR.amount > 0 && gR.capitalGain === 0, 'the rental books ORDINARY §988');
  assert.equal(gH.amount, 0, 'the home books nothing ordinary');
  assert.ok(gH.capitalGain > 0, 'and the whole gain falls to the capital branch');
});

test('ACQ988-3 an unaffordable purchase realizes only what the pool could fund', () => {
  // The reducer caps the debit to the available balance. No `units` is declared, so the
  // observer measures the ACTUAL movement — which is design 87 §6's "realize in the
  // reducer, not the handler" obtained for free rather than by declaration.
  const { state, apply } = purchaseAction({ rentalEnabled: true });
  state.auSavingsAccount.balance = 300000;
  state.auSavingsAccount.holdings[0].marketValue = 300000;
  state.auSavingsAccount.holdings[0].costBasis   = 300000;

  const emitted = observe(new PropertyPurchaseApplyReducer({
    accountService: new AccountService(), stateRegistry: registry }), state, apply);

  assert.equal(emitted.length, 1);
  const expected = 300000 / STRONG - 300000 / WEAK;   // 300k, not the 900k price
  assert.ok(Math.abs(emitted[0].gross - expected) < 0.5,
    `gross ${emitted[0].gross} should measure the 300000 actually paid, not the price`);
});

// ─── ACQ988-4..5 · super contributions ────────────────────────────────────────────────

function superState() {
  return baseState({ extra: {
    superAccount: { stateKey: 'superAccount', type: 'super', country: 'AU',
                    currency: { code: 'AUD' }, balance: 100000, contributionBasis: 100000,
                    holdings: [] },
  } });
}

test('ACQ988-4 a super contribution disposes AUD, and is PERSONAL', () => {
  // The super account is NOT the other half of a same-currency transfer: design 87 §5
  // puts super outside this design, and `isCurrencyLotPool` excludes `type: 'super'`. So
  // the credit is invisible to the ledger and the debit needs an explicit declaration or
  // it reads as a bare withdrawal.
  const state = superState();
  const action = { type: 'SUPER_CONTRIBUTION_APPLY', amount: 100000, stateKey: 'superAccount' };
  const emitted = observe(new SuperContributionApplyReducer({
    accountService: new AccountService(), stateRegistry: registry }), state, action);

  assert.equal(action.section988.kind, 'DISPOSE');
  assert.equal(action.section988.accountKey, 'auSavingsAccount');
  assert.equal(action.section988.businessFraction, 0,
    'a retirement contribution has no §162/§212 expenses allocable to it');
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].amount, 0, 'nothing ordinary');
  assert.ok(emitted[0].capitalGain > 0, 'the whole gain is capital');
});

test('ACQ988-5 a downsizer contribution follows the same rule', () => {
  // The two must agree, or one pool would split its §988 character on which kind of
  // contribution happened to be made.
  const state = superState();
  const action = { type: 'SUPER_DOWNSIZER_CONTRIBUTION_APPLY', amount: 100000,
                   personKey: 'primary', stateKey: 'superAccount' };
  const emitted = observe(new SuperDownsizerContributionApplyReducer({
    accountService: new AccountService(), stateRegistry: registry }), state, action);

  assert.equal(action.section988.kind, 'DISPOSE');
  assert.equal(action.section988.businessFraction, 0);
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].amount, 0);
  assert.ok(emitted[0].capitalGain > 0);
});

// ─── ACQ988-6..7 · the legacy scalar mortgage ─────────────────────────────────────────

function mortgageAction({ rentalEnabled }) {
  const state = baseState({ extra: {
    auHouse: { stateKey: 'auHouse', value: 900000, country: 'AU', currency: { code: 'AUD' },
               mortgageBalance: 400000, rentalEnabled },
  } });
  const h = new AuMortgagePaymentHandler({
    properties: [{ stateKey: 'auHouse', monthlyMortgage: 60000 }], stateRegistry: registry });
  const actions = h.call({ data: {}, state });
  return { state, apply: actions.find(a => a.type === 'AU_MORTGAGE_PAYMENT_APPLY') };
}

test('ACQ988-6 the legacy AU mortgage path disposes currency too', () => {
  // Easy to miss because the loan-account path already works — and the failure mode is
  // silent, since an undeclared debit is a valid non-recognition withdrawal.
  const { state, apply } = mortgageAction({ rentalEnabled: true });
  assert.ok(apply, 'the payment fired');
  assert.equal(apply.section988.kind, 'DISPOSE');
  assert.equal(apply.section988.accountKey, 'auSavingsAccount');

  const emitted = observe(new AuMortgagePaymentApplyReducer({
    accountService: new AccountService() }), state, apply);

  assert.equal(emitted.length, 1);
  const expected = 60000 / STRONG - 60000 / WEAK;
  assert.ok(Math.abs(emitted[0].gross - expected) < 0.01,
    `gross ${emitted[0].gross} should be ${expected}`);
});

test('ACQ988-7 the legacy mortgage fraction follows the PROPERTY, not the pool', () => {
  // The one place this path deliberately diverges from `LoanPaymentHandler`, which names
  // no fraction and lets the observer fall back to the pool's `deductibleFraction`. That
  // is right for an offset (design 87 §8 Q1 is genuinely open about an offset's §212
  // status) and wrong here, where the pool is the generic AU cash account: its scalar
  // defaults to 0, while the expense properly allocable to a mortgage payment — the
  // interest — is unambiguously §212 on a rental.
  const rental = mortgageAction({ rentalEnabled: true });
  const home   = mortgageAction({ rentalEnabled: false });
  assert.equal(rental.apply.section988.businessFraction, 1);
  assert.equal(home.apply.section988.businessFraction, 0);

  // The pool's own scalar says the opposite, and must lose: this is the per-disposition
  // fraction (G12) doing the thing an account-level scalar cannot.
  rental.state.auSavingsAccount.deductibleFraction = 0;
  const g = observe(new AuMortgagePaymentApplyReducer({
    accountService: new AccountService() }), rental.state, rental.apply)[0];
  assert.ok(g.amount > 0, 'ordinary §988, despite the pool scalar saying personal');
  assert.equal(g.capitalGain, 0);
});
