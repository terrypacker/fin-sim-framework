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
 * EVT-Decision-Graph: cartesian expansion.
 *
 * Tests the pure _expandLeaves / cartesian-product logic of DecisionGraphRunner
 * without running any simulation.
 */

import { test }  from 'node:test';
import assert    from 'node:assert/strict';

import { DecisionGraphRunner } from '../../src/finance/decision-graph/decision-graph-runner.js';

function runner() {
  return new DecisionGraphRunner({});
}

function dp(id, paramKey, values) {
  return {
    id, label: id, paramKey,
    options: values.map(v => ({ value: v, label: String(v) })),
    weights: null,
  };
}

// ── Empty decision points ─────────────────────────────────────────────────

test('expandLeaves: empty points → one Base leaf', () => {
  const leaves = runner()._expandLeaves([]);
  assert.equal(leaves.length, 1);
  assert.deepEqual(leaves[0].params, {});
  assert.equal(leaves[0].label, 'Base');
});

test('expandLeaves: null points → one Base leaf', () => {
  const leaves = runner()._expandLeaves(null);
  assert.equal(leaves.length, 1);
});

// ── Single decision point ─────────────────────────────────────────────────

test('expandLeaves: 1 point 2 options → 2 leaves', () => {
  const leaves = runner()._expandLeaves([dp('a', 'aKey', [1, 2])]);
  assert.equal(leaves.length, 2);
  assert.equal(leaves[0].params.aKey, 1);
  assert.equal(leaves[1].params.aKey, 2);
});

test('expandLeaves: 1 point 3 options → 3 leaves', () => {
  const leaves = runner()._expandLeaves([dp('a', 'aKey', [62, 67, 70])]);
  assert.equal(leaves.length, 3);
  const values = leaves.map(l => l.params.aKey);
  assert.deepEqual(values, [62, 67, 70]);
});

// ── Cartesian product ─────────────────────────────────────────────────────

test('expandLeaves: 2×2 → 4 leaves', () => {
  const leaves = runner()._expandLeaves([
    dp('a', 'aKey', [1, 2]),
    dp('b', 'bKey', [3, 4]),
  ]);
  assert.equal(leaves.length, 4);
  const vectors = leaves.map(l => l.optionVector);
  assert.ok(vectors.some(v => v.a === 1 && v.b === 3), 'missing (1,3)');
  assert.ok(vectors.some(v => v.a === 1 && v.b === 4), 'missing (1,4)');
  assert.ok(vectors.some(v => v.a === 2 && v.b === 3), 'missing (2,3)');
  assert.ok(vectors.some(v => v.a === 2 && v.b === 4), 'missing (2,4)');
});

test('expandLeaves: 3×3 → 9 leaves', () => {
  const leaves = runner()._expandLeaves([
    dp('a', 'aKey', [1, 2, 3]),
    dp('b', 'bKey', [4, 5, 6]),
  ]);
  assert.equal(leaves.length, 9);
});

test('expandLeaves: 2×2×2 → 8 leaves', () => {
  const leaves = runner()._expandLeaves([
    dp('a', 'aKey', [0, 1]),
    dp('b', 'bKey', [0, 1]),
    dp('c', 'cKey', [0, 1]),
  ]);
  assert.equal(leaves.length, 8);
});

// ── Leaf contents ─────────────────────────────────────────────────────────

test('expandLeaves: each leaf params contains all decision point overrides', () => {
  const leaves = runner()._expandLeaves([
    dp('a', 'aKey', [10, 20]),
    dp('b', 'bKey', [100]),
  ]);
  for (const leaf of leaves) {
    assert.ok('aKey' in leaf.params, 'leaf should have aKey');
    assert.ok('bKey' in leaf.params, 'leaf should have bKey');
  }
});

test('expandLeaves: optionVector matches params values', () => {
  const leaves = runner()._expandLeaves([
    dp('ssAge', 'primarySsClaimAge', [62, 67, 70]),
  ]);
  for (const leaf of leaves) {
    const v = leaf.optionVector.ssAge;
    assert.equal(leaf.params.primarySsClaimAge, v);
  }
});

test('expandLeaves: leaf labels include decision labels', () => {
  const leaves = runner()._expandLeaves([dp('a', 'aKey', [1, 2])]);
  for (const leaf of leaves) {
    assert.match(leaf.label, /a=/);
  }
});

// ── DERIVES_FROM option vector structure ──────────────────────────────────

test('expandLeaves: 2×2 all option vectors are distinct', () => {
  const leaves = runner()._expandLeaves([
    dp('a', 'aKey', [1, 2]),
    dp('b', 'bKey', [3, 4]),
  ]);
  const vectors = leaves.map(l => JSON.stringify(l.optionVector));
  const unique  = new Set(vectors);
  assert.equal(unique.size, 4, 'all leaves should have distinct option vectors');
});
