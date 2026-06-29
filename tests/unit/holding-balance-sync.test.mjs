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
 * holding-balance-sync.test.mjs — guards the §4.4 invariant
 * (account.balance === Σ holdings[i].marketValue) across balance edits and on
 * load. Covers the holdings-balance desync defect: balance cascades / account
 * updates that left holdings stale, and the on-load auto-heal for already-saved
 * corrupt scenarios.
 */

import { test }  from 'node:test';
import assert    from 'node:assert/strict';

import { rescaleHoldingsToBalance, holdingsOutOfSync, distributeHoldingsCredit } from '../../src/finance/holdings/holding-utils.js';
import { ScenarioSerializer } from '../../src/scenarios/scenario-serializer.js';
import { ServiceRegistry }    from '../../src/services/service-registry.js';

const sumMv = (h) => +h.reduce((s, x) => s + (x.marketValue ?? 0), 0).toFixed(2);

// ── rescaleHoldingsToBalance ──────────────────────────────────────────────────

test('rescale preserves the sleeve mix proportionally for multi-holding accounts', () => {
  const holdings = [
    { marketValue: 90_000, costBasis: 108_000 },
    { marketValue: 60_000, costBasis: 42_000 },
  ];
  rescaleHoldingsToBalance(holdings, 300_000);
  assert.equal(sumMv(holdings), 300_000);
  assert.equal(holdings[0].marketValue, 180_000); // 60% sleeve preserved
  assert.equal(holdings[1].marketValue, 120_000); // 40% sleeve preserved
  assert.equal(holdings[0].costBasis, 216_000);   // basis scaled pro-rata
});

test('rescale of a single holding with no gain ties basis to the new balance', () => {
  const holdings = [{ marketValue: 900_000, costBasis: 900_000 }];
  rescaleHoldingsToBalance(holdings, 150_000);
  assert.equal(holdings[0].marketValue, 150_000);
  assert.equal(holdings[0].costBasis, 150_000);
});

test('rescale of a single holding PRESERVES the unrealized gain ratio (design 43 §3 inv-3)', () => {
  // costBasis 60k vs marketValue 100k → 40% unrealized gain. A balance edit must
  // not wipe that gain by resetting basis to the new balance.
  const holdings = [{ marketValue: 100_000, costBasis: 60_000 }];
  rescaleHoldingsToBalance(holdings, 50_000);
  assert.equal(holdings[0].marketValue, 50_000);
  assert.equal(holdings[0].costBasis, 30_000); // 60% of market value preserved
});

test('rescale preserves each lot costBasis/marketValue ratio across holdings (inv-3)', () => {
  const holdings = [
    { marketValue: 100_000, costBasis: 60_000 }, // 0.60
    { marketValue: 50_000,  costBasis: 65_000 }, // 1.30 (loss lot)
  ];
  const ratios = holdings.map(h => h.costBasis / h.marketValue);
  rescaleHoldingsToBalance(holdings, 300_000);
  holdings.forEach((h, i) => {
    assert.ok(Math.abs(h.costBasis / h.marketValue - ratios[i]) < 1e-9,
      `lot ${i} gain ratio drifted`);
  });
});

test('rescale of an all-zero multi-holding account lands the balance in the first sleeve', () => {
  const holdings = [{ marketValue: 0, costBasis: 0 }, { marketValue: 0, costBasis: 0 }];
  rescaleHoldingsToBalance(holdings, 60_000);
  assert.equal(holdings[0].marketValue, 60_000);
  assert.equal(holdings[1].marketValue, 0);
  assert.equal(sumMv(holdings), 60_000);
});

test('rescale absorbs penny rounding drift so the sum ties out exactly', () => {
  const holdings = [
    { marketValue: 1, costBasis: 1 },
    { marketValue: 1, costBasis: 1 },
    { marketValue: 1, costBasis: 1 },
  ];
  rescaleHoldingsToBalance(holdings, 100); // 33.33 × 3 = 99.99 → +0.01 drift
  assert.equal(sumMv(holdings), 100);
});

test('rescale is a no-op for empty / missing holdings', () => {
  assert.deepEqual(rescaleHoldingsToBalance([], 100), []);
  assert.equal(rescaleHoldingsToBalance(null, 100), null);
});

// ── distributeHoldingsCredit (dividend reinvest) ─────────────────────────────

