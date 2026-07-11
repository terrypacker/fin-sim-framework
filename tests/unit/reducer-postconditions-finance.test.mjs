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
 * Group D — top-level finance reducer postconditions (design 37 §6 D).
 *
 * Pins the local invariants for the `src/finance/reducers/**` family in
 * isolation (no ScenarioCompiler). Two behavioral classes appear here:
 *
 *  - PURE state/people reducers (ChangeResidency, ChangeStateResidency,
 *    AccountRetitle, PersonDied, SocialSecuritySurvivor, ScenarioComplete,
 *    InflationAdjust) — I1-pure; asserted with the default runReducer
 *    no-mutation check + I2 determinism / I7 no-op / I10 idempotency as tagged.
 *  - SERVICE-BACKED cash movers (ExpenseDebit, ReplenishSavings, IntlTransfer,
 *    StockDividendCash, UsSavingsInterestCredit) call AccountService.transaction()
 *    / replenishSavings(), which mutate accounts in place. They are NOT I1-pure
 *    (design 37 §7.3) ⇒ runReducer(..., { checkNoMutation: false }); conservation
 *    is checked against a structuredClone snapshot taken before the call.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  runReducer, assertConserved, assertConservedFx, assertStateUnchanged, sumHoldings,
} from '../helpers/reducer-postconditions.js';
import {
  makeAccountState, makeAccount, makeAction, makeServices, makePeople,
} from '../helpers/reducer-fixtures.js';

import { ExpenseDebitReducer } from '../../src/finance/reducers/expense-debit-reducer.js';
import { ReplenishSavingsReducer } from '../../src/finance/reducers/replenish-savings-reducer.js';
import { UsSavingsInterestCreditReducer } from '../../src/finance/reducers/us-savings-interest-credit-reducer.js';
import { StockDividendCashApplyReducer } from '../../src/finance/reducers/stock-dividend-cash-apply-reducer.js';
import { IntlTransferApplyReducer } from '../../src/finance/reducers/intl-transfer-apply-reducer.js';
import { InflationAdjustReducer } from '../../src/finance/reducers/inflation-adjust-reducer.js';
import { ChangeResidencyApplyReducer } from '../../src/finance/reducers/change-residency-apply-reducer.js';
import { ChangeStateResidencyApplyReducer } from '../../src/finance/reducers/change-state-residency-apply-reducer.js';
import { AccountRetitleApplyReducer } from '../../src/finance/reducers/account-retitle-apply-reducer.js';
import { PersonDiedApplyReducer } from '../../src/finance/reducers/person-died-apply-reducer.js';
import { SocialSecuritySurvivorApplyReducer } from '../../src/finance/reducers/social-security-survivor-apply-reducer.js';
import { ScenarioCompleteReducer } from '../../src/finance/reducers/scenario-complete-reducer.js';

const DATE = new Date('2030-06-15');

// ─── ExpenseDebitReducer (service-backed; I1 skipped — §7.3) ───────────────────

test('ExpenseDebitReducer: debits the targetKey account, keeps §4.4 (I3/I4)', () => {
  const services = makeServices();
  const r = new ExpenseDebitReducer(services);
  const state = {
    people: makePeople({ residency: 'US' }),
    usSavingsAccount: makeAccount({ stateKey: 'usSavingsAccount', holdings: [{ id: 's1', marketValue: 5000, costBasis: 5000 }] }),
  };
  const prev = structuredClone(state);
  const next = runReducer(r, state, makeAction('EXPENSE_DEBIT', { targetKey: 'usSavingsAccount', amount: 2000 }),
    DATE, { checkNoMutation: false, balance: true, nonNegative: true });
  assert.equal(next.usSavingsAccount.balance, 3000);
  assert.equal(sumHoldings(next.usSavingsAccount), 3000); // I3 explicit
  assert.equal(prev.usSavingsAccount.balance - next.usSavingsAccount.balance, 2000);
});

