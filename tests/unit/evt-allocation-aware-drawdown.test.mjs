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
 * EVT-ALLOCATION-AWARE-DRAWDOWN (design 65): the engine drawdown path
 * (AccountService.replenishSavings → _drawPenaltyFree → consumeHoldings) honors the
 * state.drawdownSleeveOrder (Lever A) + state.drawdownLotStrategy (Lever B) policy,
 * selling the cheap-to-tax sleeve/lots first instead of blind FIFO — while the
 * default (FIFO/FIFO, i.e. no state fields) stays byte-identical.
 *
 * Run with: node --test tests/unit/evt-allocation-aware-drawdown.test.mjs
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import { AccountService }      from '../../src/finance/services/account-service.js';
import { CheckingAccount, USD } from '../../src/finance/assets/account.js';
import { BrokerageAccount }    from '../../src/finance/assets/investment-account.js';
import { Holding }             from '../../src/finance/holdings/holding.js';
import { ALLOCATION }          from '../../src/finance/holdings/allocation.js';
import { ACCOUNT_ROLES }       from '../../src/finance/state/account-roles.js';
import { EventBus }            from '../../src/simulation-framework/event-bus.js';
import { Graph }               from '../../src/graph/graph.js';
import { GraphQueryApi }       from '../../src/graph/graph-query-api.js';
import { StockWithdrawalApplyReducer } from '../../src/finance/account-rules/us/us-brokerage-classes.js';
import { makeAccount, makeServices }   from '../helpers/reducer-fixtures.js';

const D = (y) => new Date(Date.UTC(y, 0, 1));

/** A taxable brokerage holding an appreciated (old) equity lot + a fresh cash lot. */
function brokerageFixture(stateFields = {}) {
  const svc     = new AccountService(new Graph(), new GraphQueryApi(new Graph()), new EventBus());
  const savings = new CheckingAccount(0, { country: 'US', currency: USD });
  const broker  = new BrokerageAccount(10_000, { country: 'US', currency: USD, drawdownPriority: 1 });
  broker.holdings = [
    new Holding({ id: 'eq',   allocation: ALLOCATION.EQUITY, marketValue: 5000, costBasis: 1000, purchaseDate: D(2010), rateKey: 'EQUITY_US' }), // oldest, big gain
    new Holding({ id: 'cash', allocation: ALLOCATION.CASH,   marketValue: 5000, costBasis: 5000, purchaseDate: D(2020), rateKey: 'CASH_US' }),   // no gain
  ];
  const state = {
    savingsAccount: savings, brokerAccount: broker,
    personBirthDate: new Date(1970, 0, 1), // age ~56: eligible for taxable brokerage
    ...stateFields,
  };
  return { svc, savings, broker, state };
}

const hold = (broker, id) => broker.holdings.find(h => h.id === id);

test('EVT-65 default (no sleeve fields) is blind FIFO — sells the oldest EQUITY lot', () => {
  const { svc, broker, state } = brokerageFixture();
  svc.replenishSavings(state, 'savingsAccount', 3000, new Date(2026, 0, 1));
  // FIFO consumes the 2010 equity lot first.
  assert.equal(hold(broker, 'eq').marketValue, 2000);   // 5000 − 3000
  assert.equal(hold(broker, 'cash').marketValue, 5000); // untouched
});

test('EVT-65 Lever A TAX_COST sells the CASH sleeve first — EQUITY preserved', () => {
  const { svc, broker, state } = brokerageFixture({ drawdownSleeveOrder: 'TAX_COST' });
  svc.replenishSavings(state, 'savingsAccount', 3000, new Date(2026, 0, 1));
  assert.equal(hold(broker, 'cash').marketValue, 2000); // cash sold first
  assert.equal(hold(broker, 'eq').marketValue, 5000);   // equity untouched (no gain realized)
});

