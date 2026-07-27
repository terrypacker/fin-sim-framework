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
 * Design 84 G12 — a losing year must be APPLIED, not discarded.
 *
 * Every handler in earnings-handlers.js used to end `call()` with
 * `if (amount <= 0) return [RecordBalance]`. computeHoldingsGrowth computed the
 * negative correctly and returned the paired holding actions; the guard threw all of
 * it away, so a down year did not reduce the balance and did not reduce the holdings.
 *
 * It hid because dated shocks travel REVALUE_ASSET_APPLY, a different path that works.
 * Stochastic return paths (design 74) drive the *effective rate* negative instead, so
 * under `--paths` every wrapper booked its up years and skipped its down years —
 * removing exactly the sequence-of-returns risk such a run exists to measure.
 *
 * The first test below is the bug in its original shape. The rest pin the two
 * families apart: appreciation is two-sided, receipts are not.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  IntlRothEarningsHandler,
  IntlIraEarningsHandler,
  IntlK401EarningsHandler,
  IntlUsStockEarningsHandler,
  IntlAuStockEarningsHandler,
  IntlAuStockDividendHandler,
  AuSavingsInterestHandler,
  FixedIncomeInterestHandler,
  SuperEarningsHandler,
} from '../../src/finance/handlers/earnings-handlers.js';
import { debitLedgerForLoss } from '../../src/finance/assets/investment-account.js';
import { HoldingTransactReducer } from '../../src/finance/holdings/holding-reducers.js';
import { RothEarningsApplyReducer } from '../../src/finance/account-rules/us/roth-classes.js';
import { IraEarningsApplyReducer } from '../../src/finance/account-rules/us/ira-classes.js';
import { K401EarningsApplyReducer } from '../../src/finance/account-rules/us/k401-classes.js';
import { StockEarningsApplyReducer } from '../../src/finance/account-rules/us/us-brokerage-classes.js';
import { AuStockEarningsApplyReducer } from '../../src/finance/account-rules/au/au-brokerage-classes.js';
import { SuperEarningsApplyReducer } from '../../src/finance/account-rules/au/au-super-classes.js';
import { makeAccount } from '../helpers/reducer-fixtures.js';
import { sumHoldings } from '../helpers/reducer-postconditions.js';

const registryFor = (key) => ({ getStateKey: () => key });

/** One account, one equity sleeve, a ledger split 20% corpus / 80% earnings. */
function stateWith(stateKey, { balance = 1_000_000, contributionBasis = 200_000, earningsBasis = 800_000, rate } = {}) {
  const account = makeAccount({
    stateKey, balance,
    holdings: [{ marketValue: balance, costBasis: contributionBasis }],
  });
  return {
    effectiveGrowthRates:   {},
    effectiveInterestRates: {},
    people: {},
    [stateKey]: { ...account, contributionBasis, earningsBasis },
    _rate: rate,
  };
}

/** Drive the real two-step path: handler → *_EARNINGS_APPLY reducer → HOLDING_TRANSACT. */
function runYear(handler, reducer, state, stateKey) {
  const actions = handler.call({ state, data: {}, date: new Date('2040-06-30') });
  const apply   = actions.find(a => typeof a.type === 'string' && a.type.endsWith('_EARNINGS_APPLY'));
  let next = state;
  if (apply) {
    next = reducer.reduce(next, apply);
    const htr = new HoldingTransactReducer();
    for (const a of actions.filter(a => a.type === 'HOLDING_TRANSACT')) next = htr.reduce(next, a);
  }
  return { actions, apply, next: next[stateKey] };
}

// ─── the bug, in the shape it was found ──────────────────────────────────────

test('G12: a negative year emits an APPLY at all (the discarded-loss regression)', () => {
  const state = stateWith('rothAccount');
  state.effectiveGrowthRates[IntlRothEarningsHandler.rateKey] = -0.20;
  const h = new IntlRothEarningsHandler({
    stateRegistry: registryFor('rothAccount'), role: 'ROTH', stateKey: 'rothAccount', growthRate: -0.20,
  });

  const actions = h.call({ state });
  const types = actions.map(a => a.type ?? a.constructor.name);

  assert.ok(types.includes('ROTH_EARNINGS_APPLY'),
    `a losing year must emit the apply action; got [${types.join(', ')}]`);
  assert.ok(actions.some(a => a.type === 'HOLDING_TRANSACT'),
    'a losing year must move the holdings too — the old guard dropped these with the apply');
  assert.equal(actions.find(a => a.type === 'ROTH_EARNINGS_APPLY').amount, -200_000);
});