test('ExpenseDebitReducer: debit capped to available balance — never negative (I4)', () => {
  const services = makeServices();
  const r = new ExpenseDebitReducer(services);
  const state = {
    people: makePeople({ residency: 'US' }),
    usSavingsAccount: makeAccount({ stateKey: 'usSavingsAccount', holdings: [{ id: 's1', marketValue: 100, costBasis: 100 }] }),
  };
  const next = runReducer(r, state, makeAction('EXPENSE_DEBIT', { targetKey: 'usSavingsAccount', amount: 500 }),
    DATE, { checkNoMutation: false, balance: true, nonNegative: true });
  assert.equal(next.usSavingsAccount.balance, 0); // only 100 was available
});

test('ExpenseDebitReducer: falls back to AU savings key for an AU resident', () => {
  const services = makeServices();
  const r = new ExpenseDebitReducer(services);
  const state = {
    people: makePeople({ residency: 'AU' }),
    auSavingsAccount: makeAccount({ stateKey: 'auSavingsAccount', currency: 'AUD', holdings: [{ id: 'a1', marketValue: 3000, costBasis: 3000 }] }),
  };
  const next = runReducer(r, state, makeAction('EXPENSE_DEBIT', { amount: 1000 }), // no targetKey → fallback
    DATE, { checkNoMutation: false, balance: true, nonNegative: true });
  assert.equal(next.auSavingsAccount.balance, 2000);
});

// ─── ReplenishSavingsReducer (service-backed; I1 skipped) ──────────────────────

test('ReplenishSavingsReducer: draws from a domestic source to cover the deficit (I3/I5)', () => {
  const services = makeServices();
  const r = new ReplenishSavingsReducer(services);
  const state = {
    people: makePeople({ residency: 'US' }),
    usSavingsAccount: { ...makeAccount({ stateKey: 'usSavingsAccount', holdings: [{ id: 's1', marketValue: 0, costBasis: 0 }] }), drawdownPriority: null },
    usBrokerage: { ...makeAccount({ stateKey: 'usBrokerage', holdings: [{ id: 'b1', marketValue: 1000, costBasis: 1000 }] }), drawdownPriority: 1 },
  };
  const prev = structuredClone(state);
  const next = runReducer(r, state, makeAction('REPLENISH_SAVINGS', { targetKey: 'usSavingsAccount', deficit: 500 }),
    DATE, { checkNoMutation: false, balance: true, nonNegative: true });
  assert.equal(next.usSavingsAccount.balance, 500);
  assert.equal(next.usBrokerage.balance, 500);
  // I5 — same-currency draw conserves: target credited == source debited.
  assertConserved(prev, next, 'usBrokerage', 'usSavingsAccount');
  // Drawn key recorded for the journal RECORD_BALANCE replay.
  assert.ok(next.next.some(a => a.type === 'RECORD_BALANCE'));
});

test('ReplenishSavingsReducer: domestic exhaustion chains INTL_TRANSFER_APPLY (I7)', () => {
  const services = makeServices();
  const r = new ReplenishSavingsReducer(services);
  const state = {
    people: makePeople({ residency: 'US' }),
    usSavingsAccount: { ...makeAccount({ stateKey: 'usSavingsAccount', holdings: [{ id: 's1', marketValue: 0, costBasis: 0 }] }), drawdownPriority: null },
    usBrokerage: { ...makeAccount({ stateKey: 'usBrokerage', holdings: [{ id: 'b1', marketValue: 100, costBasis: 100 }] }), drawdownPriority: 1 },
  };
  const next = runReducer(r, state, makeAction('REPLENISH_SAVINGS', { targetKey: 'usSavingsAccount', deficit: 5000 }),
    DATE, { checkNoMutation: false, balance: true, nonNegative: true });
  const intl = next.next.find(a => a.type === 'INTL_TRANSFER_APPLY');
  assert.ok(intl, 'chained INTL_TRANSFER_APPLY on domestic exhaustion');
  assert.equal(intl.direction, 'AU_TO_US');
  assert.ok(intl.targetDeficit > 0);
});

