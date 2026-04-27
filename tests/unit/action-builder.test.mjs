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
 * action-builder.test.mjs
 * Tests for ActionBuilder (all action type builders)
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import { ActionBuilder } from '../../src/simulation-framework/builders/action-builder.js';
import {
  AmountAction,
  RecordMetricAction,
  RecordArrayMetricAction,
  RecordNumericSumMetricAction,
  RecordMultiplicativeMetricAction,
  RecordBalanceAction,
} from '../../src/simulation-framework/actions.js';

// ─── AmountAction builder ─────────────────────────────────────────────────────

test('ActionBuilder.amount: build() returns an AmountAction', () => {
  const a = ActionBuilder.amount().type('ADD_CASH').name('Credit').value(500).build();
  assert.ok(a instanceof AmountAction);
});

test('ActionBuilder.amount: type is set', () => {
  const a = ActionBuilder.amount().type('ADD_CASH').name('Credit').build();
  assert.strictEqual(a.type, 'ADD_CASH');
});

test('ActionBuilder.amount: name is set', () => {
  const a = ActionBuilder.amount().type('ADD_CASH').name('My Credit').build();
  assert.strictEqual(a.name, 'My Credit');
});

test('ActionBuilder.amount: value is set', () => {
  const a = ActionBuilder.amount().type('ADD_CASH').name('Credit').value(1200).build();
  assert.strictEqual(a.value, 1200);
});

test('ActionBuilder.amount: value defaults to 0', () => {
  const a = ActionBuilder.amount().type('ADD_CASH').name('Credit').build();
  assert.strictEqual(a.value, 0);
});

test('ActionBuilder.amount: fieldName is set to "amount"', () => {
  const a = ActionBuilder.amount().type('ADD_CASH').name('Credit').value(100).build();
  assert.strictEqual(a.fieldName, 'amount');
});

test('ActionBuilder.amount: builder is chainable', () => {
  const b = ActionBuilder.amount();
  assert.strictEqual(b.type('T'), b);
  assert.strictEqual(b.name('N'), b);
  assert.strictEqual(b.value(0), b);
});

// ─── RecordMetricAction builder ───────────────────────────────────────────────

test('ActionBuilder.recordMetric: build() returns a RecordMetricAction', () => {
  const a = ActionBuilder.recordMetric().name('Metric').fieldName('foo').build();
  assert.ok(a instanceof RecordMetricAction);
});

test('ActionBuilder.recordMetric: type defaults to RECORD_METRIC', () => {
  const a = ActionBuilder.recordMetric().name('M').fieldName('f').build();
  assert.strictEqual(a.type, 'RECORD_METRIC');
});

test('ActionBuilder.recordMetric: type can be overridden', () => {
  const a = ActionBuilder.recordMetric().type('CUSTOM').name('M').fieldName('f').build();
  assert.strictEqual(a.type, 'CUSTOM');
});

test('ActionBuilder.recordMetric: fieldName is prefixed with metrics.', () => {
  const a = ActionBuilder.recordMetric().name('M').fieldName('myMetric').build();
  assert.strictEqual(a.fieldName, 'metrics.myMetric');
});

test('ActionBuilder.recordMetric: value is set', () => {
  const a = ActionBuilder.recordMetric().name('M').fieldName('f').value(42).build();
  assert.strictEqual(a.value, 42);
});

// ─── RecordArrayMetricAction builder ─────────────────────────────────────────

test('ActionBuilder.recordArrayMetric: build() returns a RecordArrayMetricAction', () => {
  const a = ActionBuilder.recordArrayMetric().name('Arr').fieldName('deposits').build();
  assert.ok(a instanceof RecordArrayMetricAction);
});

test('ActionBuilder.recordArrayMetric: type is RECORD_ARRAY_METRIC', () => {
  const a = ActionBuilder.recordArrayMetric().name('A').fieldName('f').build();
  assert.strictEqual(a.type, 'RECORD_ARRAY_METRIC');
});

test('ActionBuilder.recordArrayMetric: name is set', () => {
  const a = ActionBuilder.recordArrayMetric().name('My Array').fieldName('f').build();
  assert.strictEqual(a.name, 'My Array');
});

// ─── RecordNumericSumMetricAction builder ─────────────────────────────────────

