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
 * EVT-Scenario-Compare: state-panel diff rendering.
 *
 * Tests the pure `computeStateDiff` and `flattenNumericState` utilities without
 * any DOM or ServiceRegistry dependency.
 */

import { test }  from 'node:test';
import assert    from 'node:assert/strict';

import {
  flattenNumericState,
  computeStateDiff,
} from '../../src/finance/scenario-compare/scenario-compare-utils.js';

// ── flattenNumericState ───────────────────────────────────────────────────────

test('flattenNumericState: extracts top-level numbers', () => {
  const state = { balance: 1000, rate: 0.05, name: 'Alice' };
  const flat  = flattenNumericState(state);
  assert.strictEqual(flat.balance, 1000);
  assert.strictEqual(flat.rate, 0.05);
  assert.ok(!('name' in flat), 'non-numeric keys should be excluded');
});

test('flattenNumericState: flattens nested objects with dot notation', () => {
  const state = { rothAccount: { balance: 50000, shares: 100 }, iraAccount: { balance: 80000 } };
  const flat  = flattenNumericState(state);
  assert.strictEqual(flat['rothAccount.balance'], 50000);
  assert.strictEqual(flat['rothAccount.shares'],  100);
  assert.strictEqual(flat['iraAccount.balance'],  80000);
});

test('flattenNumericState: skips Date objects', () => {
  const state = { someDate: new Date(2026, 0, 1), balance: 100 };
  const flat  = flattenNumericState(state);
  assert.ok(!('someDate' in flat));
  assert.strictEqual(flat.balance, 100);
});

test('flattenNumericState: skips arrays', () => {
  const state = { items: [1, 2, 3], balance: 999 };
  const flat  = flattenNumericState(state);
  assert.ok(!('items' in flat));
  assert.strictEqual(flat.balance, 999);
});

test('flattenNumericState: skips _ prefixed keys', () => {
  const state = { _internal: 42, balance: 500 };
  const flat  = flattenNumericState(state);
  assert.ok(!('_internal' in flat));
  assert.strictEqual(flat.balance, 500);
});

test('flattenNumericState: excludes non-finite numbers (NaN, Infinity)', () => {
  const state = { a: NaN, b: Infinity, c: 123 };
  const flat  = flattenNumericState(state);
  assert.ok(!('a' in flat));
  assert.ok(!('b' in flat));
  assert.strictEqual(flat.c, 123);
});

test('flattenNumericState: handles empty object', () => {
  const flat = flattenNumericState({});
  assert.deepEqual(flat, {});
});

test('flattenNumericState: handles null/undefined gracefully', () => {
  assert.deepEqual(flattenNumericState(null), {});
  assert.deepEqual(flattenNumericState(undefined), {});
});

// ── computeStateDiff ─────────────────────────────────────────────────────────

test('computeStateDiff: identical states produce zero deltas', () => {
  const state = { rothAccount: { balance: 50000 }, usStock: { balance: 20000 } };
  const diff  = computeStateDiff(state, state);
  for (const row of diff) {
    assert.strictEqual(row.delta, 0, `expected delta 0 for ${row.field}`);
    assert.strictEqual(row.a, row.b, `a and b should match for ${row.field}`);
  }
});

test('computeStateDiff: delta is B minus A', () => {
  const stateA = { balance: 100 };
  const stateB = { balance: 160 };
  const diff   = computeStateDiff(stateA, stateB);
  const row    = diff.find(r => r.field === 'balance');
  assert.ok(row, 'balance row should exist');
  assert.strictEqual(row.a,     100);
  assert.strictEqual(row.b,     160);
  assert.strictEqual(row.delta, 60);
});

test('computeStateDiff: field only in A has null b and null delta', () => {
  const stateA = { onlyA: 999 };
  const stateB = {};
  const diff   = computeStateDiff(stateA, stateB);
  const row    = diff.find(r => r.field === 'onlyA');
  assert.ok(row);
  assert.strictEqual(row.a,     999);
  assert.strictEqual(row.b,     null);
  assert.strictEqual(row.delta, null);
});

test('computeStateDiff: field only in B has null a and null delta', () => {
  const stateA = {};
  const stateB = { onlyB: 777 };
  const diff   = computeStateDiff(stateA, stateB);
  const row    = diff.find(r => r.field === 'onlyB');
  assert.ok(row);
  assert.strictEqual(row.a,     null);
  assert.strictEqual(row.b,     777);
  assert.strictEqual(row.delta, null);
});

test('computeStateDiff: results are sorted alphabetically', () => {
  const stateA = { z: 1, a: 2, m: 3 };
  const stateB = { z: 1, a: 2, m: 3 };
  const diff   = computeStateDiff(stateA, stateB);
  const fields = diff.map(r => r.field);
  assert.deepEqual(fields, [...fields].sort());
});

test('computeStateDiff: nested fields are dot-notation', () => {
  const stateA = { rothAccount: { balance: 50000 } };
  const stateB = { rothAccount: { balance: 55000 } };
  const diff   = computeStateDiff(stateA, stateB);
  const row    = diff.find(r => r.field === 'rothAccount.balance');
  assert.ok(row, 'nested field should appear in diff');
  assert.strictEqual(row.delta, 5000);
});

test('computeStateDiff: both empty states produce empty diff', () => {
  const diff = computeStateDiff({}, {});
  assert.deepEqual(diff, []);
});

test('computeStateDiff: null/undefined states produce empty diff', () => {
  const diff = computeStateDiff(null, undefined);
  assert.deepEqual(diff, []);
});