// ─── IntlTransferApplyReducer (service-backed; FX) ─────────────────────────────

test('IntlTransferApplyReducer: AU→US transfer conserves value across currencies (I3/I5-FX)', () => {
  const services = makeServices();
  const r = new IntlTransferApplyReducer(services);
  const state = {
    effectiveExchangeRates: { USD_AUD: 1.55 },
    effectiveFxFees: { USD_AUD: 15 },
    usSavingsAccount: makeAccount({ stateKey: 'usSavingsAccount', holdings: [{ id: 'u1', marketValue: 0, costBasis: 0 }] }),
    auSavingsAccount: makeAccount({ stateKey: 'auSavingsAccount', currency: 'AUD', holdings: [{ id: 'a1', marketValue: 20000, costBasis: 20000 }] }),
  };
  const prev = structuredClone(state);
  const next = runReducer(r, state, makeAction('INTL_TRANSFER_APPLY', { direction: 'AU_TO_US', targetDeficit: 10000 }),
    DATE, { checkNoMutation: false, balance: true, nonNegative: true });
  // targetDeficit netted exactly at the US side; AU debited (deficit+fee)·rate.
  assert.equal(next.usSavingsAccount.balance, 10000);
  assert.equal(+next.auSavingsAccount.balance.toFixed(2), 20000 - (10000 + 15) * 1.55);
  // I5(FX): |Δsrc(AUD)|·(AUD→USD rate) ≈ |Δdst(USD)| (fee is the only leakage).
  assertConservedFx(prev, next, 'auSavingsAccount', 'usSavingsAccount', 1 / 1.55);
});

test('IntlTransferApplyReducer: short source proceeds partial then chains OUT_OF_FUNDS', () => {
  const services = makeServices();
  const r = new IntlTransferApplyReducer(services);
  const state = {
    people: makePeople({ residency: 'AU' }),
    effectiveExchangeRates: { USD_AUD: 1.55 },
    effectiveFxFees: { USD_AUD: 15 },
    usSavingsAccount: makeAccount({ stateKey: 'usSavingsAccount', holdings: [{ id: 'u1', marketValue: 0, costBasis: 0 }] }),
    auSavingsAccount: makeAccount({ stateKey: 'auSavingsAccount', currency: 'AUD', holdings: [{ id: 'a1', marketValue: 200, costBasis: 200 }] }),
  };
  const next = runReducer(r, state, makeAction('INTL_TRANSFER_APPLY', { direction: 'AU_TO_US', targetDeficit: 10000 }),
    DATE, { checkNoMutation: false, balance: true, nonNegative: true });
  const oof = next.next.find(a => a.type === 'OUT_OF_FUNDS');
  assert.ok(oof, 'chained OUT_OF_FUNDS for the uncovered remainder');
  assert.equal(oof.currency, 'USD');
  assert.ok(oof.deficit > 0);
});

// ─── StockDividendCashApplyReducer (service-backed; cash credit) ───────────────

test('StockDividendCashApplyReducer: credits savings and chains STOCK_DIVIDEND_TAX (I3)', () => {
  const services = makeServices();
  services.stateRegistry.getStateKey = () => 'usSavingsAccount';
  const r = new StockDividendCashApplyReducer(services);
  const state = makeAccountState({ stateKey: 'usSavingsAccount', holdings: [{ id: 's1', marketValue: 1000, costBasis: 1000 }] });
  const next = runReducer(r, state, makeAction('STOCK_DIVIDEND_CASH_APPLY', { amount: 250, residency: 'US' }),
    DATE, { checkNoMutation: false, balance: true, nonNegative: true });
  assert.equal(next.usSavingsAccount.balance, 1250);
  assert.equal(sumHoldings(next.usSavingsAccount), 1250); // I3
  const tax = next.next.find(a => a.type === 'STOCK_DIVIDEND_TAX');
  assert.equal(tax.amount, 250);
  assert.equal(tax.residency, 'US');
});

