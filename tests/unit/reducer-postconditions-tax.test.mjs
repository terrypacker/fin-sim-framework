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
 * Group I — tax / period reducer postconditions (design 37 §6 I).
 *
 * Three behavioral classes:
 *  - DynamicTaxReducer (I1/I2/I7) — runtime-dispatches a tax-calc action to the
 *    correct year's BaseTaxModule reducer fn; pure (delegates to a pure fn).
 *  - Period-advance + tax-settle reducers (I1/I7/I10) — pure scalar/YTD writers.
 *    The settle reducers reset YTD accumulators and CHAIN the payment debit; §4.4
 *    (I3) / conservation (I5) for the settle family is event-level (settle resets
 *    YTD + chains *_TAX_PAYMENT_DEBIT), so the settle reducer's own row asserts
 *    the scalar reset + chained-debit contract + I1.
 *  - Tax-payment-debit reducers (I3/I4/I5/I7, NOT I1 — §7.3) — service-backed:
 *    AccountService.transaction()/replenishSavings() mutate in place, so
 *    runReducer is called with checkNoMutation:false and conservation is checked
 *    against a structuredClone snapshot.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { runReducer, assertStateUnchanged } from '../helpers/reducer-postconditions.js';
import { makeAccount, makeAccountState, makeAction, makeServices, makePeople } from '../helpers/reducer-fixtures.js';

import { ACCOUNT_ROLES } from '../../src/finance/state/account-roles.js';
import { DynamicTaxReducer } from '../../src/finance/tax/dynamic-tax-reducer.js';
import { UsPeriodAdvanceReducer, AuPeriodAdvanceReducer } from '../../src/finance/tax/period-advance-classes.js';
import {
  UsTaxSettleApplyReducer, AuTaxSettleApplyReducer,
  UsTaxPaymentDebitReducer, AuTaxPaymentDebitReducer,
} from '../../src/finance/tax/tax-settle-classes.js';

const DATE = new Date('2030-06-15');
const period = (y) => ({ startMs: Date.UTC(y, 0, 1), endMs: Date.UTC(y + 1, 0, 1) });

// ─── DynamicTaxReducer (I1/I2/I7) ──────────────────────────────────────────────

// Minimal tax engine stub: get(cc, year) → module whose getReducerFns() maps the
// action type to a *pure* reducer fn (the real BaseTaxModule fns are pure too).
function makeTaxEngine(fnByType) {
  const fns = new Map(Object.entries(fnByType));
  return { get: () => ({ getReducerFns: () => fns }) };
}

test('DynamicTaxReducer: dispatches to the resolved year-module reducer fn (I1)', () => {
  const fn = (s, a) => ({ ...s, usOrdinaryIncomeYTD: (s.usOrdinaryIncomeYTD ?? 0) + a.amount });
  const r = new DynamicTaxReducer(makeTaxEngine({ WAGES_INCOME_TAX: fn }), 'US', 'WAGES_INCOME_TAX');
  const state = { currentPeriods: { US: period(2030) }, usOrdinaryIncomeYTD: 1000 };
  const next = runReducer(r, state, makeAction('WAGES_INCOME_TAX', { amount: 5000 }), DATE);
  assert.equal(next.usOrdinaryIncomeYTD, 6000);
});

test('DynamicTaxReducer: an action the year-module does not handle returns state unchanged (I7)', () => {
  const r = new DynamicTaxReducer(makeTaxEngine({}), 'US', 'WAGES_INCOME_TAX'); // empty fn map
  const prev = { currentPeriods: { US: period(2030) }, usOrdinaryIncomeYTD: 1000 };
  const next = runReducer(r, structuredClone(prev), makeAction('WAGES_INCOME_TAX', { amount: 5000 }), DATE);
  assertStateUnchanged(prev, next);
});

test('DynamicTaxReducer: missing currentPeriods throws the wiring guard; deterministic (I2)', () => {
  const fn = (s, a) => ({ ...s, usOrdinaryIncomeYTD: (s.usOrdinaryIncomeYTD ?? 0) + a.amount });
  const r = new DynamicTaxReducer(makeTaxEngine({ WAGES_INCOME_TAX: fn }), 'US', 'WAGES_INCOME_TAX');
  assert.throws(() => r.reduce({}, makeAction('WAGES_INCOME_TAX', { amount: 1 }), DATE), /currentPeriods\.US is not set/);

  const state = { currentPeriods: { US: period(2030) }, usOrdinaryIncomeYTD: 0 };
  assert.deepEqual(
    r.reduce(structuredClone(state), makeAction('WAGES_INCOME_TAX', { amount: 5000 }), DATE),
    r.reduce(structuredClone(state), makeAction('WAGES_INCOME_TAX', { amount: 5000 }), DATE),
  );
});

// ─── Us/AuPeriodAdvanceReducer (I1/I7/I10) ─────────────────────────────────────

