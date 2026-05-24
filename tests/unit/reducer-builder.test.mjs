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
  ArrayReducer,
  NumericSumReducer,
  MultiplicativeReducer,
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

test('ReducerBuilder.field: fieldName is used in constructor.', () => {
  const r = ReducerBuilder.field('salary').build();
  assert.strictEqual(r.fieldName, 'salary');
});

test('ReducerBuilder.field: default priority is METRICS', () => {
  const r = ReducerBuilder.field('salary').build();
  assert.strictEqual(r.priority, PRIORITY.METRICS);
});

test('ReducerBuilder.field: priority is overridable', () => {
  const r = ReducerBuilder.field('salary').priority(PRIORITY.CASH_FLOW).build();
  assert.strictEqual(r.priority, PRIORITY.CASH_FLOW);
});

// ─── Array metric builder ─────────────────────────────────────────────────────

test('ReducerBuilder.array: build() returns an ArrayReducer', () => {
  const r = ReducerBuilder.array('deposits').build();
  assert.ok(r instanceof ArrayReducer);
});

test('ReducerBuilder.array: fieldName is set', () => {
  const r = ReducerBuilder.array('deposits').build();
  assert.strictEqual(r.fieldName, 'deposits');
});

test('ReducerBuilder.array: name is set', () => {
  const r = ReducerBuilder.array('deposits').name('Deposit Logger').build();
  assert.ok(r.name.includes('Deposit Logger'));
});

// ─── Numeric sum builder ──────────────────────────────────────────────────────

test('ReducerBuilder.numericSum: build() returns a NumericSumReducer', () => {
  const r = ReducerBuilder.numericSum('total').build();
  assert.ok(r instanceof NumericSumReducer);
});

test('ReducerBuilder.numericSum: fieldName is set', () => {
  const r = ReducerBuilder.numericSum('total').build();
  assert.strictEqual(r.fieldName, 'total');
});

test('ReducerBuilder.numericSum: name is set', () => {
  const r = ReducerBuilder.numericSum('total').name('Total Sum').build();
  assert.ok(r.name.includes('Total Sum'));
});

// ─── Multiplicative builder ───────────────────────────────────────────────────

test('ReducerBuilder.multiplicative: build() returns a MultiplicativeReducer', () => {
  const r = ReducerBuilder.multiplicative('growth').build();
  assert.ok(r instanceof MultiplicativeReducer);
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
  const inner = ReducerBuilder.field('x').build();
  const r = ReducerBuilder.repeating().reducers([inner]).build();
  assert.strictEqual(r.reducers.length, 1);
  assert.strictEqual(r.reducers[0], inner);
});

test('ReducerBuilder.repeating: countField is set', () => {
  const r = ReducerBuilder.repeating().fieldName('count').build();
  assert.strictEqual(r.fieldName, 'count');
});

test('ReducerBuilder.repeating: count is set', () => {
  const r = ReducerBuilder.repeating().count(3).build();
  assert.strictEqual(r.count, 3);
});

test('ReducerBuilder.repeating: name is set', () => {
  const r = ReducerBuilder.repeating().name('My Repeater').build();
  assert.ok(r.name.includes('My Repeater'));
});

// ─── reducedActionTypes / generatedActionTypes ────────────────────────────────

test('ReducerBuilder: reduceActionType adds a type string to reducedActionTypes', () => {
  const r = ReducerBuilder.field('x').reduceActionType('ADD_CASH').build();
  assert.strictEqual(r.reducedActionTypes.length, 1);
  assert.strictEqual(r.reducedActionTypes[0], 'ADD_CASH');
});

test('ReducerBuilder: multiple reduceActionType calls accumulate', () => {
  const r = ReducerBuilder.field('x').reduceActionType('A').reduceActionType('B').build();
  assert.strictEqual(r.reducedActionTypes.length, 2);
});

test('ReducerBuilder: reduceActionType deduplicates type strings', () => {
  const r = ReducerBuilder.field('x').reduceActionType('A').reduceActionType('A').build();
  assert.strictEqual(r.reducedActionTypes.length, 1);
});

test('ReducerBuilder: generateActionType adds to generatedActionTypes', () => {
  const r = ReducerBuilder.field('x').generateActionType('NEXT').build();
  assert.strictEqual(r.generatedActionTypes.length, 1);
  assert.strictEqual(r.generatedActionTypes[0], 'NEXT');
});

test('ReducerBuilder: built reducedActionTypes is a copy of builder state', () => {
  const builder = ReducerBuilder.field('x').reduceActionType('A');
  const r1 = builder.build();
  builder.reduceActionType('B');
  const r2 = builder.build();
  assert.strictEqual(r1.reducedActionTypes.length, 1, 'first build should not be affected');
  assert.strictEqual(r2.reducedActionTypes.length, 2);
});

// ─── Builder chaining ─────────────────────────────────────────────────────────

test('ReducerBuilder: all methods are chainable', () => {
  const b = ReducerBuilder.field('m');
  assert.strictEqual(b.name('N'), b);
  assert.strictEqual(b.priority(10), b);
  assert.strictEqual(b.reduceActionType('A'), b);
  assert.strictEqual(b.generateActionType('B'), b);
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