// ─── UsSavingsInterestCreditReducer (service-backed; cash credit + income YTD) ─

test('UsSavingsInterestCreditReducer: credits savings, bumps usOrdinaryIncomeYTD (I3)', () => {
  const services = makeServices();
  services.stateRegistry.getStateKey = () => 'usSavingsAccount';
  const r = new UsSavingsInterestCreditReducer(services);
  const state = {
    people: makePeople({ residency: 'US' }),
    usOrdinaryIncomeYTD: 1000,
    usSavingsAccount: makeAccount({ stateKey: 'usSavingsAccount', holdings: [{ id: 's1', marketValue: 5000, costBasis: 5000 }] }),
  };
  const next = runReducer(r, state, makeAction('US_SAVINGS_INTEREST_CREDIT', { amount: 200 }),
    DATE, { checkNoMutation: false, balance: true, nonNegative: true });
  assert.equal(next.usSavingsAccount.balance, 5200);
  assert.equal(next.usOrdinaryIncomeYTD, 1200);
  assert.equal(next.auOrdinaryIncomeYTD, undefined, 'US resident: no AU classification');
});

test('UsSavingsInterestCreditReducer: AU resident also accrues auOrdinaryIncomeYTD + usSourceOrdinaryUsdYTD', () => {
  const services = makeServices();
  services.stateRegistry.getStateKey = () => 'usSavingsAccount';
  const r = new UsSavingsInterestCreditReducer(services);
  const state = {
    people: makePeople({ residency: 'AU' }),
    usOrdinaryIncomeYTD: 0, auOrdinaryIncomeYTD: 0, usSourceOrdinaryUsdYTD: 0,
    usSavingsAccount: makeAccount({ stateKey: 'usSavingsAccount', holdings: [{ id: 's1', marketValue: 5000, costBasis: 5000 }] }),
  };
  const next = runReducer(r, state, makeAction('US_SAVINGS_INTEREST_CREDIT', { amount: 200 }),
    DATE, { checkNoMutation: false, balance: true, nonNegative: true });
  assert.equal(next.usOrdinaryIncomeYTD, 200);
  assert.equal(next.auOrdinaryIncomeYTD, 200);
  assert.equal(next.usSourceOrdinaryUsdYTD, 200);
});

// ─── InflationAdjustReducer (pure; I1/I2) ──────────────────────────────────────

test('InflationAdjustReducer: inflates wages/SS/expenses and accumulator on US advance (I1)', () => {
  const r = new InflationAdjustReducer();
  const state = {
    inflationRates: { US: 0.03 },
    people: { p1: { residency: 'US', monthlyWage: 1000, socialSecurityMonthly: 500 } },
    monthlyExpenses: 4000,
  };
  const next = runReducer(r, state, makeAction('US_PERIOD_ADVANCE'), DATE, {});
  assert.equal(next.inflationAccumulator.US, 1.03);
  assert.equal(next.people.p1.monthlyWage, 1030);
  assert.equal(next.people.p1.socialSecurityMonthly, 515);
  assert.equal(next.monthlyExpenses, 4120);
});

test('InflationAdjustReducer: zero rate is a no-op (I7); deterministic (I2)', () => {
  const r = new InflationAdjustReducer();
  const prev = { inflationRates: { US: 0 }, people: { p1: { residency: 'US', monthlyWage: 1000 } }, monthlyExpenses: 4000 };
  const noop = runReducer(r, structuredClone(prev), makeAction('US_PERIOD_ADVANCE'), DATE, {});
  assertStateUnchanged(prev, noop);

  // I2 — same (state, action) → deep-equal output on repeat.
  const base = { inflationRates: { US: 0.03 }, people: { p1: { residency: 'US', monthlyWage: 1000 } }, monthlyExpenses: 4000 };
  const a = r.reduce(structuredClone(base), makeAction('US_PERIOD_ADVANCE'), DATE);
  const b = r.reduce(structuredClone(base), makeAction('US_PERIOD_ADVANCE'), DATE);
  assert.deepEqual(a, b);
});

