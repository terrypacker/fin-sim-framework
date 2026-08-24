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

import { rescaleHoldingsToBalance, holdingsOutOfSync, distributeHoldingsCredit, scaleHoldings } from '../../src/finance/holdings/holding-utils.js';
import { ScenarioSerializer } from '../../src/scenarios/scenario-serializer.js';
import { ServiceRegistry }    from '../../src/services/service-registry.js';

const sumMv = (h) => +h.reduce((s, x) => s + (x.marketValue ?? 0), 0).toFixed(2);

// ── rescaleHoldingsToBalance ──────────────────────────────────────────────────

test('rescale preserves the sleeve mix proportionally for multi-holding accounts', () => {
  const holdings = [
    { marketValue: 90_000, costBasis: 108_000 },
    { marketValue: 60_000, costBasis: 42_000 },
  ];
  const out = rescaleHoldingsToBalance(holdings, 300_000);
  assert.equal(sumMv(out), 300_000);
  assert.equal(out[0].marketValue, 180_000); // 60% sleeve preserved
  assert.equal(out[1].marketValue, 120_000); // 40% sleeve preserved
  assert.equal(out[0].costBasis, 216_000);   // basis scaled pro-rata
  // Pure: the input holdings must be untouched (journal-aliasing invariant).
  assert.equal(holdings[0].marketValue, 90_000, 'input array is not mutated');
});

test('rescale of a single holding with no gain ties basis to the new balance', () => {
  const holdings = [{ marketValue: 900_000, costBasis: 900_000 }];
  const out = rescaleHoldingsToBalance(holdings, 150_000);
  assert.equal(out[0].marketValue, 150_000);
  assert.equal(out[0].costBasis, 150_000);
});

test('rescale of a single holding PRESERVES the unrealized gain ratio (design 43 §3 inv-3)', () => {
  // costBasis 60k vs marketValue 100k → 40% unrealized gain. A balance edit must
  // not wipe that gain by resetting basis to the new balance.
  const holdings = [{ marketValue: 100_000, costBasis: 60_000 }];
  const out = rescaleHoldingsToBalance(holdings, 50_000);
  assert.equal(out[0].marketValue, 50_000);
  assert.equal(out[0].costBasis, 30_000); // 60% of market value preserved
});

test('rescale preserves each lot costBasis/marketValue ratio across holdings (inv-3)', () => {
  const holdings = [
    { marketValue: 100_000, costBasis: 60_000 }, // 0.60
    { marketValue: 50_000,  costBasis: 65_000 }, // 1.30 (loss lot)
  ];
  const ratios = holdings.map(h => h.costBasis / h.marketValue);
  const out = rescaleHoldingsToBalance(holdings, 300_000);
  out.forEach((h, i) => {
    assert.ok(Math.abs(h.costBasis / h.marketValue - ratios[i]) < 1e-9,
      `lot ${i} gain ratio drifted`);
  });
});

test('rescale of an all-zero multi-holding account lands the balance in the first sleeve', () => {
  const holdings = [{ marketValue: 0, costBasis: 0 }, { marketValue: 0, costBasis: 0 }];
  const out = rescaleHoldingsToBalance(holdings, 60_000);
  assert.equal(out[0].marketValue, 60_000);
  assert.equal(out[1].marketValue, 0);
  assert.equal(sumMv(out), 60_000);
});

test('rescale absorbs penny rounding drift so the sum ties out exactly', () => {
  const holdings = [
    { marketValue: 1, costBasis: 1 },
    { marketValue: 1, costBasis: 1 },
    { marketValue: 1, costBasis: 1 },
  ];
  const out = rescaleHoldingsToBalance(holdings, 100); // 33.33 × 3 = 99.99 → +0.01 drift
  assert.equal(sumMv(out), 100);
});

test('rescale is a no-op for empty / missing holdings', () => {
  assert.deepEqual(rescaleHoldingsToBalance([], 100), []);
  assert.equal(rescaleHoldingsToBalance(null, 100), null);
});

// ── distributeHoldingsCredit (dividend reinvest) ─────────────────────────────

// The two tests below pass no `year`, which is the pre-design-93 pro-rata BLEND — kept
// for a caller that cannot say what year it is (a UI preview, a unit test), which in the
// simulation is none of them. The vintage-lot tests further down are the live path.

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

