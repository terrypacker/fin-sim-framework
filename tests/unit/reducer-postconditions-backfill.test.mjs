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
 * Postcondition backfill for the zero-reference reducers (design 37 §8.2 / §7).
 *
 * These 11 concrete reducers had no test referencing them at all. Each is now
 * pinned for the invariants it must satisfy (I1/I3/I4/I5/I7 — see design 37 §2).
 *
 * Two reducer families behave specially and the tests document why:
 *  - SERVICE-BACKED (FX transfer, mortgages, state-tax debit) call
 *    AccountService.transaction(), which mutates accounts in place. They are NOT
 *    I1-pure, so runReducer is called with checkNoMutation:false and conservation
 *    is checked against a structuredClone snapshot taken before the call.
 *  - LEGACY SCALAR-BALANCE earnings (AuFixedIncomeEarningsApply) predate holdings
 *    (design 25) and bump account.balance without syncing holdings — see the
 *    flagged `todo` test below.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  runReducer, assertConserved,
  assertConservedFx, assertStateUnchanged, sumHoldings,
} from '../helpers/reducer-postconditions.js';
import {
  makeAccountState, makeAccount, makeAction, makeServices, makePeople,
} from '../helpers/reducer-fixtures.js';

import { AddRegimeReducer } from '../../src/finance/economic-regimes/add-regime-reducer.js';
import { RevalueAssetReducer } from '../../src/finance/economic-regimes/revalue-asset-reducer.js';
import { AssetAppreciateReducer } from '../../src/finance/handlers/asset-appreciation-handler.js';
import { FxTransferApplyReducer } from '../../src/finance/fx/fx-transfer-apply-reducer.js';
import { K401ToIraConversionApplyReducer } from '../../src/finance/account-rules/us/k401-classes.js';
import { AuFixedIncomeEarningsApplyReducer } from '../../src/finance/account-rules/au/au-fixed-income-classes.js';
import { StateIncomeClassificationReducer } from '../../src/finance/tax/state/state-income-classification.js';
import { StateTaxSettleApplyReducer, StateTaxPaymentDebitReducer } from '../../src/finance/tax/state/state-tax-settle-classes.js';
import { UsMortgagePaymentApplyReducer, AuMortgagePaymentApplyReducer } from '../../src/finance/account-rules/mortgage-payment-classes.js';
import { UsRentalIncomeApplyReducer, AuRentalIncomeApplyReducer } from '../../src/finance/account-rules/rental-income-classes.js';

const DATE = new Date('2030-06-15');

// ─── F — Economic regimes ─────────────────────────────────────────────────────

test('AddRegimeReducer: appends regime to activeRegimes (I1)', () => {
  const r = new AddRegimeReducer();
  const regime = { id: 'rg1', kind: 'recession' };
  const next = runReducer(r, { activeRegimes: [{ id: 'rg0' }] },
    makeAction('ADD_REGIME_APPLY', { regime }), DATE);
  assert.deepEqual(next.activeRegimes.map(x => x.id), ['rg0', 'rg1']);
});

test('AddRegimeReducer: missing regime is a no-op (I7)', () => {
  const r = new AddRegimeReducer();
  const prev = { activeRegimes: [{ id: 'rg0' }] };
  const next = runReducer(r, structuredClone(prev), makeAction('ADD_REGIME_APPLY', {}), DATE);
  assertStateUnchanged(prev, next);
});

test('RevalueAssetReducer: shocks holdings and re-syncs balance (I3/I4)', () => {
  const r = new RevalueAssetReducer();
  const state = makeAccountState({ stateKey: 'usStockAccount', holdings: [{ id: 'h1', marketValue: 1000, costBasis: 800 }] });
  const next = runReducer(r, state,
    makeAction('REVALUE_ASSET_APPLY', { targetStateKeys: ['usStockAccount'], multiplier: -0.4 }),
    DATE, { balance: true, nonNegative: true });
  assert.equal(next.usStockAccount.balance, 600);
  assert.equal(sumHoldings(next.usStockAccount), 600); // I3 explicit
});

test('RevalueAssetReducer: shocks scalar-value assets (RealProperty)', () => {
  const r = new RevalueAssetReducer();
  const next = runReducer(r, { house: { value: 500000 } },
    makeAction('REVALUE_ASSET_APPLY', { targetStateKeys: ['house'], multiplier: -0.2 }), DATE);
  assert.equal(next.house.value, 400000);
});

