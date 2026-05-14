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

import { AccumulateDeficitReducer } from '../../src/finance/reducers/accumulate-deficit-reducer.js';

function makeState(overrides = {}) {
  return { cumulativeDeficit: 0, deficitMonths: 0, otherField: 99, ...overrides };
}

test('AccumulateDeficitReducer: increments cumulativeDeficit by action.amount', () => {
  const reducer = new AccumulateDeficitReducer();
  const next    = reducer.reduce(makeState(), { type: 'ACCUMULATE_DEFICIT', amount: 500 });

  assert.strictEqual(next.cumulativeDeficit, 500);
});

test('AccumulateDeficitReducer: accumulates across multiple reductions', () => {
  const reducer = new AccumulateDeficitReducer();
  let state = makeState();
  state = reducer.reduce(state, { type: 'ACCUMULATE_DEFICIT', amount: 300 });
  state = reducer.reduce(state, { type: 'ACCUMULATE_DEFICIT', amount: 200 });

  assert.strictEqual(state.cumulativeDeficit, 500);
});

test('AccumulateDeficitReducer: increments deficitMonths by 1 each call', () => {
  const reducer = new AccumulateDeficitReducer();
  let state = makeState();
  state = reducer.reduce(state, { type: 'ACCUMULATE_DEFICIT', amount: 100 });
  state = reducer.reduce(state, { type: 'ACCUMULATE_DEFICIT', amount: 100 });
  state = reducer.reduce(state, { type: 'ACCUMULATE_DEFICIT', amount: 100 });

  assert.strictEqual(state.deficitMonths, 3);
});

test('AccumulateDeficitReducer: treats missing amount as zero', () => {
  const reducer = new AccumulateDeficitReducer();
  const next    = reducer.reduce(makeState(), { type: 'ACCUMULATE_DEFICIT' });

  assert.strictEqual(next.cumulativeDeficit, 0);
  assert.strictEqual(next.deficitMonths, 1);
});

test('AccumulateDeficitReducer: preserves unrelated state fields', () => {
  const reducer = new AccumulateDeficitReducer();
  const next    = reducer.reduce(makeState(), { type: 'ACCUMULATE_DEFICIT', amount: 100 });

  assert.strictEqual(next.otherField, 99);
});

test('AccumulateDeficitReducer: does not mutate original state', () => {
  const reducer = new AccumulateDeficitReducer();
  const state   = makeState();
  reducer.reduce(state, { type: 'ACCUMULATE_DEFICIT', amount: 250 });

  assert.strictEqual(state.cumulativeDeficit, 0);
  assert.strictEqual(state.deficitMonths, 0);
});
