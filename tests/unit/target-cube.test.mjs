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
 * target-cube.test.mjs — design 82 §7.
 *
 * The whole risk in this module is arithmetic that looks right and isn't.
 * `targetComposition` is stamped as fractions **of each account's own holdings total**,
 * so the two ways to get an aggregate wrong are:
 *
 *   1. averaging the fractions (treating a $10k account like a $10m one), and
 *   2. weighting them by the wrong denominator (net worth, say, which includes a house
 *      no target covers).
 *
 * Both produce a plausible-looking mix, which is why the aggregate is pinned here against
 * a hand-computed answer rather than against the code's own output. The reference case is
 * design 61's LOCATED mode, where per-account targets are deliberately extreme (100% gold
 * in a 401k) and only the aggregate is meant to resemble the portfolio target.
 */

import { test }   from 'node:test';
import assert     from 'node:assert/strict';
import { buildTargetCube, targetedStateKeys, driftAgainstTarget } from '../../src/finance/allocation-reporting/target-cube.js';
import { buildAllocationSeries, mixAt } from '../../src/finance/allocation-reporting/allocation-grouping.js';

const DATE = new Date(Date.UTC(2040, 11, 31));

const holding = (allocation, marketValue) => ({ allocation, marketValue, rateKey: null });

/** LOCATED targeting: equity in the brokerage, bonds in the IRA, gold in the 401k. */
function locatedState() {
  return {
    usStockAccount: {
      balance: 800_000, role: 'us-stock', country: 'US', currency: { code: 'USD' },
      holdings: [holding('EQUITY', 800_000)],
      targetComposition: { EQUITY: 1, BOND: 0, CASH: 0, GOLD: 0 },
      targetBand: 0.1,
    },
    iraAccount: {
      balance: 200_000, role: 'ira', country: 'US', currency: { code: 'USD' },
      holdings: [holding('BOND', 150_000), holding('CASH', 50_000)],
      targetComposition: { EQUITY: 0, BOND: 1, CASH: 0, GOLD: 0 },
      targetBand: 0.02,
    },
    // No target: the rebalancer does not manage a house.
    auHouseProperty: { kind: 'real-property', value: 1_000_000, country: 'AU', currency: 'AUD' },
  };
}

test('a target row carries DOLLARS — weight × the account’s own holdings total', () => {
  const rows = buildTargetCube(locatedState(), { date: DATE });

  const brokerageEquity = rows.find(r => r.stateKey === 'usStockAccount' && r.assetClass === 'EQUITY');
  assert.equal(brokerageEquity.marketValue, 800_000);
  assert.equal(brokerageEquity.targetWeight, 1);
  assert.equal(brokerageEquity.source, 'target');

  // The IRA is targeted 100% BOND against a $200k holdings total — including the $50k
  // sitting in CASH, which is the drift the rebalancer is supposed to correct.
  const iraBond = rows.find(r => r.stateKey === 'iraAccount' && r.assetClass === 'BOND');
  assert.equal(iraBond.marketValue, 200_000);
  const iraCash = rows.find(r => r.stateKey === 'iraAccount' && r.assetClass === 'CASH');
  assert.equal(iraCash.marketValue, 0, 'a zero-weight class is emitted, not omitted');
});

test('the aggregate target is value-weighted, so LOCATED accounts compose to the portfolio mix', () => {
  const rows = buildTargetCube(locatedState(), { date: DATE });
  const mix  = mixAt(rows);

  // $800k equity + $200k bond over a $1.0m targeted book = 80/20. Averaging the two
  // accounts' fractions instead would give 50/50 — the mistake this pins.
  assert.equal(+mix.EQUITY.toFixed(6), 0.8);
  assert.equal(+mix.BOND.toFixed(6), 0.2);
  assert.ok(!('REAL_ESTATE' in mix), 'the house has no target and must not appear');
});

test('the house is excluded from the target set, so it cannot enter the comparison', () => {
  const rows = buildTargetCube(locatedState(), { date: DATE });
  const keys = targetedStateKeys(rows);

  assert.deepEqual([...keys].sort(), ['iraAccount', 'usStockAccount']);
  assert.ok(!keys.has('auHouseProperty'));
});