// ── distributeHoldingsCredit — the vintage lot (design 93 §5.0a) ─────────────
//
// Reinvested income is a PURCHASE: it buys more of the thing at today's price with its own
// basis. Spreading it into the existing lots made those dollars inherit an acquisition date
// they were never bought on — which is what FIFO, HIFO, the AU Division 115 twelve-month
// gate, the post-2027 indexation clock and the residency step-up all key off.

test('a reinvested dividend opens its OWN lot and leaves the paying sleeves untouched', () => {
  const holdings = [
    { id: 'a', allocation: 'EQUITY', marketValue: 75_000, costBasis: 50_000, rateKey: 'EQ',
      purchaseDate: new Date(Date.UTC(2020, 0, 1)) },
    { id: 'b', allocation: 'EQUITY', marketValue: 25_000, costBasis: 25_000, rateKey: 'EQ',
      purchaseDate: new Date(Date.UTC(2020, 0, 1)) },
  ];
  const out = distributeHoldingsCredit(holdings, 1_000, {
    stateKey: 'usStockAccount', year: 2031, purchaseMs: Date.UTC(2031, 5, 30), priceLevel: 1.12,
  });

  assert.equal(sumMv(out), 101_000, 'Σ market value still rises by exactly the credit');
  // The whole point: nothing happened to the lots that paid the dividend.
  assert.deepEqual(out[0], holdings[0], 'paying sleeve a is byte-identical');
  assert.deepEqual(out[1], holdings[1], 'paying sleeve b is byte-identical');

  const lot = out[2];
  assert.equal(out.length, 3, 'one new lot for the bucket, not one per paying sleeve');
  assert.equal(lot.marketValue, 1_000);
  assert.equal(lot.costBasis,   1_000, 'reinvested cash carries basis equal to its value');
  assert.equal(lot.allocation,  'EQUITY', 'allocation inherited from the sleeves that paid');
  assert.equal(lot.purchaseDate.getTime(), Date.UTC(2031, 5, 30), 'bought today, not in 2020');
  assert.equal(lot.acquisitionPriceLevel, 1.12, 'indexed from its own acquisition (design 57 §6.3)');
  assert.equal(lot.maturityDate, null, 'a fund position — no maturity, no par, no units');
  assert.equal(lot.faceValue,    null);
  assert.equal(lot.units,        undefined, 'and therefore nothing that could blend a par');
});

test('a second payment in the same year merges into that year\'s lot; a new year opens a new one', () => {
  // Bounded: one lot per bucket per year, not one per payment. Merging within a vintage is
  // not the blend the rule forbids — no holding-period test can distinguish the halves.
  let hs = [{ id: 'a', allocation: 'EQUITY', marketValue: 100_000, costBasis: 100_000, rateKey: 'EQ' }];
  const credit = (amount, year) => distributeHoldingsCredit(hs, amount, { stateKey: 'acct', year });

  hs = credit(1_000, 2031);
  hs = credit(1_000, 2031);
  assert.equal(hs.length, 2, 'both 2031 payments share one lot');
  assert.equal(hs[1].marketValue, 2_000);
  assert.equal(hs[1].costBasis,   2_000);

  hs = credit(1_000, 2032);
  assert.equal(hs.length, 3, '2032 is a different vintage');
  assert.equal(hs[2].marketValue, 1_000);
});

test('the credit is split across sleeve BUCKETS by market value, so allocation drift is unchanged', () => {
  // The rejected alternative — one lot per account per payment — had to pick a single
  // allocation for the whole credit, which moves the mix. Bucketing keeps each allocation's
  // share of the credit equal to its share of the value that earned it.
  const holdings = [
    { id: 'e', allocation: 'EQUITY', marketValue: 60_000, costBasis: 60_000, rateKey: 'EQ' },
    { id: 'o', allocation: 'OTHER',  marketValue: 40_000, costBasis: 40_000, rateKey: 'OT' },
  ];
  const out = distributeHoldingsCredit(holdings, 1_000, { stateKey: 'acct', year: 2031 });
  const share = (alloc) => out.filter(h => h.allocation === alloc)
                              .reduce((s, h) => s + h.marketValue, 0);
  assert.equal(out.length, 4, 'one new lot per bucket');
  assert.equal(share('EQUITY'), 60_600, '60% of the value earned 60% of the credit');
  assert.equal(share('OTHER'),  40_400);
});

