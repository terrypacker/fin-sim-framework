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

// ─── CGT cost-base indexation (design 57 §6.3) ───────────────────────────────

/** AU holding lot carrying a per-country AU cost base and an acquisition level. */
function auLot({ id, mv, basis, auBasis, level, date }) {
  return new Holding({
    id, allocation: ALLOCATION.EQUITY, marketValue: mv, costBasis: basis,
    costBaseByCountry: { AU: auBasis }, acquisitionPriceLevel: level,
    purchaseDate: date, rateKey: RATE,
  });
}

test('FIFO indexation: absent context ⇒ no indexed tally', () => {
  const r = consumeHoldingsFifo([auLot({ id: 'a', mv: 1000, basis: 800, auBasis: 800, level: 1.0, date: D(2020) })], 1000);
  assert.deepEqual(r.realizedIndexedBasisByCountry, {});
});

test('FIFO indexation: lot held >12mo indexes AU basis up by the CPI ratio', () => {
  const lot = auLot({ id: 'a', mv: 1000, basis: 800, auBasis: 800, level: 1.0, date: D(2020) });
  const r = consumeHoldingsFifo([lot], 1000, { level: 1.5, asOfMs: D(2030).getTime(), country: 'AU' });
  assert.equal(r.realizedBasisByCountry.AU, 800);          // un-indexed
  assert.equal(r.realizedIndexedBasisByCountry.AU, 1200);  // 800 × (1.5 / 1.0)
});

test('FIFO indexation: lot held <12mo is not indexed (factor 1)', () => {
  const lot = auLot({ id: 'a', mv: 1000, basis: 800, auBasis: 800, level: 1.0, date: D(2030, 0, 1) });
  const r = consumeHoldingsFifo([lot], 1000, { level: 1.5, asOfMs: D(2030, 5, 1).getTime(), country: 'AU' });
  assert.equal(r.realizedIndexedBasisByCountry.AU, 800);   // <12 months held
});

test('FIFO indexation: lot with no acquisition level is not indexed', () => {
  const lot = auLot({ id: 'a', mv: 1000, basis: 800, auBasis: 800, level: null, date: D(2020) });
  const r = consumeHoldingsFifo([lot], 1000, { level: 1.5, asOfMs: D(2030).getTime(), country: 'AU' });
  assert.equal(r.realizedIndexedBasisByCountry.AU, 800);
});

test('FIFO indexation: factor is clamped ≥1 (deflation never lowers basis)', () => {
  const lot = auLot({ id: 'a', mv: 1000, basis: 800, auBasis: 800, level: 2.0, date: D(2020) });
  const r = consumeHoldingsFifo([lot], 1000, { level: 1.5, asOfMs: D(2030).getTime(), country: 'AU' });
  assert.equal(r.realizedIndexedBasisByCountry.AU, 800);   // max(1, 1.5/2.0) = 1
});

// ─── CPI back-cast for an authored lot (design 57 §6.3 / §Part 4) ────────────
//
// A lot the plan already owned when the run began has a real acquisition date but no
// stamped `acquisitionPriceLevel`: the accumulator is 1.0 at sim start and knows nothing
// about the years before it. Scalar assets (a house, a vested stake, bullion) have
// back-cast the missing factor from the acquisition date since design 57 Part 4; lots
// could not, because nothing could author a `purchaseDate` on one. These pin the rule
// now that the account editor can.
//
// The gate is a STATED acquisition, not a stamped level: relief follows a date the
// author supplied, and an undated lot still indexes at 1.

test('FIFO indexation back-cast: an authored lot with a DATE but no level indexes off cpiRate', () => {
  const lot = auLot({ id: 'a', mv: 1000, basis: 800, auBasis: 800, level: null, date: D(2020) });
  const r = consumeHoldingsFifo([lot], 1000,
    { level: 1.5, asOfMs: D(2030).getTime(), country: 'AU', cpiRate: 0.03 });
  // 10 years at 3% ⇒ 1.03^10 = 1.343916…; basis 800 × that.
  const years  = (D(2030).getTime() - D(2020).getTime()) / (365 * 24 * 60 * 60 * 1000);
  const want   = 800 * (1.03 ** years);
  // The tally is rounded to cents, so compare to the cent rather than to the float.
  assert.ok(Math.abs(r.realizedIndexedBasisByCountry.AU - want) < 0.01,
    `${r.realizedIndexedBasisByCountry.AU} vs ${want}`);
  assert.ok(r.realizedIndexedBasisByCountry.AU > 800);   // relief actually granted
  assert.equal(r.realizedBasisByCountry.AU, 800);        // un-indexed tally untouched
});

test('FIFO indexation back-cast: an UNDATED lot is still not indexed', () => {
  // The regression this guards: `_purchaseTs` reads a null date as epoch 0, so a naive
  // back-cast would compound CPI over ~60 years and hand a boot lot enormous relief off
  // a MISSING field. Silence must stay silence.
  const lot = auLot({ id: 'a', mv: 1000, basis: 800, auBasis: 800, level: null, date: null });
  const r = consumeHoldingsFifo([lot], 1000,
    { level: 1.5, asOfMs: D(2030).getTime(), country: 'AU', cpiRate: 0.03 });
  assert.equal(r.realizedIndexedBasisByCountry.AU, 800);
});

test('FIFO indexation back-cast: a stamped level still WINS over the back-cast', () => {
  // Branch order matters — the stamped level is observed, the back-cast is a proxy.
  const lot = auLot({ id: 'a', mv: 1000, basis: 800, auBasis: 800, level: 1.0, date: D(2020) });
  const r = consumeHoldingsFifo([lot], 1000,
    { level: 1.5, asOfMs: D(2030).getTime(), country: 'AU', cpiRate: 0.30 });
  assert.equal(r.realizedIndexedBasisByCountry.AU, 1200);  // 800 × 1.5/1.0, not 1.30^10
});

test('FIFO indexation back-cast: absent cpiRate reproduces the pre-change numbers', () => {
  const lot = auLot({ id: 'a', mv: 1000, basis: 800, auBasis: 800, level: null, date: D(2020) });
  const r = consumeHoldingsFifo([lot], 1000, { level: 1.5, asOfMs: D(2030).getTime(), country: 'AU' });
  assert.equal(r.realizedIndexedBasisByCountry.AU, 800);
});

test('FIFO indexation back-cast: a dated lot held <12mo is still not indexed', () => {
  const lot = auLot({ id: 'a', mv: 1000, basis: 800, auBasis: 800, level: null, date: D(2030, 0, 1) });
  const r = consumeHoldingsFifo([lot], 1000,
    { level: 1.5, asOfMs: D(2030, 5, 1).getTime(), country: 'AU', cpiRate: 0.03 });
  assert.equal(r.realizedIndexedBasisByCountry.AU, 800);
});
