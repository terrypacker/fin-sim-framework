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

import { SetOutOfFundsDateReducer } from '../../src/finance/reducers/set-out-of-funds-date-reducer.js';

const FAILURE_DATE = new Date(2030, 5, 1);

function makeState(overrides = {}) {
  return { outOfFundsDate: null, scenarioFailed: false, someOtherField: 42, ...overrides };
}

test('SetOutOfFundsDateReducer: stamps outOfFundsDate from the action', () => {
  const reducer = new SetOutOfFundsDateReducer();
  const next    = reducer.reduce(makeState(), { type: 'SET_OUT_OF_FUNDS_DATE', date: FAILURE_DATE });

  assert.strictEqual(next.outOfFundsDate, FAILURE_DATE);
});

test('SetOutOfFundsDateReducer: sets scenarioFailed to true', () => {
  const reducer = new SetOutOfFundsDateReducer();
  const next    = reducer.reduce(makeState(), { type: 'SET_OUT_OF_FUNDS_DATE', date: FAILURE_DATE });

  assert.strictEqual(next.scenarioFailed, true);
});

test('SetOutOfFundsDateReducer: preserves unrelated state fields', () => {
  const reducer = new SetOutOfFundsDateReducer();
  const next    = reducer.reduce(makeState(), { type: 'SET_OUT_OF_FUNDS_DATE', date: FAILURE_DATE });

  assert.strictEqual(next.someOtherField, 42);
});

test('SetOutOfFundsDateReducer: does not mutate original state', () => {
  const reducer = new SetOutOfFundsDateReducer();
  const state   = makeState();
  reducer.reduce(state, { type: 'SET_OUT_OF_FUNDS_DATE', date: FAILURE_DATE });

  assert.strictEqual(state.outOfFundsDate, null);
  assert.strictEqual(state.scenarioFailed, false);
});