test('G12: an exactly-flat year still short-circuits', () => {
  const state = stateWith('rothAccount');
  state.effectiveGrowthRates[IntlRothEarningsHandler.rateKey] = 0;
  const h = new IntlRothEarningsHandler({
    stateRegistry: registryFor('rothAccount'), role: 'ROTH', stateKey: 'rothAccount', growthRate: 0,
  });
  const actions = h.call({ state });
  assert.equal(actions.length, 1, 'a 0% year should emit only the balance recording');
  assert.ok(!actions.some(a => a.type === 'ROTH_EARNINGS_APPLY'));
});

// ─── every two-sided path takes the balance DOWN ─────────────────────────────

const TWO_SIDED = [
  {
    name: 'Roth', stateKey: 'rothAccount',
    handler: () => new IntlRothEarningsHandler({ stateRegistry: registryFor('rothAccount'), role: 'ROTH', stateKey: 'rothAccount', growthRate: -0.20 }),
    reducer: () => new RothEarningsApplyReducer({}), ledger: true,
  },
  {
    name: 'Traditional IRA', stateKey: 'iraAccount',
    handler: () => new IntlIraEarningsHandler({ stateRegistry: registryFor('iraAccount'), role: 'IRA', stateKey: 'iraAccount', growthRate: -0.20 }),
    reducer: () => new IraEarningsApplyReducer({}), ledger: true,
  },
  {
    name: '401(k)', stateKey: 'k401Account',
    handler: () => new IntlK401EarningsHandler({ stateRegistry: registryFor('k401Account'), role: 'K401', stateKey: 'k401Account', growthRate: -0.20 }),
    reducer: () => new K401EarningsApplyReducer({}), ledger: true,
  },
  {
    name: 'US brokerage', stateKey: 'usStockAccount',
    handler: () => new IntlUsStockEarningsHandler({ stateRegistry: registryFor('usStockAccount'), role: 'US_STOCK', stateKey: 'usStockAccount', growthRate: -0.20 }),
    reducer: () => new StockEarningsApplyReducer({}), ledger: false,
  },
  {
    name: 'AU brokerage', stateKey: 'auStockAccount',
    handler: () => new IntlAuStockEarningsHandler({ stateRegistry: registryFor('auStockAccount'), role: 'AU_STOCK', growthRate: -0.20 }),
    reducer: () => new AuStockEarningsApplyReducer({}), ledger: false,
  },
  {
    name: 'superannuation', stateKey: 'superAccount',
    handler: () => new SuperEarningsHandler({ stateRegistry: registryFor('superAccount'), role: 'SUPER', defaultRate: -0.20 }),
    reducer: () => new SuperEarningsApplyReducer({}), ledger: true,
  },
];

for (const c of TWO_SIDED) {
  test(`G12: ${c.name} — a −20% year reduces balance and holdings`, () => {
    const state = stateWith(c.stateKey);
    const before = state[c.stateKey].balance;
    const { apply, next } = runYear(c.handler(), c.reducer(), state, c.stateKey);

    assert.ok(apply, `${c.name}: no *_EARNINGS_APPLY emitted for a losing year`);
    assert.ok(next.balance < before,
      `${c.name}: balance must fall — was ${before}, now ${next.balance}`);
    assert.equal(next.balance, 800_000, `${c.name}: −20% of 1,000,000 should land at 800,000`);
    assert.ok(Math.abs(sumHoldings(next) - next.balance) < 0.02,
      `${c.name}: §4.4 — Σ holdings (${sumHoldings(next)}) must still equal balance (${next.balance})`);
  });
}

// ─── the ledger: loss falls on the gain first ────────────────────────────────

test('G12: the loss is charged to earnings before corpus', () => {
  const state = stateWith('rothAccount');            // 200k corpus / 800k earnings
  const { next } = runYear(
    new IntlRothEarningsHandler({ stateRegistry: registryFor('rothAccount'), role: 'ROTH', stateKey: 'rothAccount', growthRate: -0.20 }),
    new RothEarningsApplyReducer({}), state, 'rothAccount',
  );
  assert.equal(next.earningsBasis, 600_000, 'the whole 200k loss should come out of earnings');
  assert.equal(next.contributionBasis, 200_000, 'corpus must be untouched while earnings remain');
});