test('RevalueAssetReducer: null multiplier is a no-op (I7)', () => {
  const r = new RevalueAssetReducer();
  const prev = makeAccountState({ stateKey: 'usStockAccount', balance: 1000 });
  const next = runReducer(r, structuredClone(prev),
    makeAction('REVALUE_ASSET_APPLY', { targetStateKeys: ['usStockAccount'] }), DATE);
  assertStateUnchanged(prev, next);
});

test('RevalueAssetReducer: a +shock never drives marketValue negative is moot; a -shock clamps at 0 (I4)', () => {
  const r = new RevalueAssetReducer();
  const state = makeAccountState({ stateKey: 'usStockAccount', holdings: [{ id: 'h1', marketValue: 100, costBasis: 100 }] });
  const next = runReducer(r, state,
    makeAction('REVALUE_ASSET_APPLY', { targetStateKeys: ['usStockAccount'], multiplier: -2 }),
    DATE, { balance: true, nonNegative: true });
  assert.equal(next.usStockAccount.balance, 0);
});

// ─── J — Misc: asset appreciation ─────────────────────────────────────────────

test('AssetAppreciateReducer: grows scalar value by delta (I1)', () => {
  const r = new AssetAppreciateReducer();
  const next = runReducer(r, { house: { value: 500000 } },
    makeAction('ASSET_APPRECIATE_APPLY', { stateKey: 'house', delta: 15000 }), DATE);
  assert.equal(next.house.value, 515000);
});

test('AssetAppreciateReducer: clamps at zero (I4) and no-ops on missing entry (I7)', () => {
  const r = new AssetAppreciateReducer();
  const dropped = runReducer(r, { house: { value: 100 } },
    makeAction('ASSET_APPRECIATE_APPLY', { stateKey: 'house', delta: -500 }), DATE);
  assert.equal(dropped.house.value, 0);

  const prev = { house: { value: 100 } };
  const missing = runReducer(r, structuredClone(prev),
    makeAction('ASSET_APPRECIATE_APPLY', { stateKey: 'nope', delta: 50 }), DATE);
  assertStateUnchanged(prev, missing);
});

// ─── G — FX (service-backed; mutates in place) ────────────────────────────────

test('FxTransferApplyReducer: conserves value across currencies (I3/I5-FX)', () => {
  const services = makeServices();
  const r = new FxTransferApplyReducer(services);
  const state = makeAccountState([
    { stateKey: 'auSavingsAccount', currency: 'AUD', holdings: [{ id: 'a1', marketValue: 10000, costBasis: 10000 }] },
    { stateKey: 'checkingAccount', currency: 'USD', holdings: [{ id: 'u1', marketValue: 0, costBasis: 0 }] },
  ]);
  const prev = structuredClone(state);
  const rate = 0.65; // AUD→USD
  const next = runReducer(r, state,
    makeAction('FX_TRANSFER_APPLY', { srcKey: 'auSavingsAccount', dstKey: 'checkingAccount', fromAmount: 4000, toAmount: 2600, rate, to: 'USD' }),
    DATE, { checkNoMutation: false, balance: true, nonNegative: true });
  assert.equal(next.auSavingsAccount.balance, 6000);
  assert.equal(next.checkingAccount.balance, 2600);
  assertConservedFx(prev, next, 'auSavingsAccount', 'checkingAccount', rate);
});

test('FxTransferApplyReducer: emits OUT_OF_FUNDS when short of targetDeficit', () => {
  const services = makeServices();
  const r = new FxTransferApplyReducer(services);
  const state = makeAccountState([
    { stateKey: 'auSavingsAccount', currency: 'AUD', holdings: [{ id: 'a1', marketValue: 100, costBasis: 100 }] },
    { stateKey: 'checkingAccount', currency: 'USD', holdings: [{ id: 'u1', marketValue: 0, costBasis: 0 }] },
  ]);
  const next = r.reduce(state,
    makeAction('FX_TRANSFER_APPLY', { srcKey: 'auSavingsAccount', dstKey: 'checkingAccount', fromAmount: 100, toAmount: 65, rate: 0.65, to: 'USD', targetDeficit: 200 }),
    DATE);
  assert.ok(Array.isArray(next.next));
  assert.equal(next.next[0].type, 'OUT_OF_FUNDS');
});

// ─── C — 401k→IRA conversion (pure; immutable holdings scaling) ────────────────

