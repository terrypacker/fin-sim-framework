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

import { OutOfFundsReducer } from '../../src/finance/reducers/out-of-funds-reducer.js';

const DATE = new Date(2030, 5, 1);

function makeState(overrides = {}) {
  return { outOfFundsDate: null, scenarioFailed: false, cumulativeDeficit: 0, deficitMonths: 0, ...overrides };
}

function actionsFrom(reducer, state, action, date = DATE) {
  const result = reducer.reduce(state, action, date);
  return result.next ?? [];
}

test('OutOfFundsReducer: emits RECORD_METRIC with the deficit amount', () => {
  const reducer = new OutOfFundsReducer();
  const next    = actionsFrom(reducer, makeState(), { type: 'OUT_OF_FUNDS', deficit: 750, currency: 'USD' });
  const metric  = next.find(a => a.type === 'RECORD_METRIC' || a.constructor?.name === 'RecordMetricAction');

  assert.ok(metric, 'RECORD_METRIC action missing');
  assert.strictEqual(metric.value ?? metric.amount, 750);
});

test('OutOfFundsReducer: emits ACCUMULATE_DEFICIT with the deficit amount', () => {
  const reducer = new OutOfFundsReducer();
  const next    = actionsFrom(reducer, makeState(), { type: 'OUT_OF_FUNDS', deficit: 500 });
  const acc     = next.find(a => a.type === 'ACCUMULATE_DEFICIT');

  assert.ok(acc, 'ACCUMULATE_DEFICIT action missing');
  assert.strictEqual(acc.amount, 500);
});

test('OutOfFundsReducer: emits SET_OUT_OF_FUNDS_DATE on first occurrence', () => {
  const reducer = new OutOfFundsReducer();
  const next    = actionsFrom(reducer, makeState(), { type: 'OUT_OF_FUNDS', deficit: 100 });
  const setDate = next.find(a => a.type === 'SET_OUT_OF_FUNDS_DATE');

  assert.ok(setDate, 'SET_OUT_OF_FUNDS_DATE action missing on first occurrence');
  assert.strictEqual(setDate.date, DATE);
});

test('OutOfFundsReducer: does NOT emit SET_OUT_OF_FUNDS_DATE on subsequent occurrences', () => {
  const reducer = new OutOfFundsReducer();
  const state   = makeState({ outOfFundsDate: new Date(2030, 0, 1) });
  const next    = actionsFrom(reducer, state, { type: 'OUT_OF_FUNDS', deficit: 100 });
  const setDate = next.find(a => a.type === 'SET_OUT_OF_FUNDS_DATE');

  assert.strictEqual(setDate, undefined);
});

test('OutOfFundsReducer: emits RECORD_BALANCE', () => {
  const reducer = new OutOfFundsReducer();
  const next    = actionsFrom(reducer, makeState(), { type: 'OUT_OF_FUNDS', deficit: 100 });
  const balance = next.find(a => a.type === 'RECORD_BALANCE' || a.constructor?.name === 'RecordBalanceAction');

  assert.ok(balance, 'RECORD_BALANCE action missing');
});

test('OutOfFundsReducer: treats missing deficit as zero', () => {
  const reducer = new OutOfFundsReducer();
  const next    = actionsFrom(reducer, makeState(), { type: 'OUT_OF_FUNDS' });
  const acc     = next.find(a => a.type === 'ACCUMULATE_DEFICIT');

  assert.strictEqual(acc.amount, 0);
});

test('OutOfFundsReducer: does not mutate state', () => {
  const reducer = new OutOfFundsReducer();
  const state   = makeState();
  reducer.reduce(state, { type: 'OUT_OF_FUNDS', deficit: 200 }, DATE);

  assert.strictEqual(state.outOfFundsDate, null);
});