test('a reinvested coupon buys BOND exposure, never more of the rung that paid it', () => {
  // design 66 §G10b's reinvestment-risk point, and design 93 §5b's par point: the vintage
  // lot is a FUND, so a coupon can never grow a dated rung's par or unit count.
  const rung = { id: 'r', allocation: 'BOND', marketValue: 100_000, costBasis: 100_000,
                 faceValue: 100_000, units: 1_000, parPerUnit: 100, pricePerUnit: 100,
                 maturityDate: new Date(Date.UTC(2035, 0, 1)), rateKey: 'FI', taxExemption: 'state' };
  const out = distributeHoldingsCredit([rung], 4_000, { stateKey: 'acct', year: 2031 });

  assert.deepEqual(out[0], rung, 'the rung is not written to at all');
  assert.equal(out[1].allocation,   'BOND');
  assert.equal(out[1].taxExemption, 'state', 'the tax identity of the sleeve that paid is inherited');
  assert.equal(out[1].maturityDate, null,    'but not its maturity');
  assert.equal(out[1].faceValue,    null,    'and not its par');
});

// ── scaleHoldings — the two directions are different operations (design 93 §5.0a) ──

test('a DEBIT scales every lot proportionally — a withdrawal is a proportional sell', () => {
  const holdings = [
    { id: 'a', allocation: 'EQUITY', marketValue: 60_000, costBasis: 30_000 },
    { id: 'b', allocation: 'EQUITY', marketValue: 40_000, costBasis: 40_000 },
  ];
  const out = scaleHoldings(holdings, 100_000, 80_000, { year: 2031, purchaseMs: Date.UTC(2031, 0, 1) });
  assert.equal(out.length, 2, 'a sell opens no lots');
  assert.equal(out[0].marketValue, 48_000);
  assert.equal(out[0].costBasis,   24_000, 'basis leaves with the units, pro rata');
  assert.equal(out[1].marketValue, 32_000);
});

test('a CREDIT opens a lot and gives the new money its FULL basis', () => {
  // Two bugs in one: scaling on the way in made the deposited dollars inherit the
  // destination lots' acquisition dates (the design 62 §9 defect), and it scaled BASIS by
  // the value ratio — which under-adds basis whenever the position carries a gain. Here
  // the account holds a 30k unrealized gain, so the old form credited only ~14k of basis
  // for a 20k deposit.
  const holdings = [
    { id: 'a', allocation: 'EQUITY', marketValue: 60_000, costBasis: 30_000, rateKey: 'EQ',
      purchaseDate: new Date(Date.UTC(2015, 0, 1)) },
    { id: 'b', allocation: 'EQUITY', marketValue: 40_000, costBasis: 40_000, rateKey: 'EQ',
      purchaseDate: new Date(Date.UTC(2015, 0, 1)) },
  ];
  const out = scaleHoldings(holdings, 100_000, 120_000, { year: 2031, purchaseMs: Date.UTC(2031, 0, 1) });

  assert.equal(sumMv(out), 120_000, 'Σ market value still ties to the new balance');
  assert.deepEqual(out.slice(0, 2), holdings, 'the existing lots are byte-identical');
  assert.equal(out.length, 3, 'the deposit is its own lot');
  assert.equal(out[2].marketValue, 20_000);
  assert.equal(out[2].costBasis,   20_000, 'the full deposit, not 20,000 x (basis/value)');
  assert.equal(out[2].purchaseDate.getTime(), Date.UTC(2031, 0, 1), 'bought in 2031, not 2015');
});

test('scaleHoldings with NO vintage keeps the old proportional scale in both directions', () => {
  // For the UI and for unit tests, which have no clock. Every simulation caller passes
  // `lotVintage(state, account)`; a caller that forgets simply gets the pre-93 behaviour
  // rather than a half-applied rule.
  const holdings = [{ id: 'a', allocation: 'EQUITY', marketValue: 100_000, costBasis: 50_000 }];
  const out = scaleHoldings(holdings, 100_000, 120_000);
  assert.equal(out.length, 1);
  assert.equal(out[0].marketValue, 120_000);
  assert.equal(out[0].costBasis,    60_000, 'basis scaled by the ratio — the old under-add');
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
