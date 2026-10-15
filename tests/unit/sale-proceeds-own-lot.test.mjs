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
 * Sale proceeds deposited into an investment account are a PURCHASE in dated lots of their own,
 * not value and basis blended into the lots already there (study flag 21). Into a cash account
 * they are the plain credit, unchanged.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { AccountService } from '../../src/finance/services/account-service.js';
import { creditSaleProceeds } from '../../src/finance/account-rules/cash-routing.js';
import { Graph } from '../../src/graph/graph.js';
import { EventBus } from '../../src/simulation-framework/event-bus.js';

const OLD = new Date(Date.UTC(2022, 2, 1));
const SALE = new Date(Date.UTC(2026, 9, 29));

function brokerage() {
  return {
    stateKey: 'usStockAccount', country: 'US', currency: { code: 'USD' }, balance: 1_000_000,
    holdings: [
      { id: 'eq-2022', allocation: 'EQUITY', marketValue: 800_000, costBasis: 300_000,
        purchaseDate: OLD, rateKey: 'EQUITY_US' },
      { id: 'cash', allocation: 'CASH', marketValue: 200_000, costBasis: 200_000, rateKey: 'CASH_US' },
    ],
  };
}

test('SALE-LOT-1: proceeds into a brokerage open dated lots; the 2022 lot keeps its value and basis', () => {
  const svc = new AccountService(new Graph(), new EventBus());
  const acct = brokerage();
  const state = { usStockAccount: acct };
  creditSaleProceeds(svc, state, 'usStockAccount', 100_000, 'USD', 'usHouseProperty', SALE);

  const old = acct.holdings.find(h => h.id === 'eq-2022');
  assert.equal(old.marketValue, 800_000, 'not backdated into the old lot');
  assert.equal(old.costBasis, 300_000, 'basis not blended');
  const fresh = acct.holdings.filter(h => h.id.startsWith('reinvest-usStockAccount-'));
  assert.equal(fresh.length, 2, 'one new lot per sleeve');
  for (const h of fresh) {
    assert.equal(h.costBasis, h.marketValue, 'zero-gain lot');
    assert.equal(new Date(h.purchaseDate).getTime(), SALE.getTime(), 'dated the sale day');
  }
  // The account's MIX is what it was: 80/20, the credit split by market value.
  const eq = acct.holdings.filter(h => h.allocation === 'EQUITY').reduce((s, h) => s + h.marketValue, 0);
  assert.equal(eq, 880_000);
  assert.equal(acct.balance, 1_100_000);
  assert.equal(acct.holdings.reduce((s, h) => s + h.marketValue, 0), 1_100_000, '§4.4 invariant');
});

test('SALE-LOT-2: into a cash account, and with no date, it is the plain credit', () => {
  const svc = new AccountService(new Graph(), new EventBus());
  const savings = { stateKey: 'usSavingsAccount', country: 'US', currency: { code: 'USD' }, balance: 50_000,
    holdings: [{ id: 'c', allocation: 'CASH', marketValue: 50_000, costBasis: 50_000 }] };
  creditSaleProceeds(svc, { usSavingsAccount: savings }, 'usSavingsAccount', 10_000, 'USD', null, SALE);
  assert.deepEqual(savings.holdings.map(h => [h.id, h.marketValue]), [['c', 60_000]]);

  const acct = brokerage();
  creditSaleProceeds(svc, { usStockAccount: acct }, 'usStockAccount', 100_000, 'USD', null, null);
  assert.equal(acct.holdings.length, 2, 'no clock, no vintage: the old pro-rata credit');
});
