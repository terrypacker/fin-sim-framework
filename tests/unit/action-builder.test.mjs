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
  Action,
  FieldAction,
  FieldValueAction,
  RecordBalanceAction, DEFAULT_ACTIONS,
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

// ─── Action builder ───────────────────────────────────────────────

test('ActionBuilder.action: build() returns a Action', () => {
  const a = ActionBuilder.action(DEFAULT_ACTIONS.RECORD_METRIC).name('Metric').build();
  assert.ok(a instanceof Action);
});

test('ActionBuilder.action: type is set correctly', () => {
  const a = ActionBuilder.fieldAction(DEFAULT_ACTIONS.RECORD_METRIC).name('M').build();
  assert.strictEqual(a.type, 'RECORD_METRIC');
});

test('ActionBuilder.action: type can be overridden', () => {
  const a = ActionBuilder.action(DEFAULT_ACTIONS.RECORD_METRIC).type('CUSTOM').name('M').build();
  assert.strictEqual(a.type, 'CUSTOM');
});

test('ActionBuilder.action: name is set correctly', () => {
  const a = ActionBuilder.fieldAction(DEFAULT_ACTIONS.RECORD_METRIC).name('M').build();
  assert.strictEqual(a.name, 'M');
});

// ─── FieldAction builder ───────────────────────────────────────────────

test('ActionBuilder.fieldAction: build() returns a FieldAction', () => {
  const a = ActionBuilder.fieldAction(DEFAULT_ACTIONS.RECORD_METRIC).name('Metric').fieldName('foo').build();
  assert.ok(a instanceof FieldAction);
});

test('ActionBuilder.fieldAction: type is set correctly', () => {
  const a = ActionBuilder.fieldAction(DEFAULT_ACTIONS.RECORD_METRIC).name('M').fieldName('f').build();
  assert.strictEqual(a.type, 'RECORD_METRIC');
});

test('ActionBuilder.fieldAction: type can be overridden', () => {
  const a = ActionBuilder.fieldAction(DEFAULT_ACTIONS.RECORD_METRIC).type('CUSTOM').name('M').fieldName('f').build();
  assert.strictEqual(a.type, 'CUSTOM');
});

test('ActionBuilder.fieldAction: name is set', () => {
  const a = ActionBuilder.fieldAction(DEFAULT_ACTIONS.RECORD_METRIC).name('M').fieldName('f').build();
  assert.strictEqual(a.name, 'M');
});


test('ActionBuilder.fieldAction: fieldName is set', () => {
  const a = ActionBuilder.fieldAction(DEFAULT_ACTIONS.RECORD_METRIC).name('M').fieldName('f').build();
  assert.strictEqual(a.fieldName, 'f');
});

// ─── FieldValueAction builder ───────────────────────────────────────────────

test('ActionBuilder.fieldValueAction: build() returns a FieldValueAction', () => {
  const a = ActionBuilder.fieldValueAction(DEFAULT_ACTIONS.RECORD_METRIC).name('Metric').fieldName('foo').build();
  assert.ok(a instanceof FieldValueAction);
});

test('ActionBuilder.fieldValueAction: type is set correctly', () => {
  const a = ActionBuilder.fieldValueAction(DEFAULT_ACTIONS.RECORD_METRIC).name('M').fieldName('f').build();
  assert.strictEqual(a.type, 'RECORD_METRIC');
});

test('ActionBuilder.fieldValueAction: type can be overridden', () => {
  const a = ActionBuilder.fieldValueAction(DEFAULT_ACTIONS.RECORD_METRIC).type('CUSTOM').name('M').fieldName('f').build();
  assert.strictEqual(a.type, 'CUSTOM');
});

test('ActionBuilder.fieldValueAction: name is set', () => {
  const a = ActionBuilder.fieldValueAction(DEFAULT_ACTIONS.RECORD_METRIC).name('M').fieldName('f').value(42).build();
  assert.strictEqual(a.name, 'M');
});

test('ActionBuilder.fieldValueAction: fieldName is set', () => {
  const a = ActionBuilder.fieldValueAction(DEFAULT_ACTIONS.RECORD_METRIC).name('M').fieldName('f').value(42).build();
  assert.strictEqual(a.fieldName, 'f');
});

test('ActionBuilder.fieldValueAction: value is set', () => {
  const a = ActionBuilder.fieldValueAction(DEFAULT_ACTIONS.RECORD_METRIC).name('M').fieldName('f').value(42).build();
  assert.strictEqual(a.value, 42);
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

test('FieldValueAction: id is null after construction', () => {
  const a = ActionBuilder.fieldValueAction(DEFAULT_ACTIONS.RECORD_METRIC).type('CUSTOM').name('M').fieldName('f').build();
  assert.strictEqual(a.id, null);
  assert.strictEqual(a.type, 'CUSTOM');
});

test('FieldValueAction: id is null with default type', () => {
  const a = ActionBuilder.fieldValueAction(DEFAULT_ACTIONS.RECORD_METRIC).name('M').fieldName('f').build();
  assert.strictEqual(a.id, null);
  assert.strictEqual(a.type, 'RECORD_METRIC');
});