test('UsPeriodAdvanceReducer: sets currentPeriods.US; usFilingSingle tracks state.deceased (I1)', () => {
  const r = new UsPeriodAdvanceReducer();
  const joint = runReducer(r, { currentPeriods: {} }, makeAction('US_PERIOD_ADVANCE', { period: period(2031) }), DATE);
  assert.deepEqual(joint.currentPeriods.US, period(2031));
  assert.equal(joint.usFilingSingle, false, 'no deceased ⇒ joint');

  const widowed = runReducer(r, { currentPeriods: {}, deceased: { p1: { date: DATE } } }, makeAction('US_PERIOD_ADVANCE', { period: period(2031) }), DATE);
  assert.equal(widowed.usFilingSingle, true, 'a death ⇒ survivor files single');
});

test('UsPeriodAdvanceReducer: re-advancing the same period is idempotent (I10)', () => {
  const r = new UsPeriodAdvanceReducer();
  const once  = r.reduce({ currentPeriods: {} }, makeAction('US_PERIOD_ADVANCE', { period: period(2031) }), DATE);
  const twice = r.reduce(once, makeAction('US_PERIOD_ADVANCE', { period: period(2031) }), DATE);
  assert.deepEqual(twice.currentPeriods.US, period(2031));
  assert.equal(twice.usFilingSingle, false);
});

test('AuPeriodAdvanceReducer: sets currentPeriods.AU without disturbing US (I1)', () => {
  const r = new AuPeriodAdvanceReducer();
  const next = runReducer(r, { currentPeriods: { US: period(2030) } }, makeAction('AU_PERIOD_ADVANCE', { period: period(2031) }), DATE);
  assert.deepEqual(next.currentPeriods.AU, period(2031));
  assert.deepEqual(next.currentPeriods.US, period(2030), 'US period left intact');
});

// ─── Us/AuTaxSettleApplyReducer (I1; YTD reset + chained debit) ─────────────────

test('UsTaxSettleApplyReducer: resets US YTD fields and chains US_TAX_PAYMENT_DEBIT when tax>0 (I1)', () => {
  const r = new UsTaxSettleApplyReducer();
  const state = { usOrdinaryIncomeYTD: 50000, usCapitalGainsYTD: 8000, foreignPassiveIncomeYTD: 1200 };
  const next = runReducer(r, state, makeAction('US_TAX_SETTLE_APPLY', { tax: 9000 }), DATE);
  for (const f of ['usOrdinaryIncomeYTD', 'usCapitalGainsYTD', 'foreignPassiveIncomeYTD']) {
    assert.equal(next[f], 0, `${f} reset`);
  }
  const debit = next.next.find(a => a.type === 'US_TAX_PAYMENT_DEBIT');
  assert.equal(debit.amount, 9000);
  assert.equal(state.usOrdinaryIncomeYTD, 50000, 'I1: input not mutated');
});

test('UsTaxSettleApplyReducer: no debit chained when tax<=0 (I7)', () => {
  const r = new UsTaxSettleApplyReducer();
  const next = runReducer(r, { usOrdinaryIncomeYTD: 50000 }, makeAction('US_TAX_SETTLE_APPLY', { tax: 0 }), DATE);
  assert.equal(next.usOrdinaryIncomeYTD, 0, 'YTD still reset even with no liability');
  assert.equal(next.next.length, 0, 'no payment debit chained');
});

test('AuTaxSettleApplyReducer: resets scalar + per-person YTD maps; chains AU_TAX_PAYMENT_DEBIT (I1)', () => {
  const r = new AuTaxSettleApplyReducer();
  const state = {
    auOrdinaryIncomeYTD: 40000,
    auPersonOrdinaryIncomeYTD: { p1: 25000, p2: 15000 },
    auPersonCapitalGainsYTD:   { p1: 3000 },
  };
  const next = runReducer(r, state, makeAction('AU_TAX_SETTLE_APPLY', { tax: 7000 }), DATE);
  assert.equal(next.auOrdinaryIncomeYTD, 0);
  assert.deepEqual(next.auPersonOrdinaryIncomeYTD, { p1: 0, p2: 0 }, 'per-person map zeroed key-wise');
  assert.deepEqual(next.auPersonCapitalGainsYTD, { p1: 0 });
  assert.equal(next.next.find(a => a.type === 'AU_TAX_PAYMENT_DEBIT').amount, 7000);
});

// ─── Us/AuTaxPaymentDebitReducer (service-backed; I3/I4/I5, not I1 — §7.3) ──────