test('G12: a loss larger than earnings spills into corpus, and both floor at zero', () => {
  // earnings 50k against a 200k loss: earnings wiped, 150k spills to corpus.
  assert.deepEqual(
    debitLedgerForLoss({ contributionBasis: 400_000, earningsBasis: 50_000 }, 200_000),
    { earningsBasis: 0, contributionBasis: 250_000 },
  );
  // A loss exceeding the whole ledger lands at 0/0 rather than going negative.
  assert.deepEqual(
    debitLedgerForLoss({ contributionBasis: 10_000, earningsBasis: 5_000 }, 999_999),
    { earningsBasis: 0, contributionBasis: 0 },
  );
});

test('G12: earningsBasis never goes negative through the reducer', () => {
  // A wrapper that is almost all corpus, taking a loss bigger than its earnings.
  const state = stateWith('rothAccount', { contributionBasis: 950_000, earningsBasis: 50_000 });
  const { next } = runYear(
    new IntlRothEarningsHandler({ stateRegistry: registryFor('rothAccount'), role: 'ROTH', stateKey: 'rothAccount', growthRate: -0.20 }),
    new RothEarningsApplyReducer({}), state, 'rothAccount',
  );
  assert.equal(next.earningsBasis, 0);
  assert.equal(next.contributionBasis, 800_000);
  assert.ok(next.earningsBasis >= 0 && next.contributionBasis >= 0);
});

// ─── super: a loss reaches the member, but carries no Div 295 base ───────────

test('G12: a super loss withholds no fund earnings tax', () => {
  const state = stateWith('superAccount');
  const h = new SuperEarningsHandler({ stateRegistry: registryFor('superAccount'), role: 'SUPER', defaultRate: -0.20 });
  const actions = h.call({ state, data: {}, date: new Date('2040-06-30') });
  const apply = actions.find(a => a.type === 'SUPER_EARNINGS_APPLY');

  assert.ok(apply, 'the loss must still reach the member');
  assert.equal(apply.amount, -200_000, 'the member takes the loss in full');
  assert.equal(apply.grossAmount, 0, 'no Div 295 base — the fund is taxed on earnings, and there were none');
  assert.equal(apply.taxRate, 0, 'no withholding, and no phantom refund');
});

test('G12: a super GAIN still withholds Div 295 (the design 77 path is intact)', () => {
  const state = stateWith('superAccount');
  const h = new SuperEarningsHandler({ stateRegistry: registryFor('superAccount'), role: 'SUPER', defaultRate: 0.10 });
  const actions = h.call({ state, data: {}, date: new Date('2040-06-30') });
  const apply = actions.find(a => a.type === 'SUPER_EARNINGS_APPLY');

  assert.equal(apply.grossAmount, 100_000);
  assert.ok(apply.taxRate > 0, 'accumulation-phase earnings are still taxed in-fund');
  assert.ok(apply.amount < apply.grossAmount, 'the member receives growth net of the levy');
});

// ─── one-directional receipts keep the guard ─────────────────────────────────

test('G12 does NOT extend to dividends — a negative receipt is never booked', () => {
  const state = stateWith('auStockAccount');
  const h = new IntlAuStockDividendHandler({
    stateRegistry: registryFor('auStockAccount'), role: 'AU_STOCK', dividendRate: -0.04,
  });
  const actions = h.call({ state });
  assert.equal(actions.length, 1, 'only the balance recording; a negative dividend is not a thing');
  assert.ok(!actions.some(a => typeof a.type === 'string' && a.type.includes('DIVIDEND')));
});

for (const [label, make, key] of [
  ['AU savings interest', () => new AuSavingsInterestHandler({ stateRegistry: registryFor('auSavingsAccount'), role: 'AU_SAVINGS', stateKey: 'auSavingsAccount', interestRate: -0.02 }), 'auSavingsAccount'],
  ['US fixed income interest', () => new FixedIncomeInterestHandler({ stateRegistry: registryFor('usFixedIncomeAccount'), role: 'US_FIXED_INCOME', interestRate: -0.02 }), 'usFixedIncomeAccount'],
]) {
  test(`G12 does NOT extend to ${label} — negative interest is not booked as income`, () => {
    const state = stateWith(key);
    const actions = make().call({ state });
    assert.equal(actions.length, 1,
      `${label}: a negative rate must not book negative taxable income`);
  });
}