test('K401ToIraConversionApplyReducer: conserves value, keeps both invariants, preserves basis', () => {
  const r = new K401ToIraConversionApplyReducer({});
  const state = {
    k401Account: { ...makeAccount({ stateKey: 'k401Account', holdings: [{ id: 'k1', marketValue: 10000, costBasis: 6000 }] }), contributionBasis: 6000, earningsBasis: 4000 },
    iraAccount: { ...makeAccount({ stateKey: 'iraAccount', holdings: [{ id: 'i1', marketValue: 5000, costBasis: 3000 }] }), contributionBasis: 3000, earningsBasis: 2000 },
  };
  const prev = structuredClone(state);
  const next = runReducer(r, state,
    makeAction('K401_TO_IRA_CONVERSION_APPLY', { amount: 4000, k401Key: 'k401Account', iraKey: 'iraAccount' }),
    DATE, { balance: true, nonNegative: true });

  assert.equal(next.k401Account.balance, 6000);
  assert.equal(next.iraAccount.balance, 9000);
  assert.equal(sumHoldings(next.k401Account), 6000); // I3
  assert.equal(sumHoldings(next.iraAccount), 9000);  // I3
  // I5: money conserved (no cash pool, no tax).
  assertConserved(prev, next, 'k401Account', 'iraAccount');
  // Basis moves contribution-first.
  assert.equal(next.k401Account.contributionBasis, 2000);
  assert.equal(next.iraAccount.contributionBasis, 7000);
});

// ─── I — State tax ────────────────────────────────────────────────────────────

test('StateIncomeClassificationReducer: folds wages into ordinary YTD when state-resident (I1)', () => {
  const r = new StateIncomeClassificationReducer('WAGES_INCOME_TAX');
  const state = { people: makePeople({ residency: 'US', residencyState: 'NE' }), stateOrdinaryIncomeYTD: 1000 };
  const next = r.reduce(state, makeAction('WAGES_INCOME_TAX', { amount: 5000, residency: 'US' }));
  assert.equal(next.stateOrdinaryIncomeYTD, 6000);
  assert.equal(state.stateOrdinaryIncomeYTD, 1000, 'I1: input not mutated');
});

test('StateIncomeClassificationReducer: no-op when no state configured / non-US residency (I7)', () => {
  const r = new StateIncomeClassificationReducer('WAGES_INCOME_TAX');
  // no residencyState
  const s1 = { people: makePeople({ residency: 'US', residencyState: null }), stateOrdinaryIncomeYTD: 0 };
  assert.equal(r.reduce(s1, makeAction('WAGES_INCOME_TAX', { amount: 5000 })), s1);
  // AU residency income
  const s2 = { people: makePeople({ residency: 'US', residencyState: 'NE' }), stateOrdinaryIncomeYTD: 0 };
  assert.equal(r.reduce(s2, makeAction('WAGES_INCOME_TAX', { amount: 5000, residency: 'AU' })), s2);
});

test('StateTaxSettleApplyReducer: resets YTD fields; chains debit when tax>0 (I1)', () => {
  const r = new StateTaxSettleApplyReducer();
  const state = { stateOrdinaryIncomeYTD: 5000, statePensionIncomeYTD: 1000, stateSsIncomeYTD: 2000, stateCapitalGainsYTD: 500 };
  const next = r.reduce(state, makeAction('STATE_TAX_SETTLE_APPLY', { tax: 320 }));
  for (const f of ['stateOrdinaryIncomeYTD', 'statePensionIncomeYTD', 'stateSsIncomeYTD', 'stateCapitalGainsYTD']) {
    assert.equal(next[f], 0, `${f} reset`);
  }
  assert.equal(next.next[0].type, 'STATE_TAX_PAYMENT_DEBIT');
  assert.equal(next.next[0].amount, 320);
  assert.equal(state.stateOrdinaryIncomeYTD, 5000, 'I1: input not mutated');
});

test('StateTaxSettleApplyReducer: no debit chained when tax==0', () => {
  const r = new StateTaxSettleApplyReducer();
  const next = r.reduce({ stateOrdinaryIncomeYTD: 5000 }, makeAction('STATE_TAX_SETTLE_APPLY', { tax: 0 }));
  assert.equal(next.next.length, 0);
});

