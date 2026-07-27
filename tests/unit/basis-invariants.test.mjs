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
 * basis-invariants.test.mjs — design 43 §4 property-test harness.
 *
 * Composes the real basis primitives (AccountService.transaction +
 * reduceLedgerForWithdrawal for cash moves, rescaleHoldingsToBalance for balance
 * edits, and an earnings accrual that mirrors the type reducers) the way the
 * type-specific reducers do, then drives a randomized sequence of
 * contributions / withdrawals / market-moves / rebuilds and asserts the four
 * coherence invariants hold after EVERY operation:
 *
 *   1. ledger sums to balance:  contributionBasis + earningsBasis == balance
 *   2. non-negativity:          costBasis, contributionBasis, earningsBasis >= 0
 *   3. rescale preserves the gain ratio (each lot's costBasis/marketValue)
 *   4. drawdown conservation:   a withdrawal of w drops ΣmarketValue by w and
 *                               ΣcostBasis by the proportional realized basis
 *
 * A regression in any reducer that mutates balance without honestly maintaining
 * basis should trip one of these.
 */

import { test } from 'node:test';
import assert    from 'node:assert/strict';

import { AccountService } from '../../src/finance/services/account-service.js';
import { SuperannuationAccount } from '../../src/finance/assets/investment-account.js';
import { rescaleHoldingsToBalance } from '../../src/finance/holdings/holding-utils.js';
import { Graph } from '../../src/graph/graph.js';
import { GraphQueryApi } from '../../src/graph/graph-query-api.js';
import { EventBus } from '../../src/simulation-framework/event-bus.js';

// Deterministic LCG so failures are reproducible.
function makeRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

const sum = (h, k) => h.reduce((a, x) => a + (x[k] ?? 0), 0);
const TOL = 0.05; // absolute $ tolerance for accumulated float drift

function makeSvc() {
  const g = new Graph();
  return new AccountService(g, new GraphQueryApi(g), new EventBus());
}

// A super account exercises the proportional ledger rule (the generic default).
function makeAccount() {
  const a = new SuperannuationAccount(100_000, {
    contributionBasis: 80_000,
    earningsBasis:     20_000,
  });
  a.holdings = [
    { id: 'h1', marketValue: 60_000, costBasis: 48_000 }, // 20% gain
    { id: 'h2', marketValue: 40_000, costBasis: 44_000 }, // loss lot
  ];
  return a;
}

function assertInvariants(a, label) {
  // Invariant 1
  assert.ok(
    Math.abs((a.contributionBasis + a.earningsBasis) - a.balance) <= TOL,
    `[${label}] inv-1 ledger != balance: ${a.contributionBasis} + ${a.earningsBasis} vs ${a.balance}`
  );
  // Invariant 2
  assert.ok(a.contributionBasis >= -TOL && a.earningsBasis >= -TOL, `[${label}] inv-2 ledger negative`);
  for (const h of a.holdings) {
    assert.ok((h.costBasis ?? 0) >= -TOL, `[${label}] inv-2 costBasis negative`);
    assert.ok((h.marketValue ?? 0) >= -TOL, `[${label}] inv-2 marketValue negative`);
  }
  // §4.4: holdings tie to balance
  assert.ok(Math.abs(sum(a.holdings, 'marketValue') - a.balance) <= TOL, `[${label}] §4.4 Σmv != balance`);
}

// Compose the primitives the way the type reducers do.
function contribute(svc, a, amt) {
  svc.transaction(a, +amt, null);          // balance + holdings (mv & cb at cost)
  a.contributionBasis += amt;              // ledger: cash in is contribution
}

function withdraw(svc, a, amt) {
  const mvBefore = sum(a.holdings, 'marketValue');
  const cbBefore = sum(a.holdings, 'costBasis');
  svc.transaction(a, -amt, null);          // balance - + holdings consumed pro-rata
  svc.reduceLedgerForWithdrawal(a, amt);   // ledger: proportional (super default)
  // Invariant 4: conservation.
  const mvDrop = mvBefore - sum(a.holdings, 'marketValue');
  const cbDrop = cbBefore - sum(a.holdings, 'costBasis');
  const expectedCbDrop = mvBefore > 0 ? cbBefore * (amt / mvBefore) : 0;
  assert.ok(Math.abs(mvDrop - amt) <= TOL, `inv-4 Σmv drop ${mvDrop} != ${amt}`);
  assert.ok(Math.abs(cbDrop - expectedCbDrop) <= TOL, `inv-4 realized basis ${cbDrop} != ${expectedCbDrop}`);
}

function marketMove(a, factor) {
  const mvBefore = sum(a.holdings, 'marketValue');
  for (const h of a.holdings) h.marketValue = (h.marketValue ?? 0) * factor; // cb unchanged
  const gain = sum(a.holdings, 'marketValue') - mvBefore;
  a.balance += gain;                       // mirrors _syncBalance to Σmv
  // A gain accrues to (untaxed) earnings; a loss is absorbed earnings-first, then
  // spills into contribution basis — so the account loses gains before principal
  // and both ledger components stay >= 0 (inv-2) while still summing to balance.
  let newEarnings = a.earningsBasis + gain;
  if (newEarnings < 0) {
    a.contributionBasis = Math.max(0, a.contributionBasis + newEarnings);
    newEarnings = 0;
  }
  a.earningsBasis = newEarnings;
}

function rebuild(a, newBalance) {
  // Param/Rebuild balance edit: rescale holdings (gain ratio preserved) and
  // scale the ledger by the same factor.
  const ratios = a.holdings.map(h => (h.marketValue > 0 ? h.costBasis / h.marketValue : null));
  const factor = a.balance > 0 ? newBalance / a.balance : 1;
  a.holdings = rescaleHoldingsToBalance(a.holdings, newBalance);
  a.balance = newBalance;
  a.contributionBasis *= factor;
  a.earningsBasis *= factor;
  // Invariant 3: each lot's gain ratio survived the rescale, up to the cent
  // rounding the function applies to marketValue and costBasis.
  a.holdings.forEach((h, i) => {
    if (ratios[i] == null || !(h.marketValue > 0)) return;
    const expectedCb = ratios[i] * h.marketValue;
    assert.ok(Math.abs(h.costBasis - expectedCb) <= 0.05, `inv-3 lot ${i} gain ratio drifted: ${h.costBasis} vs ${expectedCb}`);
  });
}

test('basis invariants hold across 400 randomized contribution/withdrawal/market/rebuild ops', () => {
  const rng = makeRng(0xC0FFEE);
  const svc = makeSvc();
  const a = makeAccount();
  assertInvariants(a, 'init');

  for (let i = 0; i < 400; i++) {
    const roll = rng();
    if (roll < 0.30) {
      contribute(svc, a, 500 + rng() * 20_000);
    } else if (roll < 0.60) {
      // Withdraw a fraction of the drawable balance so we never over-draw.
      const w = Math.min(a.balance * (0.05 + rng() * 0.4), a.balance - 1);
      if (w > 1) withdraw(svc, a, w);
    } else if (roll < 0.85) {
      marketMove(a, 0.85 + rng() * 0.35); // ±... factor in [0.85, 1.20]
    } else {
      rebuild(a, Math.max(1_000, a.balance * (0.5 + rng())));
    }
    assertInvariants(a, `op ${i} roll=${roll.toFixed(3)}`);
  }
});

test('basis invariants hold for the Roth contributions-first ledger rule', () => {
  // Same harness, Roth account: reduceLedgerForWithdrawal draws contributions
  // first, so inv-1 must still tie out even with the non-proportional split.
  const svc = makeSvc();
  const a = new (class extends SuperannuationAccount {})(100_000, {});
  a.type = 'roth';
  a.contributionBasis = 70_000;
  a.earningsBasis = 30_000;
  a.holdings = [{ id: 'h1', marketValue: 100_000, costBasis: 70_000 }];

  const rng = makeRng(0x5EED);
  for (let i = 0; i < 200; i++) {
    const roll = rng();
    if (roll < 0.5) {
      const w = Math.min(a.balance * (0.05 + rng() * 0.3), a.balance - 1);
      if (w > 1) {
        svc.transaction(a, -w, null);
        svc.reduceLedgerForWithdrawal(a, w);
      }
    } else {
      const amt = 500 + rng() * 10_000;
      svc.transaction(a, +amt, null);
      a.contributionBasis += amt;
    }
    assertInvariants(a, `roth op ${i}`);
  }
});