test('a drained account’s stale target is ignored', () => {
  // The reducer stamps only accounts with a positive holdings total and never CLEARS a
  // stamp, so a fully drawn-down account keeps its last target forever. Emitting it would
  // draw a target for an account holding nothing.
  const state = locatedState();
  state.usStockAccount.holdings = [];
  state.usStockAccount.balance  = 0;

  const rows = buildTargetCube(state, { date: DATE });
  assert.ok(!rows.some(r => r.stateKey === 'usStockAccount'));
  // And the aggregate re-weights onto what is actually left.
  assert.equal(+mixAt(rows).BOND.toFixed(6), 1);
});

test('a foreign-currency account is weighted in the base currency, not its own', () => {
  const state = {
    auStockAccount: {
      balance: 300_000, role: 'au-stock', country: 'AU', currency: { code: 'AUD' },
      holdings: [holding('EQUITY', 300_000)],
      targetComposition: { EQUITY: 1 },
      targetBand: 0.1,
    },
    usStockAccount: {
      balance: 200_000, role: 'us-stock', country: 'US', currency: { code: 'USD' },
      holdings: [holding('BOND', 200_000)],
      targetComposition: { BOND: 1 },
      targetBand: 0.1,
    },
    effectiveExchangeRates: { USD_AUD: 1.5 },
  };

  const rows = buildTargetCube(state, { date: DATE });
  const au   = rows.find(r => r.stateKey === 'auStockAccount');
  assert.equal(au.marketValueLocal, 300_000, 'local stays native');
  assert.equal(au.marketValue, 200_000, 'AUD 300k at USD_AUD 1.5 is USD 200k');

  // 50/50 in USD. Skipping the conversion would have made it 60/40.
  const mix = mixAt(rows);
  assert.equal(+mix.EQUITY.toFixed(6), 0.5);
  assert.equal(+mix.BOND.toFixed(6), 0.5);
});

test('target rows pivot through the SAME grouping module as the realized cube', () => {
  const rows = buildTargetCube(locatedState(), { date: DATE });
  const built = buildAllocationSeries(rows, { normalize: true });

  assert.deepEqual(built.dates.map(d => d.toISOString().slice(0, 10)), ['2040-12-31']);
  assert.deepEqual(built.keys, ['EQUITY', 'BOND']);   // canonical class order, zeros dropped
  assert.equal(+built.series.EQUITY[0].toFixed(6), 0.8);
});

test('drift is realized − target, and a breach uses the reducer’s own band', () => {
  const rows = buildTargetCube(locatedState(), { date: DATE });
  // Realized: the IRA still holds 25% cash against a 100%-bond target.
  const realized = { EQUITY: 0.80, BOND: 0.15, CASH: 0.05 };
  const target   = mixAt(rows);

  const { rows: drift, band } = driftAgainstTarget(realized, target, rows);

  // The tightest band across the compared accounts (sheltered 0.02, not taxable 0.1):
  // reporting the loosest would understate how far out of policy the book is.
  assert.equal(band, 0.02);

  const byKey = Object.fromEntries(drift.map(d => [d.key, d]));
  assert.equal(+byKey.BOND.drift.toFixed(6), -0.05);
  assert.equal(byKey.BOND.breach, true);
  assert.equal(+byKey.EQUITY.drift.toFixed(6), 0);
  assert.equal(byKey.EQUITY.breach, false);
  // A class held but not targeted at all is still a breach — design 61 §12.1 D2 was
  // exactly the drift check being blind to a zero-target class.
  assert.equal(byKey.CASH.target, 0);
  assert.equal(byKey.CASH.breach, true);
  // Ordered by how far out it is, so the worst offender reads first.
  assert.equal(drift[0].key, 'BOND');
});

test('no target anywhere yields no rows rather than a zero-drift fiction', () => {
  const state = {
    usStockAccount: { balance: 100, role: 'us-stock', holdings: [holding('EQUITY', 100)] },
  };
  assert.deepEqual(buildTargetCube(state, { date: DATE }), []);
  assert.equal(targetedStateKeys(buildTargetCube(state, { date: DATE })).size, 0);
});
