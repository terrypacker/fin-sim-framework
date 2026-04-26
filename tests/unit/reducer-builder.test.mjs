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
 * reducer-builder.test.mjs
 * Tests for ReducerBuilder (all reducer type builders)
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import { ReducerBuilder } from '../../src/simulation-framework/builders/reducer-builder.js';
import {
  ReducerPipeline,
  NoOpReducer,
  FieldReducer,
  MetricReducer,
  ArrayMetricReducer,
  NumericSumMetricReducer,
  MultiplicativeMetricReducer,
  RepeatingReducer,
  PRIORITY,
} from '../../src/simulation-framework/reducers.js';

// ─── NoOp builder ────────────────────────────────────────────────────────────

test('ReducerBuilder.noOp: build() returns a NoOpReducer', () => {
  const r = ReducerBuilder.noOp().build();
  assert.ok(r instanceof NoOpReducer);
});

test('ReducerBuilder.noOp: default name is "No-Op"', () => {
  const r = ReducerBuilder.noOp().build();
  assert.strictEqual(r.name, 'No-Op');
});

test('ReducerBuilder.noOp: name is overridable', () => {
  const r = ReducerBuilder.noOp().name('Balance Snapshot').build();
  assert.strictEqual(r.name, 'Balance Snapshot');
});

test('ReducerBuilder.noOp: default priority is LOGGING + 5', () => {
  const r = ReducerBuilder.noOp().build();
  assert.strictEqual(r.priority, PRIORITY.LOGGING + 5);
});

test('ReducerBuilder.noOp: priority is overridable', () => {
  const r = ReducerBuilder.noOp().priority(PRIORITY.METRICS).build();
  assert.strictEqual(r.priority, PRIORITY.METRICS);
});

test('ReducerBuilder.noOp: reduce returns state unchanged', () => {
  const r = ReducerBuilder.noOp().build();
  const state = { x: 1, metrics: {} };
  const result = r.reduce(state);
  assert.strictEqual(result.x, 1);
});

// ─── Field builder ────────────────────────────────────────────────────────────

test('ReducerBuilder.field: build() returns a FieldReducer', () => {
  const r = ReducerBuilder.field().fieldName('myField').build();
  assert.ok(r instanceof FieldReducer);
});

test('ReducerBuilder.field: fieldName is set', () => {
  const r = ReducerBuilder.field().fieldName('balance').build();
  assert.strictEqual(r.fieldName, 'balance');
});

test('ReducerBuilder.field: name is set', () => {
  const r = ReducerBuilder.field().fieldName('balance').name('Balance Reducer').build();
  assert.ok(r.name.includes('Balance Reducer'));
});

// ─── Metric builder ───────────────────────────────────────────────────────────

test('ReducerBuilder.metric: build() returns a MetricReducer', () => {
  const r = ReducerBuilder.metric('salary').build();
  assert.ok(r instanceof MetricReducer);
});

test('ReducerBuilder.metric: fieldName is prefixed with metrics.', () => {
  const r = ReducerBuilder.metric('salary').build();
  assert.strictEqual(r.fieldName, 'metrics.salary');
});

test('ReducerBuilder.metric: name is set', () => {
  const r = ReducerBuilder.metric('salary').name('Salary Reducer').build();
  assert.ok(r.name.includes('Salary Reducer'));
});

test('ReducerBuilder.metric: default priority is METRICS', () => {
  const r = ReducerBuilder.metric('salary').build();
  assert.strictEqual(r.priority, PRIORITY.METRICS);
});

test('ReducerBuilder.metric: priority is overridable', () => {
  const r = ReducerBuilder.metric('salary').priority(PRIORITY.CASH_FLOW).build();
  assert.strictEqual(r.priority, PRIORITY.CASH_FLOW);
});

// ─── Array metric builder ─────────────────────────────────────────────────────

test('ReducerBuilder.arrayMetric: build() returns an ArrayMetricReducer', () => {
  const r = ReducerBuilder.arrayMetric('deposits').build();
  assert.ok(r instanceof ArrayMetricReducer);
});

test('ReducerBuilder.arrayMetric: fieldName is set', () => {
  const r = ReducerBuilder.arrayMetric('deposits').build();
  assert.strictEqual(r.fieldName, 'metrics.deposits');
});

test('ReducerBuilder.arrayMetric: name is set', () => {
  const r = ReducerBuilder.arrayMetric('deposits').name('Deposit Logger').build();
  assert.ok(r.name.includes('Deposit Logger'));
});

// ─── Numeric sum builder ──────────────────────────────────────────────────────