test('EVT-65 explicit FIFO/FIFO matches the absent-field default (byte-identical)', () => {
  const base = brokerageFixture();
  const expl = brokerageFixture({ drawdownSleeveOrder: 'FIFO', drawdownLotStrategy: 'FIFO' });
  base.svc.replenishSavings(base.state, 'savingsAccount', 3000, new Date(2026, 0, 1));
  expl.svc.replenishSavings(expl.state, 'savingsAccount', 3000, new Date(2026, 0, 1));
  assert.deepEqual(
    base.broker.holdings.map(h => [h.id, h.marketValue]),
    expl.broker.holdings.map(h => [h.id, h.marketValue]),
  );
});

test('EVT-65 Lever B HIFO picks the higher-basis lot within a sleeve', () => {
  // Two equity lots: one deeply appreciated (basis 1000), one near cost (basis 4800).
  const svc     = new AccountService(new Graph(), new GraphQueryApi(new Graph()), new EventBus());
  const savings = new CheckingAccount(0, { country: 'US', currency: USD });
  const broker  = new BrokerageAccount(10_000, { country: 'US', currency: USD, drawdownPriority: 1 });
  broker.holdings = [
    new Holding({ id: 'lo', allocation: ALLOCATION.EQUITY, marketValue: 5000, costBasis: 1000, purchaseDate: D(2010), rateKey: 'EQUITY_US' }),
    new Holding({ id: 'hi', allocation: ALLOCATION.EQUITY, marketValue: 5000, costBasis: 4800, purchaseDate: D(2022), rateKey: 'EQUITY_US' }),
  ];
  const state = { savingsAccount: savings, brokerAccount: broker,
    personBirthDate: new Date(1970, 0, 1), drawdownLotStrategy: 'HIFO' };
  svc.replenishSavings(state, 'savingsAccount', 3000, new Date(2026, 0, 1));
  // HIFO consumes the high-basis 'hi' lot first (least gain), leaving 'lo' whole.
  assert.equal(broker.holdings.find(h => h.id === 'hi').marketValue, 2000);
  assert.equal(broker.holdings.find(h => h.id === 'lo').marketValue, 5000);
});

// ─── Event path: STOCK_WITHDRAWAL_APPLY reducer honors the same policy ─────────

/** A US brokerage with an appreciated equity lot + a fresh cash lot. */
function reducerFixture(stateFields = {}) {
  const usStockAccount = makeAccount({
    stateKey: 'usStockAccount', role: ACCOUNT_ROLES.US_STOCK,
    holdings: [
      { id: 'eq',   allocation: ALLOCATION.EQUITY, marketValue: 5000, costBasis: 1000, purchaseDate: new Date('2010-01-01') },
      { id: 'cash', allocation: ALLOCATION.CASH,   marketValue: 5000, costBasis: 5000, purchaseDate: new Date('2020-01-01') },
    ],
  });
  const state = { usSavingsAccount: makeAccount({ stateKey: 'usSavingsAccount', balance: 0 }), usStockAccount, ...stateFields };
  return state;
}

test('EVT-65 event path FIFO (default) sells the oldest EQUITY lot → realizes the big gain', () => {
  const state = reducerFixture();
  const next = new StockWithdrawalApplyReducer(makeServices()).reduce(
    state, { type: 'STOCK_WITHDRAWAL_APPLY', salePrice: 3000, residency: 'US' });
  const tax = next.next.find(a => a.type === 'STOCK_WITHDRAWAL_TAX');
  // FIFO sells 3000 of the 2010 equity lot: gain = 3000 − (1000 × 3000/5000) = 2400.
  assert.equal(tax.gain, 2400);
});

test('EVT-65 event path TAX_COST sells the CASH sleeve first → zero realized gain', () => {
  const state = reducerFixture({ drawdownSleeveOrder: 'TAX_COST' });
  const next = new StockWithdrawalApplyReducer(makeServices()).reduce(
    state, { type: 'STOCK_WITHDRAWAL_APPLY', salePrice: 3000, residency: 'US' });
  const tax = next.next.find(a => a.type === 'STOCK_WITHDRAWAL_TAX');
  // CASH sleeve (basis = market value) is sold first ⇒ no gain realized.
  assert.equal(tax.gain, 0);
  // Equity lot survives whole.
  assert.equal(next.usStockAccount.holdings.find(h => h.id === 'eq').marketValue, 5000);
});