// ─── ChangeResidencyApplyReducer (pure on people; I1/I7) ───────────────────────

test('ChangeResidencyApplyReducer: flips every person to AU, leaves citizenship (I1)', () => {
  const services = { accountService: makeServices().accountService, stateRegistry: { getAccounts: () => [] } };
  const r = new ChangeResidencyApplyReducer(services);
  const state = { people: { p1: { residency: 'US', citizenships: ['US'] }, p2: { residency: 'US', citizenships: ['US'] } } };
  const next = runReducer(r, state, makeAction('CHANGE_RESIDENCY_APPLY'), DATE, {});
  assert.equal(next.people.p1.residency, 'AU');
  assert.equal(next.people.p2.residency, 'AU');
  assert.deepEqual(next.people.p1.citizenships, ['US'], 'citizenship untouched');
});

test('ChangeResidencyApplyReducer: empty people is a no-op (I7)', () => {
  const services = { accountService: makeServices().accountService, stateRegistry: { getAccounts: () => [] } };
  const r = new ChangeResidencyApplyReducer(services);
  const prev = { people: {} };
  const next = runReducer(r, structuredClone(prev), makeAction('CHANGE_RESIDENCY_APPLY'), DATE, {});
  assertStateUnchanged(prev, next);
});

// ─── ChangeStateResidencyApplyReducer (pure; I1/I7) ────────────────────────────

test('ChangeStateResidencyApplyReducer: sets residencyState on all people, keeps country (I1)', () => {
  const r = new ChangeStateResidencyApplyReducer();
  const state = { people: { p1: { residency: 'US', residencyState: 'NE' }, p2: { residency: 'US', residencyState: 'NE' } } };
  const next = runReducer(r, state, makeAction('CHANGE_STATE_RESIDENCY_APPLY', { destination: 'CA' }), DATE, {});
  assert.equal(next.people.p1.residencyState, 'CA');
  assert.equal(next.people.p2.residencyState, 'CA');
  assert.equal(next.people.p1.residency, 'US', 'country residency untouched');
});

test('ChangeStateResidencyApplyReducer: empty people is a no-op (I7)', () => {
  const r = new ChangeStateResidencyApplyReducer();
  const prev = { people: {} };
  const next = runReducer(r, structuredClone(prev), makeAction('CHANGE_STATE_RESIDENCY_APPLY', { destination: 'CA' }), DATE, {});
  assertStateUnchanged(prev, next);
});

// ─── AccountRetitleApplyReducer (pure; I1/I7) ──────────────────────────────────

test('AccountRetitleApplyReducer: retitles solo-owned accounts deceased→survivor (I1)', () => {
  const r = new AccountRetitleApplyReducer();
  const state = {
    iraAccount: { ...makeAccount({ stateKey: 'iraAccount' }), ownerId: 'p1' },
    jointAccount: { ...makeAccount({ stateKey: 'jointAccount' }), ownerId: null },
    spouseAccount: { ...makeAccount({ stateKey: 'spouseAccount' }), ownerId: 'p2' },
  };
  const next = runReducer(r, state, makeAction('ACCOUNT_RETITLE_APPLY', { deceasedId: 'p1', survivorId: 'p2' }), DATE, {});
  assert.equal(next.iraAccount.ownerId, 'p2', 'deceased solo account retitled');
  assert.equal(next.jointAccount.ownerId, null, 'joint untouched');
  assert.equal(next.spouseAccount.ownerId, 'p2', 'survivor account untouched');
});

test('AccountRetitleApplyReducer: no matching owner is a no-op (I7)', () => {
  const r = new AccountRetitleApplyReducer();
  const prev = { iraAccount: { ...makeAccount({ stateKey: 'iraAccount' }), ownerId: 'p3' } };
  const next = runReducer(r, structuredClone(prev), makeAction('ACCOUNT_RETITLE_APPLY', { deceasedId: 'p1', survivorId: 'p2' }), DATE, {});
  assertStateUnchanged(prev, next);
});

