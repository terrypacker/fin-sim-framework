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
 * reducers.test.mjs
 * Tests for ReducerPipeline and PRIORITY constants
 * Run with: node --test tests/reducers.test.mjs
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import { ReducerPipeline, PRIORITY } from '../assets/js/simulation-framework/reducers.js';

// ─── Registration & retrieval ─────────────────────────────────────────────────

test('ReducerPipeline: get on unregistered type returns empty array', () => {
  const p = new ReducerPipeline();
  assert.deepStrictEqual(p.get('UNKNOWN'), []);
});

test('ReducerPipeline: registered reducer is returned by get', () => {
  const p  = new ReducerPipeline();
  const fn = (state) => state;

  p.register('INC', fn);

  const entries = p.get('INC');
  assert.strictEqual(entries.length, 1);
  assert.strictEqual(entries[0].fn, fn);
});

test('ReducerPipeline: registered reducer carries the correct name', () => {
  const p = new ReducerPipeline();
  p.register('INC', (s) => s, 100, 'MyReducer');

  assert.strictEqual(p.get('INC')[0].name, 'MyReducer');
});

test('ReducerPipeline: default name is "anonymous"', () => {
  const p = new ReducerPipeline();
  p.register('INC', (s) => s);

  assert.strictEqual(p.get('INC')[0].name, 'anonymous');
});

test('ReducerPipeline: registered reducer carries the correct priority', () => {
  const p = new ReducerPipeline();
  p.register('INC', (s) => s, 42);

  assert.strictEqual(p.get('INC')[0].priority, 42);
});

test('ReducerPipeline: default priority is 100', () => {
  const p = new ReducerPipeline();
  p.register('INC', (s) => s);

  assert.strictEqual(p.get('INC')[0].priority, 100);
});

// ─── Multiple reducers per type ───────────────────────────────────────────────

test('ReducerPipeline: multiple reducers for same type are all returned', () => {
  const p  = new ReducerPipeline();
  const f1 = (s) => s;
  const f2 = (s) => s;

  p.register('INC', f1, 10);
  p.register('INC', f2, 20);

  const entries = p.get('INC');
  assert.strictEqual(entries.length, 2);
});

test('ReducerPipeline: reducers for same type are sorted ascending by priority', () => {
  const p = new ReducerPipeline();

  p.register('INC', () => 'C', 30, 'C');
  p.register('INC', () => 'A', 10, 'A');
  p.register('INC', () => 'B', 20, 'B');

  const names = p.get('INC').map(e => e.name);
  assert.deepStrictEqual(names, ['A', 'B', 'C']);
});

test('ReducerPipeline: adding a reducer re-sorts the list', () => {
  const p = new ReducerPipeline();

  p.register('INC', () => {}, 50, 'Mid');
  p.register('INC', () => {}, 90, 'Last');

  // Adding one with highest priority should move to front
  p.register('INC', () => {}, 10, 'First');

  const names = p.get('INC').map(e => e.name);
  assert.deepStrictEqual(names, ['First', 'Mid', 'Last']);
});

test('ReducerPipeline: reducers for different types are independent', () => {
  const p = new ReducerPipeline();

  p.register('A', () => {}, 1, 'ForA');
  p.register('B', () => {}, 1, 'ForB');

  assert.strictEqual(p.get('A').length, 1);
  assert.strictEqual(p.get('A')[0].name, 'ForA');

  assert.strictEqual(p.get('B').length, 1);
  assert.strictEqual(p.get('B')[0].name, 'ForB');
});

// ─── PRIORITY constants ───────────────────────────────────────────────────────

test('PRIORITY: all constants are numbers', () => {
  for (const [key, val] of Object.entries(PRIORITY)) {
    assert.strictEqual(
      typeof val, 'number',
      `PRIORITY.${key} should be a number`
    );
  }
});

test('PRIORITY: values are in strictly ascending order of processing stage', () => {
  assert.ok(PRIORITY.PRE_PROCESS    <  PRIORITY.CASH_FLOW);
  assert.ok(PRIORITY.CASH_FLOW      <  PRIORITY.POSITION_UPDATE);
  assert.ok(PRIORITY.POSITION_UPDATE < PRIORITY.COST_BASIS);
  assert.ok(PRIORITY.COST_BASIS     <  PRIORITY.TAX_CALC);
  assert.ok(PRIORITY.TAX_CALC       <  PRIORITY.TAX_APPLY);
  assert.ok(PRIORITY.TAX_APPLY      <  PRIORITY.METRICS);
  assert.ok(PRIORITY.METRICS        <  PRIORITY.LOGGING);
});