test('StateTaxPaymentDebitReducer: debits US savings, keeps §4.4 (I3) — service-backed', () => {
  // getStateKey resolves the US_SAVINGS role to our test account key.
  const services = makeServices();
  services.stateRegistry.getStateKey = () => 'usSavingsAccount';
  const r = new StateTaxPaymentDebitReducer(services);
  const state = makeAccountState({ stateKey: 'usSavingsAccount', holdings: [{ id: 's1', marketValue: 10000, costBasis: 10000 }] });
  const prev = structuredClone(state);
  const next = runReducer(r, state, makeAction('STATE_TAX_PAYMENT_DEBIT', { amount: 320 }), DATE,
    { checkNoMutation: false, balance: true, nonNegative: true });
  assert.equal(next.usSavingsAccount.balance, 9680);
  assert.equal(prev.usSavingsAccount.balance - next.usSavingsAccount.balance, 320, 'debited exactly the tax');
});

test('StateTaxPaymentDebitReducer: short balance escalates the residual cross-border', () => {
  const services = makeServices();
  services.stateRegistry.getStateKey = () => 'usSavingsAccount';
  const r = new StateTaxPaymentDebitReducer(services);
  const state = {
    people: makePeople({ residency: 'US' }),
    usSavingsAccount: makeAccount({ stateKey: 'usSavingsAccount', holdings: [{ id: 's1', marketValue: 100, costBasis: 100 }] }),
  };
  const next = runReducer(r, state, makeAction('STATE_TAX_PAYMENT_DEBIT', { amount: 320 }), DATE,
    { checkNoMutation: false, balance: true, nonNegative: true });
  assert.equal(next.usSavingsAccount.balance, 0, 'capped to available — never negative');
  // Residual escalates rather than being silently absorbed (the historical gap):
  // pull AU investments into this US tax account, then re-debit.
  const xfer = next.next.find(a => a.type === 'INTL_TRANSFER_APPLY');
  assert.ok(xfer, 'a residual state-tax bill escalates to a cross-border transfer');
  assert.equal(xfer.direction, 'AU_TO_US');
  assert.equal(xfer.dstKey, 'usSavingsAccount');
  assert.equal(Math.round(xfer.targetDeficit), 220);
  const redebit = next.next.find(a => a.type === 'STATE_TAX_PAYMENT_DEBIT' && a.escalated);
  assert.ok(redebit, 'a follow-up escalated debit pays the topped-up balance');
});

test('StateTaxPaymentDebitReducer: no US cash account is fully OUT_OF_FUNDS (no crash)', () => {
  const services = makeServices();
  services.stateRegistry.getStateKey = () => 'usSavingsAccount';   // key resolves, but state has no such account
  const r = new StateTaxPaymentDebitReducer(services);
  const next = runReducer(r, { people: makePeople({ residency: 'US' }) },
    makeAction('STATE_TAX_PAYMENT_DEBIT', { amount: 500 }), DATE, { checkNoMutation: false });
  const oof = next.next.find(a => a.type === 'OUT_OF_FUNDS');
  assert.ok(oof, 'the whole liability is unpaid → OUT_OF_FUNDS');
  assert.equal(oof.deficit, 500);
  assert.equal(oof.currency, 'USD');
});

// ─── J — Mortgages (service-backed; cash debit == liability reduction) ─────────

for (const [label, Reducer, type] of [
  ['UsMortgagePaymentApplyReducer', UsMortgagePaymentApplyReducer, 'US_MORTGAGE_PAYMENT_APPLY'],
  ['AuMortgagePaymentApplyReducer', AuMortgagePaymentApplyReducer, 'AU_MORTGAGE_PAYMENT_APPLY'],
]) {
  test(`${label}: debits cash and reduces mortgageBalance by the same amount (I3/I5)`, () => {
    const services = makeServices();
    const r = new Reducer(services);
    const state = {
      house: { mortgageBalance: 200000 },
      cash: makeAccount({ stateKey: 'cash', holdings: [{ id: 'c1', marketValue: 8000, costBasis: 8000 }] }),
    };
    const prev = structuredClone(state);
    const next = runReducer(r, state, makeAction(type, { stateKey: 'house', cashKey: 'cash', payment: 2000 }),
      DATE, { checkNoMutation: false, balance: true, nonNegative: true });
    assert.equal(next.cash.balance, 6000);
    assert.equal(next.house.mortgageBalance, 198000);
    // I5 analog: cash debited == mortgage liability reduced.
    const cashDebit = prev.cash.balance - next.cash.balance;
    const liabDrop = prev.house.mortgageBalance - next.house.mortgageBalance;
    assert.equal(cashDebit, liabDrop, 'cash debit must equal mortgage reduction');
  });

  test(`${label}: payment capped to available cash, mortgage drops only by what was paid (I4)`, () => {
    const services = makeServices();
    const r = new Reducer(services);
    const state = {
      house: { mortgageBalance: 200000 },
      cash: makeAccount({ stateKey: 'cash', holdings: [{ id: 'c1', marketValue: 500, costBasis: 500 }] }),
    };
    const next = runReducer(r, state, makeAction(type, { stateKey: 'house', cashKey: 'cash', payment: 2000 }),
      DATE, { checkNoMutation: false, balance: true, nonNegative: true });
    assert.equal(next.cash.balance, 0);
    assert.equal(next.house.mortgageBalance, 199500); // only 500 actually paid
  });
}