// ─── PersonDiedApplyReducer (pure; I1/I7) ──────────────────────────────────────

test('PersonDiedApplyReducer: records death and removes person from people (I1)', () => {
  const r = new PersonDiedApplyReducer();
  const state = { people: { p1: { residency: 'US' }, p2: { residency: 'US' } }, deceased: {} };
  const next = runReducer(r, state, makeAction('PERSON_DIED_APPLY', { personId: 'p1', date: DATE, taxJurisdiction: 'US' }), DATE, {});
  assert.equal(next.people.p1, undefined, 'deceased removed');
  assert.ok(next.people.p2, 'survivor remains');
  assert.deepEqual(next.deceased.p1, { date: DATE, taxJurisdiction: 'US' });
});

test('PersonDiedApplyReducer: absent person does not throw, people map unchanged (I7)', () => {
  const r = new PersonDiedApplyReducer();
  const state = { people: { p2: { residency: 'US' } } };
  const next = runReducer(r, state, makeAction('PERSON_DIED_APPLY', { personId: 'p1', date: DATE, taxJurisdiction: 'US' }), DATE, {});
  assert.deepEqual(Object.keys(next.people), ['p2']);
});

// ─── SocialSecuritySurvivorApplyReducer (pure; I1/I7) ──────────────────────────

test('SocialSecuritySurvivorApplyReducer: survivor SS = max(own, deceased) (I1)', () => {
  const r = new SocialSecuritySurvivorApplyReducer();
  const state = { people: { p2: { socialSecurityMonthly: 1000 } } };
  const next = runReducer(r, state, makeAction('SOCIAL_SECURITY_SURVIVOR_APPLY', { survivorId: 'p2', deceasedSocialSecurityMonthly: 1500 }), DATE, {});
  assert.equal(next.people.p2.socialSecurityMonthly, 1500, 'stepped up to the larger benefit');
});

test('SocialSecuritySurvivorApplyReducer: keeps own when larger; absent survivor is a no-op (I7)', () => {
  const r = new SocialSecuritySurvivorApplyReducer();
  const kept = runReducer(r, { people: { p2: { socialSecurityMonthly: 2000 } } },
    makeAction('SOCIAL_SECURITY_SURVIVOR_APPLY', { survivorId: 'p2', deceasedSocialSecurityMonthly: 1500 }), DATE, {});
  assert.equal(kept.people.p2.socialSecurityMonthly, 2000);

  const prev = { people: { p2: { socialSecurityMonthly: 2000 } } };
  const missing = runReducer(r, structuredClone(prev),
    makeAction('SOCIAL_SECURITY_SURVIVOR_APPLY', { survivorId: 'pX', deceasedSocialSecurityMonthly: 9999 }), DATE, {});
  assertStateUnchanged(prev, missing);
});

// ─── ScenarioCompleteReducer (pure; I7/I10) ────────────────────────────────────

test('ScenarioCompleteReducer: sets scenarioComplete when people is empty', () => {
  const r = new ScenarioCompleteReducer();
  const next = runReducer(r, { people: {} }, makeAction('SCENARIO_COMPLETE_CHECK'), DATE, {});
  assert.equal(next.scenarioComplete, true);
});

test('ScenarioCompleteReducer: living person is a no-op (I7); idempotent re-apply (I10)', () => {
  const r = new ScenarioCompleteReducer();
  const prev = { people: { p1: { residency: 'US' } } };
  const noop = runReducer(r, structuredClone(prev), makeAction('SCENARIO_COMPLETE_CHECK'), DATE, {});
  assertStateUnchanged(prev, noop);

  // I10 — re-applying once already complete keeps the latch true.
  const once = r.reduce({ people: {} }, makeAction('SCENARIO_COMPLETE_CHECK'), DATE);
  const twice = r.reduce(once, makeAction('SCENARIO_COMPLETE_CHECK'), DATE);
  assert.equal(twice.scenarioComplete, true);
});