test('ReducerBuilder.numericSum: build() returns a NumericSumMetricReducer', () => {
  const r = ReducerBuilder.numericSum('total').build();
  assert.ok(r instanceof NumericSumMetricReducer);
});

test('ReducerBuilder.numericSum: fieldName is set', () => {
  const r = ReducerBuilder.numericSum('total').build();
  assert.strictEqual(r.fieldName, 'metrics.total');
});

test('ReducerBuilder.numericSum: name is set', () => {
  const r = ReducerBuilder.numericSum('total').name('Total Sum').build();
  assert.ok(r.name.includes('Total Sum'));
});

// ─── Multiplicative builder ───────────────────────────────────────────────────

test('ReducerBuilder.multiplicative: build() returns a MultiplicativeMetricReducer', () => {
  const r = ReducerBuilder.multiplicative('growth').build();
  assert.ok(r instanceof MultiplicativeMetricReducer);
});

test('ReducerBuilder.multiplicative: fieldName is set', () => {
  const r = ReducerBuilder.multiplicative('growth').build();
  assert.ok(r.fieldName.includes('growth'));
});

// ─── Repeating builder ────────────────────────────────────────────────────────

test('ReducerBuilder.repeating: build() returns a RepeatingReducer', () => {
  const r = ReducerBuilder.repeating().build();
  assert.ok(r instanceof RepeatingReducer);
});

test('ReducerBuilder.repeating: reducers array is set', () => {
  const inner = ReducerBuilder.metric('x').build();
  const r = ReducerBuilder.repeating().reducers([inner]).build();
  assert.strictEqual(r.reducers.length, 1);
  assert.strictEqual(r.reducers[0], inner);
});

test('ReducerBuilder.repeating: countField is set', () => {
  const r = ReducerBuilder.repeating().countField('count').build();
  assert.strictEqual(r.countField, 'count');
});

test('ReducerBuilder.repeating: count is set', () => {
  const r = ReducerBuilder.repeating().count(3).build();
  assert.strictEqual(r.count, 3);
});

test('ReducerBuilder.repeating: name is set', () => {
  const r = ReducerBuilder.repeating().name('My Repeater').build();
  assert.ok(r.name.includes('My Repeater'));
});

// ─── reducedActions / generatedActions ───────────────────────────────────────

test('ReducerBuilder: reduceAction adds to reducedActions', () => {
  const action = { type: 'ADD_CASH' };
  const r = ReducerBuilder.metric('x').reduceAction(action).build();
  assert.strictEqual(r.reducedActions.length, 1);
  assert.strictEqual(r.reducedActions[0], action);
});

test('ReducerBuilder: multiple reduceAction calls accumulate', () => {
  const a1 = { type: 'A' };
  const a2 = { type: 'B' };
  const r = ReducerBuilder.metric('x').reduceAction(a1).reduceAction(a2).build();
  assert.strictEqual(r.reducedActions.length, 2);
});

test('ReducerBuilder: generateAction adds to generatedActions', () => {
  const action = { type: 'NEXT' };
  const r = ReducerBuilder.metric('x').generateAction(action).build();
  assert.strictEqual(r.generatedActions.length, 1);
  assert.strictEqual(r.generatedActions[0], action);
});

test('ReducerBuilder: built reducedActions is a copy of builder state', () => {
  const a1 = { type: 'A' };
  const builder = ReducerBuilder.metric('x').reduceAction(a1);
  const r1 = builder.build();
  builder.reduceAction({ type: 'B' });
  const r2 = builder.build();
  assert.strictEqual(r1.reducedActions.length, 1, 'first build should not be affected');
  assert.strictEqual(r2.reducedActions.length, 2);
});

// ─── Builder chaining ─────────────────────────────────────────────────────────

test('ReducerBuilder: all methods are chainable', () => {
  const b = ReducerBuilder.metric('m');
  assert.strictEqual(b.name('N'), b);
  assert.strictEqual(b.priority(10), b);
  assert.strictEqual(b.reduceAction({ type: 'A' }), b);
  assert.strictEqual(b.generateAction({ type: 'B' }), b);
});

// ─── registerWith still works on built reducers ───────────────────────────────

test('ReducerBuilder: built reducer can be registered with a ReducerPipeline', () => {
  const pipeline = new ReducerPipeline();
  const action = { type: 'MY_ACTION' };
  const r = ReducerBuilder.noOp().name('Test').build();
  r.registerWith(pipeline, 'MY_ACTION');
  const entries = pipeline.get('MY_ACTION');
  assert.strictEqual(entries.length, 1);
  assert.strictEqual(entries[0].name, 'Test');
});