for (const [label, Reducer, type, key] of [
  ['UsTaxPaymentDebitReducer', UsTaxPaymentDebitReducer, 'US_TAX_PAYMENT_DEBIT', 'usSavingsAccount'],
  ['AuTaxPaymentDebitReducer', AuTaxPaymentDebitReducer, 'AU_TAX_PAYMENT_DEBIT', 'auSavingsAccount'],
]) {
  test(`${label}: debits the savings account by the tax amount, keeps §4.4 (I3/I4)`, () => {
    const services = makeServices();
    services.stateRegistry.getStateKey = () => key;
    const r = new Reducer(services);
    const state = makeAccountState({ stateKey: key, currency: key === 'auSavingsAccount' ? 'AUD' : 'USD', holdings: [{ id: 's1', marketValue: 10000, costBasis: 10000 }] });
    const prev = structuredClone(state);
    const next = runReducer(r, state, makeAction(type, { amount: 320 }), DATE,
      { checkNoMutation: false, balance: true, nonNegative: true });
    assert.equal(next[key].balance, 9680);
    assert.equal(prev[key].balance - next[key].balance, 320, 'debited exactly the tax');
  });
}

test('UsTaxPaymentDebitReducer: short balance escalates the residual cross-border (I4)', () => {
  const services = makeServices();
  services.stateRegistry.getStateKey = () => 'usSavingsAccount';
  const r = new UsTaxPaymentDebitReducer(services);
  const state = {
    people: makePeople({ residency: 'US' }),
    usSavingsAccount: makeAccount({ stateKey: 'usSavingsAccount', holdings: [{ id: 's1', marketValue: 100, costBasis: 100 }] }),
  };
  const next = runReducer(r, state, makeAction('US_TAX_PAYMENT_DEBIT', { amount: 320 }), DATE,
    { checkNoMutation: false, balance: true, nonNegative: true });
  assert.equal(next.usSavingsAccount.balance, 0, 'capped to available — never negative (I4)');
  // The $220 that same-country cash could not cover is NOT stranded: the reducer
  // escalates to INTL_TRANSFER_APPLY (symmetric with the spending path), which
  // liquidates the other country's investments into this tax account (dstKey) and
  // itself reports any still-uncoverable part as OUT_OF_FUNDS. A follow-up
  // escalated debit pays the tax out of the topped-up balance.
  const xfer = next.next.find(a => a.type === 'INTL_TRANSFER_APPLY');
  assert.ok(xfer, 'a residual tax bill escalates to a cross-border transfer');
  assert.equal(xfer.direction, 'AU_TO_US', 'US tax pulls from AU');
  assert.equal(Math.round(xfer.targetDeficit), 220);
  assert.equal(xfer.dstKey, 'usSavingsAccount', 'proceeds land in the tax account, not the default transaction account');
  const redebit = next.next.find(a => a.type === 'US_TAX_PAYMENT_DEBIT' && a.escalated);
  assert.ok(redebit, 'a follow-up escalated debit pays the topped-up balance');
  assert.equal(Math.round(redebit.amount), 220);
  // No direct OUT_OF_FUNDS from the tax reducer itself — the transfer owns that.
  assert.equal(next.next.find(a => a.type === 'OUT_OF_FUNDS'), undefined, 'residual is escalated, not stranded');
});

test('UsTaxPaymentDebitReducer: a fully-funded tax bill emits NO OUT_OF_FUNDS (I8)', () => {
  const services = makeServices();
  services.stateRegistry.getStateKey = () => 'usSavingsAccount';
  const r = new UsTaxPaymentDebitReducer(services);
  const state = {
    people: makePeople({ residency: 'US' }),
    usSavingsAccount: makeAccount({ stateKey: 'usSavingsAccount', holdings: [{ id: 's1', marketValue: 10000, costBasis: 10000 }] }),
  };
  const next = runReducer(r, state, makeAction('US_TAX_PAYMENT_DEBIT', { amount: 320 }), DATE,
    { checkNoMutation: false, balance: true, nonNegative: true });
  assert.equal(next.usSavingsAccount.balance, 9680);
  assert.equal(next.next.find(a => a.type === 'OUT_OF_FUNDS'), undefined, 'paid in full → no insolvency');
});

test('UsTaxPaymentDebitReducer: a tax owed with no US cash account is fully OUT_OF_FUNDS (I8)', () => {
  const services = makeServices();
  services.stateRegistry.getStateKey = () => 'usSavingsAccount';   // key resolves, but state has no such account
  const r = new UsTaxPaymentDebitReducer(services);
  const state = { people: makePeople({ residency: 'US' }) };       // no usSavingsAccount
  const next = runReducer(r, state, makeAction('US_TAX_PAYMENT_DEBIT', { amount: 500 }), DATE,
    { checkNoMutation: false });
  const oof = next.next.find(a => a.type === 'OUT_OF_FUNDS');
  assert.ok(oof, 'the whole liability is unpaid → OUT_OF_FUNDS (no crash on the missing account)');
  assert.equal(oof.deficit, 500);
  assert.equal(oof.currency, 'USD');
});

