/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import { Holding }    from '../../src/finance/holdings/holding.js';
import { ALLOCATION } from '../../src/finance/holdings/allocation.js';
import { consumeHoldingsFifo } from '../../src/finance/holdings/holdings-fifo.js';

const RATE = 'EQUITY_US';
const D    = (y, m = 0, d = 1) => new Date(Date.UTC(y, m, d));

function holding({ id, mv, basis, date, alloc = ALLOCATION.EQUITY }) {
  return new Holding({
    id, allocation: alloc, marketValue: mv, costBasis: basis,
    purchaseDate: date, rateKey: RATE,
  });
}

// ─── Basic FIFO consumption ──────────────────────────────────────────────────

test('FIFO: consumes single holding fully', () => {
  const holdings = [holding({ id: 'h1', mv: 1000, basis: 800, date: D(2020) })];
  const r = consumeHoldingsFifo(holdings, 1000);
  assert.equal(r.consumed, 1000);
  assert.equal(r.realizedBasis, 800);
  assert.equal(r.newHoldings.length, 0);
});

test('FIFO: consumes single holding partially — pro-rata basis', () => {
  const holdings = [holding({ id: 'h1', mv: 1000, basis: 800, date: D(2020) })];
  const r = consumeHoldingsFifo(holdings, 400);
  assert.equal(r.consumed, 400);
  assert.equal(r.realizedBasis, 320);  // 800 × (400/1000)
  assert.equal(r.newHoldings.length, 1);
  assert.equal(r.newHoldings[0].marketValue, 600);
  assert.equal(r.newHoldings[0].costBasis, 480);
});

test('FIFO: oldest first', () => {
  const holdings = [
    holding({ id: 'h_new', mv: 500, basis: 500, date: D(2022) }),
    holding({ id: 'h_old', mv: 500, basis: 100, date: D(2018) }),
  ];
  // Sell 300 — comes from h_old (cheapest basis); realizedBasis = 100 × 300/500 = 60.
  const r = consumeHoldingsFifo(holdings, 300);
  assert.equal(r.consumed, 300);
  assert.equal(r.realizedBasis, 60);
  // h_old reduced; h_new untouched.
  const surviving = r.newHoldings.find(h => h.id === 'h_old');
  assert.ok(surviving);
  assert.equal(surviving.marketValue, 200);
  assert.equal(surviving.costBasis, 40);
});

test('FIFO: spans multiple lots — basis accumulates', () => {
  const holdings = [
    holding({ id: 'h_old', mv: 200, basis: 100, date: D(2018) }),
    holding({ id: 'h_mid', mv: 300, basis: 250, date: D(2020) }),
    holding({ id: 'h_new', mv: 500, basis: 500, date: D(2022) }),
  ];
  // Sell 400 — h_old fully consumed (200, basis=100), h_mid partially (200/300=2/3 → basis=250×2/3≈166.67)
  const r = consumeHoldingsFifo(holdings, 400);
  assert.equal(r.consumed, 400);
  assert.ok(Math.abs(r.realizedBasis - (100 + 166.67)) < 0.01);
  // h_old dropped, h_mid reduced, h_new untouched.
  assert.equal(r.newHoldings.length, 2);
  const mid = r.newHoldings.find(h => h.id === 'h_mid');
  const newH = r.newHoldings.find(h => h.id === 'h_new');
  assert.equal(mid.marketValue, 100);  // 300 - 200
  assert.ok(Math.abs(mid.costBasis - 83.33) < 0.01);
  assert.equal(newH.marketValue, 500);
});

test('FIFO: null purchaseDate sorts first (carried-in lots)', () => {
  const holdings = [
    holding({ id: 'h_dated', mv: 500, basis: 400, date: D(2022) }),
    holding({ id: 'h_null',  mv: 500, basis: 100, date: null }),
  ];
  // Sell 300 — null-date lot is "oldest", consumed first; realizedBasis = 100 × 300/500 = 60.
  const r = consumeHoldingsFifo(holdings, 300);
  assert.equal(r.consumed, 300);
  assert.equal(r.realizedBasis, 60);
});

test('FIFO: amount exceeds total holdings — consumed equals available', () => {
  const holdings = [holding({ id: 'h1', mv: 100, basis: 80, date: D(2020) })];
  const r = consumeHoldingsFifo(holdings, 500);
  assert.equal(r.consumed, 100);
  assert.equal(r.realizedBasis, 80);
  assert.equal(r.newHoldings.length, 0);
});

test('FIFO: zero amount is a no-op', () => {
  const holdings = [holding({ id: 'h1', mv: 1000, basis: 800, date: D(2020) })];
  const r = consumeHoldingsFifo(holdings, 0);
  assert.equal(r.consumed, 0);
  assert.equal(r.realizedBasis, 0);
  assert.equal(r.newHoldings.length, 1);
  assert.equal(r.newHoldings[0].marketValue, 1000);
});

test('FIFO: empty holdings is a no-op', () => {
  const r = consumeHoldingsFifo([], 1000);
  assert.equal(r.consumed, 0);
  assert.equal(r.realizedBasis, 0);
  assert.equal(r.newHoldings.length, 0);
});

test('FIFO: zero-marketValue holding skipped', () => {
  const holdings = [
    holding({ id: 'h_empty', mv: 0, basis: 0, date: D(2018) }),
    holding({ id: 'h_real',  mv: 500, basis: 400, date: D(2020) }),
  ];
  const r = consumeHoldingsFifo(holdings, 300);
  assert.equal(r.consumed, 300);
  // basis from h_real only
  assert.equal(r.realizedBasis, 240);  // 400 × 300/500
});