test('distributeHoldingsCredit adds the full credit to market value AND basis, weighted by mv', () => {
  const holdings = [
    { id: 'a', marketValue: 75_000, costBasis: 50_000 }, // 75% weight
    { id: 'b', marketValue: 25_000, costBasis: 25_000 }, // 25% weight
  ];
  const out = distributeHoldingsCredit(holdings, 1_000);
  assert.equal(sumMv(out), 101_000);                       // Σmv rose by exactly the credit
  assert.equal(out[0].marketValue, 75_750);                // 75% of 1,000
  assert.equal(out[1].marketValue, 25_250);                // 25% (residual)
  // basis rose by the full credit (reinvested cash carries basis = its value)
  assert.equal(+(out[0].costBasis + out[1].costBasis).toFixed(2), 76_000);
});

test('distributeHoldingsCredit lands the whole credit in the first holding when mv is zero', () => {
  const holdings = [{ id: 'a', marketValue: 0, costBasis: 0 }, { id: 'b', marketValue: 0, costBasis: 0 }];
  const out = distributeHoldingsCredit(holdings, 500);
  assert.equal(out[0].marketValue, 500);
  assert.equal(out[0].costBasis, 500);
  assert.equal(out[1].marketValue, 0);
});

// ── holdingsOutOfSync ────────────────────────────────────────────────────────

test('holdingsOutOfSync detects drift beyond a cent and ignores in-sync / empty', () => {
  assert.equal(holdingsOutOfSync({ balance: 150_000, holdings: [{ marketValue: 900_000 }] }), true);
  assert.equal(holdingsOutOfSync({ balance: 150_000, holdings: [{ marketValue: 150_000 }] }), false);
  assert.equal(holdingsOutOfSync({ balance: 150_000, holdings: [] }), false);
  assert.equal(holdingsOutOfSync({ balance: 100, holdings: [{ marketValue: 100.009 }] }), false);
});

// ── auto-heal on load (_makeAccount) ──────────────────────────────────────────

test('_makeAccount heals a corrupt saved account so holdings tie to balance', () => {
  const corrupt = {
    __type: 'BrokerageAccount', stateKey: 'usStockAccount', name: 'US Stock', balance: 150_000,
    holdings: [{ __type: 'Holding', id: 'hld17', allocation: 'EQUITY', rateKey: 'EQUITY_US',
                 label: '', marketValue: 900_000, costBasis: 900_000 }],
  };
  const account = ScenarioSerializer._makeAccount(corrupt);
  assert.equal(account.holdings.length, 1);
  assert.equal(account.holdings[0].marketValue, 150_000);
  assert.equal(sumMv(account.holdings), account.balance);
});

test('_makeAccount leaves an already-in-sync multi-holding account untouched', () => {
  const ok = {
    __type: 'BrokerageAccount', stateKey: 'usStockAccount', name: 'US Stock', balance: 150_000,
    holdings: [
      { __type: 'Holding', id: 'h-us',   allocation: 'EQUITY', rateKey: 'EQUITY_US', label: 'US',   marketValue: 90_000, costBasis: 108_000 },
      { __type: 'Holding', id: 'h-intl', allocation: 'EQUITY', rateKey: 'EQUITY_US', label: 'Intl', marketValue: 60_000, costBasis: 42_000 },
    ],
  };
  const account = ScenarioSerializer._makeAccount(ok);
  assert.equal(account.holdings[0].marketValue, 90_000);
  assert.equal(account.holdings[1].costBasis, 42_000);
});

// ── AccountService.updateAccount keeps the invariant on balance-only edits ─────

test('updateAccount rescales holdings when only the balance changes', () => {
  ServiceRegistry.resetAll();
  const { accountService } = ServiceRegistry.getInstance();
  // Build a minimal account through the serializer, then register it.
  const account = ScenarioSerializer._makeAccount({
    __type: 'BrokerageAccount', stateKey: 'usStockAccount', name: 'US Stock', balance: 150_000,
    holdings: [
      { __type: 'Holding', id: 'h-us',   allocation: 'EQUITY', rateKey: 'EQUITY_US', label: 'US',   marketValue: 90_000, costBasis: 108_000 },
      { __type: 'Holding', id: 'h-intl', allocation: 'EQUITY', rateKey: 'EQUITY_US', label: 'Intl', marketValue: 60_000, costBasis: 42_000 },
    ],
  });
  accountService.register(account);

  accountService.updateAccount(account, { balance: 300_000 });
  assert.equal(sumMv(account.holdings), 300_000);
  assert.equal(account.holdings[0].marketValue, 180_000);

  // A holdings-bearing edit is authoritative and must NOT be rescaled away.
  accountService.updateAccount(account, {
    balance: 300_000,
    holdings: [{ id: 'h-us', allocation: 'EQUITY', rateKey: 'EQUITY_US', marketValue: 250_000, costBasis: 250_000 }],
  });
  assert.equal(account.holdings.length, 1);
  assert.equal(account.holdings[0].marketValue, 250_000);
});
