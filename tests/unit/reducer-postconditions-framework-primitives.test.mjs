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
 * Group A — the three framework-primitive reducers that lacked a confirmed
 * isolated test (design 37 §6 A). All are FieldReducer subclasses and I1-pure
 * (immutable setValueByPath / spread). Asserted I1 + I8 (field scope: write only
 * the declared path, no collateral state) + I2 (determinism) where tagged.
 *
 * RepeatingReducer runs its child reducers `count` times, threading one combined
 * state through every child and iteration and returning their merged emitted
 * actions (count<=0 is a no-op). Tested for that threading contract + I1.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { runReducer, assertStateUnchanged } from '../helpers/reducer-postconditions.js';
import { makeAction } from '../helpers/reducer-fixtures.js';
import {
  BalanceSnapshotReducer, RepeatingReducer, ScriptedReducer, PRIORITY,
} from '../../src/simulation-framework/reducers.js';

const DATE = new Date('2030-06-15');

// ─── BalanceSnapshotReducer (I1/I8) ────────────────────────────────────────────

test('BalanceSnapshotReducer: reads a dotted fieldPath and writes only metrics[metricKey] (I1/I8)', () => {
  const r = new BalanceSnapshotReducer();
  const state = { savingsAccount: { balance: 5000 }, metrics: { other: 1 } };
  const next = runReducer(r, state, makeAction('RECORD_BALANCE', { fieldPath: 'savingsAccount.balance', metricKey: 'savings' }), DATE);
  assert.equal(next.metrics.savings, 5000);
  assert.equal(next.metrics.other, 1, 'I8: existing metrics preserved');
  assert.deepEqual(next.savingsAccount, { balance: 5000 }, 'I8: source field untouched');
});

test('BalanceSnapshotReducer: absent fieldPath is a pure no-op (I8)', () => {
  const r = new BalanceSnapshotReducer();
  const prev = { savingsAccount: { balance: 5000 } };
  const next = runReducer(r, structuredClone(prev), makeAction('RECORD_BALANCE', {}), DATE);
  assertStateUnchanged(prev, next);
  assert.equal(next.metrics, undefined, 'no metrics written when fieldPath absent');
});

// ─── ScriptedReducer (I1/I2/I8) ────────────────────────────────────────────────

test('ScriptedReducer: fieldName set → writes the script result to that path (I1/I8)', () => {
  const r = new ScriptedReducer('Doubler', PRIORITY.POSITION_UPDATE, 'result', 'return action.value * 2;');
  const state = { foo: 1 };
  const next = runReducer(r, state, makeAction('ANYTHING', { value: 21 }), DATE);
  assert.equal(next.result, 42);
  assert.equal(next.foo, 1, 'I8: unrelated state untouched');
});

test('ScriptedReducer: no fieldName → returned object is spread into state (I8)', () => {
  const r = new ScriptedReducer('Patcher', PRIORITY.POSITION_UPDATE, '', 'return { flag: true, n: (state.n ?? 0) + 1 };');
  const next = runReducer(r, { n: 4 }, makeAction('ANYTHING'), DATE);
  assert.equal(next.flag, true);
  assert.equal(next.n, 5);
});

test('ScriptedReducer: deterministic (I2); a runtime error degrades to a no-op', () => {
  const r = new ScriptedReducer('Doubler', PRIORITY.POSITION_UPDATE, 'result', 'return action.value * 2;');
  const a = r.reduce({ foo: 1 }, makeAction('ANYTHING', { value: 21 }), DATE);
  const b = r.reduce({ foo: 1 }, makeAction('ANYTHING', { value: 21 }), DATE);
  assert.deepEqual(a, b);

  // A throwing script is caught and returns the unchanged state (no crash).
  const boom = new ScriptedReducer('Boom', PRIORITY.POSITION_UPDATE, 'result', 'throw new Error("kaboom");');
  const prev = { foo: 1 };
  const next = runReducer(boom, structuredClone(prev), makeAction('ANYTHING'), DATE);
  assertStateUnchanged(prev, next);
});

// ─── RepeatingReducer (I1/I8) ──────────────────────────────────────────────────

test('RepeatingReducer: count<=0 is a pure no-op (I1)', () => {
  const r = new RepeatingReducer('Repeat', PRIORITY.METRICS, [], 'value', 0);
  const prev = { foo: 1 };
  const next = runReducer(r, structuredClone(prev), makeAction('TICK'), DATE);
  assertStateUnchanged(prev, next);
});

test('RepeatingReducer: runs the whole child list N times, threading the combined state', () => {
  // Two children that each bump state.n — threading must propagate within and
  // across iterations: 2 children × 3 passes = 6 increments.
  const inc = { reduce: (s) => ({ ...s, n: (s.n ?? 0) + 1 }) };
  const r = new RepeatingReducer('Repeat', PRIORITY.METRICS, [inc, inc], 'value', 3);
  const next = runReducer(r, { n: 0 }, makeAction('TICK'), DATE);
  assert.equal(next.n, 6, 'each child modification propagates to the next child and pass');
});

test('RepeatingReducer: collects every child-emitted next action across all iterations', () => {
  // A child that mutates state AND emits a follow-up action each time it runs.
  const emitter = {
    reduce: (s) => ({ ...s, hits: (s.hits ?? 0) + 1, next: [{ type: 'CHILD_FOLLOWUP' }] }),
  };
  const r = new RepeatingReducer('Repeat', PRIORITY.METRICS, [emitter], 'value', 3);
  const next = runReducer(r, { hits: 0 }, makeAction('TICK'), DATE);
  assert.equal(next.hits, 3, 'state threaded across 3 passes');
  const followups = next.next.filter(a => a.type === 'CHILD_FOLLOWUP');
  assert.equal(followups.length, 3, 'one queued follow-up per pass — none dropped');
});

test('RepeatingReducer: reads the count from action[fieldName] when no fixed count is set', () => {
  const inc = { reduce: (s) => ({ ...s, n: (s.n ?? 0) + 1 }) };
  const r = new RepeatingReducer('Repeat', PRIORITY.METRICS, [inc], 'value', null); // count from action.value
  assert.equal(runReducer(r, { n: 0 }, makeAction('TICK', { value: 4 }), DATE).n, 4);
  // Absent action.value ⇒ count 0 ⇒ pure no-op.
  assertStateUnchanged({ n: 0 }, runReducer(r, { n: 0 }, makeAction('TICK'), DATE));
});