// ─── K — Rental income (design 48; service-backed cash credit) ────────────────

for (const [label, Reducer, type] of [
  ['UsRentalIncomeApplyReducer', UsRentalIncomeApplyReducer, 'US_RENTAL_INCOME_APPLY'],
  ['AuRentalIncomeApplyReducer', AuRentalIncomeApplyReducer, 'AU_RENTAL_INCOME_APPLY'],
]) {
  test(`${label}: credits net cash, accrues depreciation, chains _TAX with the taxable net`, () => {
    const services = makeServices();
    const r = new Reducer(services);
    const state = {
      house: { value: 1_000_000, accumulatedDepreciation: 500 },
      cash: makeAccount({ stateKey: 'cash', holdings: [{ id: 'c1', marketValue: 8000, costBasis: 8000 }] }),
    };
    const prev = structuredClone(state);
    const next = runReducer(r, state,
      makeAction(type, { stateKey: 'house', netCash: 2025, taxableRental: 1025, monthlyDepreciation: 1000, cashKey: 'cash', residency: 'US' }),
      DATE, { checkNoMutation: false, balance: true, nonNegative: true });
    assert.equal(next.cash.balance, 10025, 'cash credited by netCash');
    assert.equal(next.cash.balance - prev.cash.balance, 2025, 'credit == netCash');
    assert.equal(next.house.accumulatedDepreciation, 1500, 'depreciation accrued');
    assert.equal(next.next[0].type, `${type.replace('_APPLY', '_TAX')}`);
    assert.equal(next.next[0].amount, 1025, 'chained taxable net');
  });

  test(`${label}: a taxable loss (negative net) is chained through unclamped`, () => {
    const services = makeServices();
    const r = new Reducer(services);
    const state = {
      house: { value: 1_000_000, accumulatedDepreciation: 0 },
      cash: makeAccount({ stateKey: 'cash', holdings: [{ id: 'c1', marketValue: 8000, costBasis: 8000 }] }),
    };
    const next = runReducer(r, state,
      makeAction(type, { stateKey: 'house', netCash: 750, taxableRental: -2750, monthlyDepreciation: 1000, cashKey: 'cash', residency: 'US' }),
      DATE, { checkNoMutation: false, balance: true, nonNegative: true });
    assert.equal(next.cash.balance, 8750, 'cash still credited by positive netCash');
    assert.equal(next.next[0].amount, -2750, 'taxable loss passes through negative');
  });
}

// ─── Earnings reducers: scalar-balance contract (event-level §4.4 lives elsewhere) ──
//
// The *_EARNINGS_APPLY reducer is intentionally responsible ONLY for the scalar
// account.balance (+ earningsBasis). Holdings are synced by the paired
// HOLDING_TRANSACT the active handler emits in the same batch, so §4.4 is an
// EVENT-level invariant — pinned in earnings-holdings-sync.test.mjs (design 37
// §2 I3, §7.2). Here we only pin the reducer's local scalar contract + I1.

test('AuFixedIncomeEarningsApplyReducer: increments scalar balance and chains tax (I1)', () => {
  const r = new AuFixedIncomeEarningsApplyReducer({});
  const state = { auFixedIncomeAccount: { balance: 10000 } };
  const next = r.reduce(state, makeAction('AU_FIXED_INCOME_EARNINGS_APPLY', { amount: 500, residency: 'AU' }));
  assert.equal(next.auFixedIncomeAccount.balance, 10500);
  assert.equal(next.next[0].type, 'AU_FIXED_INCOME_EARNINGS_TAX');
  assert.equal(state.auFixedIncomeAccount.balance, 10000, 'I1: input not mutated (pure)');
});
