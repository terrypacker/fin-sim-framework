/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import test   from 'node:test';
import assert from 'node:assert/strict';

import {
  snapshotHoldings,
  totalSnapshot,
  groupSnapshotByAllocation,
  UNALLOCATED,
} from '../../src/finance/holdings/holding-activity.js';

// ─── groupSnapshotByAllocation — the rollup behind the Holdings mix charts ─────
//
// The charts group by ALLOCATION class rather than by holding because a bond ladder
// is one holding per rung: a per-holding pie of a laddered account is twenty slivers
// that all mean "bonds". Everything here is about that rollup staying honest — it
// feeds a chart, and a chart is read at a glance with no chance to check the maths.

const h = (allocation, marketValue, costBasis, label = allocation) =>
  ({ allocation, marketValue, costBasis, label });

test('rollup: holdings of one class sum into a single group', () => {
  const rows = snapshotHoldings({ holdings: [
    h('BOND', 100, 90, 'rung 2028'),
    h('BOND', 200, 210, 'rung 2029'),
    h('BOND', 300, 280, 'rung 2030'),
  ] });

  const groups = groupSnapshotByAllocation(rows);
  assert.equal(groups.length, 1, 'a ladder is one BOND slice, not three');
  assert.deepEqual(
    { ...groups[0] },
    { allocation: 'BOND', marketValue: 600, costBasis: 580, unrealized: 20, count: 3 },
  );
});

test('rollup: totals tie to the table footer exactly', () => {
  // The charts sit directly above the snapshot table. If the donut's total and the
  // table's Total row disagree by even a cent, the panel contradicts itself on screen.
  const rows = snapshotHoldings({ holdings: [
    h('EQUITY', 1_234.56, 1_000.01),
    h('BOND',     567.89,   600.02),
    h('CASH',     100.00,   100.00),
    h('GOLD',      42.42,    50.50),
  ] });

  const foot   = totalSnapshot(rows);
  const groups = groupSnapshotByAllocation(rows);
  const sum = groups.reduce((a, g) => ({
    marketValue: a.marketValue + g.marketValue,
    costBasis:   a.costBasis   + g.costBasis,
    unrealized:  a.unrealized  + g.unrealized,
  }), { marketValue: 0, costBasis: 0, unrealized: 0 });

  assert.ok(Math.abs(sum.marketValue - foot.marketValue) < 0.005, 'market value ties');
  assert.ok(Math.abs(sum.costBasis   - foot.costBasis)   < 0.005, 'cost basis ties');
  assert.ok(Math.abs(sum.unrealized  - foot.unrealized)  < 0.005, 'unrealized ties');
});

test('rollup: order follows the allocation enum, not size', () => {
  // A legend that reorders itself between two sim steps is how a colour stops being an
  // identity, so position must not track the mix.
  const rows = snapshotHoldings({ holdings: [
    h('GOLD',   900, 400),
    h('CASH',   800, 800),
    h('BOND',   700, 700),
    h('EQUITY',  10,  10),
  ] });

  assert.deepEqual(
    groupSnapshotByAllocation(rows).map(g => g.allocation),
    ['EQUITY', 'BOND', 'CASH', 'GOLD'],
    'enum order holds even when EQUITY is the smallest position',
  );
});

test('rollup: a loss stays negative and is not folded into a gain', () => {
  // The G/L chart is the whole reason the sign matters: two classes that cancel to
  // zero in aggregate are two bars pointing opposite ways, not one absent bar.
  const rows = snapshotHoldings({ holdings: [
    h('EQUITY', 1_500, 1_000),
    h('BOND',     500, 1_000),
  ] });

  const [eq, bond] = groupSnapshotByAllocation(rows);
  assert.equal(eq.unrealized,   500);
  assert.equal(bond.unrealized, -500);
  assert.equal(totalSnapshot(rows).unrealized, 0, 'they net to zero in aggregate');
});

test('rollup: an unallocated holding is bucketed, never dropped', () => {
  // snapshotHoldings also reads plain state objects (older persisted state, tests)
  // where `allocation` can be absent. A slice silently missing from a mix chart is
  // worse than one labelled UNKNOWN.
  const rows = snapshotHoldings({ holdings: [
    h('EQUITY', 100, 80),
    { marketValue: 25, costBasis: 25 },
  ] });

  const groups = groupSnapshotByAllocation(rows);
  assert.deepEqual(groups.map(g => g.allocation), ['EQUITY', UNALLOCATED]);
  assert.equal(groups[1].marketValue, 25);
});

test('rollup: an emptied class drops out, but a zero-value class with G/L is kept', () => {
  const drained = groupSnapshotByAllocation(snapshotHoldings({ holdings: [
    h('EQUITY', 100, 80),
    h('CASH',     0,   0),
  ] }));
  assert.deepEqual(drained.map(g => g.allocation), ['EQUITY'], 'dust is not a slice');

  // A position written down to nothing while still carrying basis is a real (and
  // usually surprising) fact about the account — a total loss, and the G/L chart's
  // most important bar.
  const wipedOut = groupSnapshotByAllocation(snapshotHoldings({ holdings: [
    h('EQUITY', 100, 80),
    h('GOLD',     0, 500),
  ] }));
  assert.deepEqual(wipedOut.map(g => g.allocation), ['EQUITY', 'GOLD']);
  assert.equal(wipedOut[1].unrealized, -500);
});

test('rollup: no holdings yields no groups', () => {
  assert.deepEqual(groupSnapshotByAllocation(snapshotHoldings({ holdings: [] })), []);
  assert.deepEqual(groupSnapshotByAllocation([]), []);
  assert.deepEqual(groupSnapshotByAllocation(null), []);
});
