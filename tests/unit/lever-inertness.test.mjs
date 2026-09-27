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
 * lever-inertness.test.mjs — design 114 §16: the cockpit's INERT verdicts, keyed by param for
 * the Optimize panel and the MC grid.
 *
 * LI-1  Each drawdown lever family maps to the gate that already decides it; others to none
 * LI-2  On a pooled plan every mapped lever is INERT, with the gate's OWN sentence
 * LI-3  Pools off, or pools that compile no order ⇒ nothing is inert
 * LI-4  The cockpit and these rows cannot disagree: same predicate for every row
 * LI-5  The Opt pool-size label leads with the pool id (C)
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import { inertLeverProblems, leverGateForParam, INERT_LEVER_KIND }
  from '../../src/finance/mpc/lever-inertness.js';
import { LEVER_SCHEDULE, leverRequirement } from '../../src/finance/mpc/lever-schedule.js';
import { poolTargetScaleLabel } from '../../src/finance/pools/pool-target-scale.js';

const POOLED = { liquidityGraph: { pools: [
  { id: 'cash',   spendOrder: 10, claims: [{ key: 'usSavingsAccount' }] },
  { id: 'growth', spendOrder: 40, claims: [{ key: 'usStockAccount', sleeves: ['EQUITY'] }] },
] } };
const KEYS = ['crossBorderDrawdown', 'withinTierDraw', 'drawdownWeight::ira', 'sleeveWeight::CASH',
              'drawdownStrategy', 'spendingRate'];

test('LI-1: each drawdown lever maps to the gate that decides it, and nothing else maps', () => {
  assert.deepEqual(KEYS.map(leverGateForParam), [
    'DRAWDOWN_XBORDER', 'DRAWDOWN_WITHINTIER', 'DRAWDOWN_WEIGHTS', 'DRAWDOWN_SLEEVE', null, null]);
  assert.equal(leverGateForParam(undefined), null);
});

test('LI-2: on a pooled plan every mapped lever is INERT, in the gate’s own words', () => {
  const rows = inertLeverProblems(KEYS, POOLED);
  assert.deepEqual(rows.map(r => r.param), KEYS.slice(0, 4));
  for (const r of rows) {
    assert.equal(r.kind, INERT_LEVER_KIND);
    assert.equal(r.severity, 'warn');
    assert.equal(r.message, leverRequirement(LEVER_SCHEDULE[r.gate], POOLED));
    assert.match(r.message, /liquidity graph compiles the drawdown order/);
  }
});

test('LI-3: pools off, or a graph that compiles no order, makes nothing inert', () => {
  assert.deepEqual(inertLeverProblems(KEYS, { ...POOLED, liquidityGraphEnabled: false }), []);
  const unordered = { liquidityGraph: { pools: [{ id: 'cash', claims: [{ key: 'usSavingsAccount' }] }] } };
  assert.deepEqual(inertLeverProblems(KEYS, unordered), []);
  assert.deepEqual(inertLeverProblems(KEYS, {}), []);
  assert.deepEqual(inertLeverProblems(null, POOLED), []);
});

test('LI-4: every row is the cockpit’s own verdict — same predicate, same bag', () => {
  for (const bp of [POOLED, {}, { ...POOLED, liquidityGraphEnabled: false }]) {
    for (const key of KEYS) {
      const gate = leverGateForParam(key);
      const cockpit = gate ? LEVER_SCHEDULE[gate].inertWhen(bp) : false;
      assert.equal(inertLeverProblems([key], bp).length === 1, !!cockpit, `${key} on ${JSON.stringify(bp).slice(0, 40)}`);
    }
  }
});

test('LI-5: the pool-size axis label leads with the pool id, the label after it', () => {
  const row = { poolId: 'buffer', label: 'Bucket 2', authored: [{ where: null, mode: 'YEARS_OF_SPEND', value: 5 }] };
  assert.match(poolTargetScaleLabel(row), /^Pool 'buffer \(Bucket 2\)' target × \(base 5y\)$/);
  assert.match(poolTargetScaleLabel({ ...row, label: 'buffer' }), /^Pool 'buffer' target/);
});