test('ActionBuilder.recordNumericSum: build() returns a RecordNumericSumMetricAction', () => {
  const a = ActionBuilder.recordNumericSum().name('Sum').fieldName('salary').build();
  assert.ok(a instanceof RecordNumericSumMetricAction);
});

test('ActionBuilder.recordNumericSum: type is RECORD_NUMERIC_SUM_METRIC', () => {
  const a = ActionBuilder.recordNumericSum().name('S').fieldName('f').build();
  assert.strictEqual(a.type, 'RECORD_NUMERIC_SUM_METRIC');
});

test('ActionBuilder.recordNumericSum: fieldName is prefixed with metrics.', () => {
  const a = ActionBuilder.recordNumericSum().name('S').fieldName('salary').build();
  assert.strictEqual(a.fieldName, 'metrics.salary');
});

// ─── RecordMultiplicativeMetricAction builder ─────────────────────────────────

test('ActionBuilder.recordMultiplicative: build() returns a RecordMultiplicativeMetricAction', () => {
  const a = ActionBuilder.recordMultiplicative().name('Mult').fieldName('growth').build();
  assert.ok(a instanceof RecordMultiplicativeMetricAction);
});

test('ActionBuilder.recordMultiplicative: type is RECORD_MULTIPLICATIVE_METRIC', () => {
  const a = ActionBuilder.recordMultiplicative().name('M').fieldName('f').build();
  assert.strictEqual(a.type, 'RECORD_MULTIPLICATIVE_METRIC');
});

// ─── RecordBalanceAction builder ──────────────────────────────────────────────

test('ActionBuilder.recordBalance: build() returns a RecordBalanceAction', () => {
  const a = ActionBuilder.recordBalance().build();
  assert.ok(a instanceof RecordBalanceAction);
});

test('ActionBuilder.recordBalance: type is RECORD_BALANCE', () => {
  const a = ActionBuilder.recordBalance().build();
  assert.strictEqual(a.type, 'RECORD_BALANCE');
});

test('ActionBuilder.recordBalance: each build() returns a new instance', () => {
  const b = ActionBuilder.recordBalance();
  assert.notStrictEqual(b.build(), b.build());
});

// ─── id is null before service assignment ────────────────────────────────────
// Action.id is null after construction; ActionService assigns it via _generateId.
// type is the category discriminator and remains independent of id.

test('AmountAction: id is null after construction', () => {
  const a = ActionBuilder.amount().type('MY_ACTION').name('Test').build();
  assert.strictEqual(a.id, null);
  assert.strictEqual(a.type, 'MY_ACTION');
});

test('RecordMetricAction: id is null after construction', () => {
  const a = ActionBuilder.recordMetric().type('CUSTOM').name('M').fieldName('f').build();
  assert.strictEqual(a.id, null);
  assert.strictEqual(a.type, 'CUSTOM');
});

test('RecordMetricAction: id is null with default type', () => {
  const a = ActionBuilder.recordMetric().name('M').fieldName('f').build();
  assert.strictEqual(a.id, null);
  assert.strictEqual(a.type, 'RECORD_METRIC');
});

test('RecordArrayMetricAction: id is null after construction', () => {
  const a = ActionBuilder.recordArrayMetric().name('A').fieldName('f').build();
  assert.strictEqual(a.id, null);
  assert.strictEqual(a.type, 'RECORD_ARRAY_METRIC');
});

test('RecordNumericSumMetricAction: id is null after construction', () => {
  const a = ActionBuilder.recordNumericSum().name('S').fieldName('f').build();
  assert.strictEqual(a.id, null);
  assert.strictEqual(a.type, 'RECORD_NUMERIC_SUM_METRIC');
});

test('RecordMultiplicativeMetricAction: id is null after construction', () => {
  const a = ActionBuilder.recordMultiplicative().name('M').fieldName('f').build();
  assert.strictEqual(a.id, null);
  assert.strictEqual(a.type, 'RECORD_MULTIPLICATIVE_METRIC');
});

test('RecordBalanceAction: id is null after construction', () => {
  const a = ActionBuilder.recordBalance().build();
  assert.strictEqual(a.id, null);
  assert.strictEqual(a.type, 'RECORD_BALANCE');
});
