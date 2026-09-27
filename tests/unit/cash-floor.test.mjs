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
 * cash-floor.js — `minimumBalance` is a CASH floor, and a cash account paying its own
 * bill restores it from the drawdown chain first.
 *
 * The tax-debit cases are the regression: the tax reducers sized their top-up against
 * the whole balance, so a bill the account could cover out of its buffer was paid out of
 * the buffer and left the account under its floor until the next month's expenses.
 */
import { test } from 'node:test';
import assert   from 'node:assert/strict';

import { cashFloorOf, floorTopUp, restoreFloorActions, hasCashFloor } from '../../src/finance/account-rules/cash-floor.js';
import { drawableBalance } from '../../src/finance/account-rules/penalty-free-availability.js';
import { AccountService }  from '../../src/finance/services/account-service.js';
import { Account, CheckingAccount, SavingsAccount, LoanAccount, USD } from '../../src/finance/assets/account.js';
import { BrokerageAccount, RothAccount, SuperannuationAccount } from '../../src/finance/assets/investment-account.js';
import { UsTaxPaymentDebitReducer } from '../../src/finance/tax/tax-settle-classes.js';
import { EventBus }       from '../../src/simulation-framework/event-bus.js';
import { Graph }          from '../../src/graph/graph.js';
import { GraphQueryApi }  from '../../src/graph/graph-query-api.js';

const DATE = new Date(2030, 5, 30);

// ─── the floor is a CASH floor ─────────────────────────────────────────────────

test('CF-1: cash accounts carry their floor; investment, retirement and loan accounts do not', () => {
  assert.equal(cashFloorOf(new SavingsAccount(10_000, { minimumBalance: 3_000 })), 3_000);
  assert.equal(cashFloorOf(new CheckingAccount(10_000, { minimumBalance: 3_000 })), 3_000);
  assert.equal(cashFloorOf(new Account(10_000, { type: 'offset', minimumBalance: 3_000 })), 3_000);
  for (const a of [
    new BrokerageAccount(10_000, { minimumBalance: 3_000 }),
    new RothAccount(10_000, { minimumBalance: 3_000 }),
    new SuperannuationAccount(10_000, { minimumBalance: 3_000 }),
    new LoanAccount(10_000, { minimumBalance: 3_000 }),
  ]) {
    assert.equal(cashFloorOf(a), 0, `${a.type} ignores its floor`);
    assert.equal(hasCashFloor(a.type), false);
    assert.equal(drawableBalance(a), a.balance, `${a.type} gives up its whole balance`);
  }
});

test('CF-2: an untyped account keeps its floor', () => {
  assert.equal(cashFloorOf(new Account(10_000, { minimumBalance: 3_000 })), 3_000);
});

test('CF-3: floorTopUp is what a debit needs raised to leave the account at its floor', () => {
  const s = new SavingsAccount(10_000, { minimumBalance: 8_000 });
  assert.equal(floorTopUp(s, 1_000), 0,     'covered by the balance above the floor');
  assert.equal(floorTopUp(s, 5_000), 3_000, '10k − 5k = 5k, 3k short of the 8k floor');
  assert.equal(floorTopUp(new BrokerageAccount(1_000, { minimumBalance: 8_000 }), 500), 0,
    'no floor on a brokerage');
});

test('CF-4: restoreFloorActions emits one REPLENISH_SAVINGS for a post-debit deficit, else none', () => {
  assert.deepEqual(restoreFloorActions(new SavingsAccount(3_000, { minimumBalance: 3_000 }), 'k'), []);
  assert.deepEqual(restoreFloorActions(new SavingsAccount(-500, { minimumBalance: 1_000 }), 'k'),
    [{ type: 'REPLENISH_SAVINGS', deficit: 1_500, targetKey: 'k' }]);
});

// ─── the tax debit restores the floor ──────────────────────────────────────────

function taxFixture({ cash = 10_000, floor = 8_000, invested = 50_000 } = {}) {
  const accountService = new AccountService(new Graph(), new GraphQueryApi(new Graph()), new EventBus());
  const state = {
    usSavingsAccount: new SavingsAccount(cash, { country: 'US', currency: USD, minimumBalance: floor }),
    usStock:          new BrokerageAccount(invested, { country: 'US', currency: USD, drawdownPriority: 1 }),
    personBirthDate:  new Date(1970, 0, 1),
  };
  const reducer = new UsTaxPaymentDebitReducer({
    accountService, stateRegistry: { getStateKey: () => 'usSavingsAccount' },
  });
  return { accountService, state, reducer };
}

test('CF-5: a tax bill the balance covers but the buffer does not is topped up, leaving the floor', () => {
  const { state, reducer } = taxFixture();
  const next = reducer.reduce(state, { type: 'US_TAX_PAYMENT_DEBIT', amount: 5_000 }, DATE);
  assert.equal(next.usSavingsAccount.balance, 8_000, 'paid the tax and kept the 8k floor');
  assert.equal(next.usStock.balance, 47_000, 'raised the 3k the buffer was short');
  assert.equal(next.next.some(a => a.type === 'INTL_TRANSFER_APPLY'), false,
    'restoring the floor never escalates cross-border');
});

test('CF-6: with nothing to draw, the tax is still paid out of the buffer (the floor is soft)', () => {
  const { state, reducer } = taxFixture({ invested: 0 });
  const next = reducer.reduce(state, { type: 'US_TAX_PAYMENT_DEBIT', amount: 5_000 }, DATE);
  assert.equal(next.usSavingsAccount.balance, 5_000);
  assert.equal(next.next.some(a => a.type === 'INTL_TRANSFER_APPLY' || a.type === 'OUT_OF_FUNDS'), false,
    'a bill the balance covered is not a failure');
});

test('CF-7: topUpForDebit returns the partial draw rather than throwing when the chain runs dry', () => {
  const { accountService, state } = taxFixture({ cash: 0, floor: 1_000, invested: 200 });
  const r = accountService.topUpForDebit(state, 'usSavingsAccount', 5_000, DATE);
  assert.ok(Array.isArray(r.pendingTaxActions) && Array.isArray(r.crossBorderTransfers));
  assert.equal(state.usStock.balance, 0, 'drew what there was');
  assert.equal(state.usSavingsAccount.balance, 200);
});