test('AuTaxPaymentDebitReducer: an unpayable AU tax reports the deficit in AUD (I8)', () => {
  const services = makeServices();
  services.stateRegistry.getStateKey = () => 'auSavingsAccount';
  const r = new AuTaxPaymentDebitReducer(services);
  const state = { people: makePeople({ residency: 'AU' }) };       // no auSavingsAccount
  const next = runReducer(r, state, makeAction('AU_TAX_PAYMENT_DEBIT', { amount: 800 }), DATE,
    { checkNoMutation: false });
  const oof = next.next.find(a => a.type === 'OUT_OF_FUNDS');
  assert.ok(oof);
  assert.equal(oof.deficit, 800);
  assert.equal(oof.currency, 'AUD', 'AU settle is denominated in AUD');
});

// ─── Taxing the funding of the tax ────────────────────────────────────────────
//
// Selling assets to raise the cash for a tax bill is itself a taxable event. The
// draw hands those accruals back as `pendingTaxActions`; the reducer must emit
// them so they reach the YTD buckets. They land in the FOLLOWING tax year — the
// sibling settle-apply reducer (PRIORITY.TAX_APPLY) already zeroed this year's
// buckets before this debit runs at TAX_APPLY + 1 — which is what keeps the
// model finite instead of circular (more tax ⇒ bigger sale ⇒ more tax).
// Regression: both debit reducers used to destructure only `crossBorderTransfers`
// and silently drop the rest, making a locally-funded bill tax-free.

test('UsTaxPaymentDebitReducer: the sale that funds the bill emits its capital gain', () => {
  const services = makeServices();
  services.stateRegistry.getStateKey = () => 'usSavingsAccount';
  const r = new UsTaxPaymentDebitReducer(services);
  const state = {
    people: makePeople({ residency: 'US' }),
    usSavingsAccount: makeAccount({ stateKey: 'usSavingsAccount', role: ACCOUNT_ROLES.US_SAVINGS,
      holdings: [{ id: 'c1', marketValue: 1_000, costBasis: 1_000 }] }),
    // 50% embedded gain, drawable (age-eligible owner is irrelevant for brokerage).
    usStockAccount: {
      ...makeAccount({ stateKey: 'usStockAccount', role: ACCOUNT_ROLES.US_STOCK,
        holdings: [{ id: 'b1', marketValue: 100_000, costBasis: 50_000 }] }),
      type: 'brokerage', drawdownPriority: 1,
    },
  };
  const next = runReducer(r, state, makeAction('US_TAX_PAYMENT_DEBIT', { amount: 11_000 }), DATE,
    { checkNoMutation: false, balance: true, nonNegative: true });

  assert.equal(next.usSavingsAccount.balance, 0, 'bill paid in full from cash + the draw');
  assert.equal(next.usStockAccount.balance, 90_000, 'drew the $10,000 shortfall');
  const gainAction = next.next.find(a => a.type === 'STOCK_WITHDRAWAL_TAX');
  assert.ok(gainAction, "the funding sale's gain must reach the tax engine");
  assert.equal(Math.round(gainAction.gain), 5_000, '50% of the $10,000 sold');
});

test('UsTaxPaymentDebitReducer: an EXHAUSTED draw still reports what it realized', () => {
  const services = makeServices();
  services.stateRegistry.getStateKey = () => 'usSavingsAccount';
  const r = new UsTaxPaymentDebitReducer(services);
  const state = {
    people: makePeople({ residency: 'US' }),
    usSavingsAccount: makeAccount({ stateKey: 'usSavingsAccount', role: ACCOUNT_ROLES.US_SAVINGS,
      holdings: [{ id: 'c1', marketValue: 1_000, costBasis: 1_000 }] }),
    usStockAccount: {
      ...makeAccount({ stateKey: 'usStockAccount', role: ACCOUNT_ROLES.US_STOCK,
        holdings: [{ id: 'b1', marketValue: 20_000, costBasis: 10_000 }] }),
      type: 'brokerage', drawdownPriority: 1,
    },
  };
  // Bill exceeds cash + the whole brokerage → replenishSavings drains it, then throws.
  const next = runReducer(r, state, makeAction('US_TAX_PAYMENT_DEBIT', { amount: 50_000 }), DATE,
    { checkNoMutation: false, balance: true, nonNegative: true });

  assert.equal(next.usStockAccount.balance, 0, 'the failed draw still liquidated everything');
  const gainAction = next.next.find(a => a.type === 'STOCK_WITHDRAWAL_TAX');
  assert.ok(gainAction, 'gains realized on the way to running dry are still taxable');
  assert.equal(Math.round(gainAction.gain), 10_000, 'the full embedded gain was realized');
  assert.ok(next.next.some(a => a.type === 'INTL_TRANSFER_APPLY'), 'residual still escalates');
});
