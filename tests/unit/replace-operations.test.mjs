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
 * replace-operations.test.mjs
 *
 * Regression suite for replaceHandler, replaceAction, and replaceReducer.
 *
 * All three methods change the runtime class of a graph node while preserving
 * its identity (id, name, configured state).  The key invariant: the full
 * constructor chain must run on the fresh instance so SimGraphNode base fields
 * (kind, layer, data, meta) are properly initialised — bypassing constructors
 * via Object.create leaves those fields undefined.
 *
 * Run with: npm run test:unit
 */

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// Importing HandlerService populates HANDLER_CLASSES with domain subclasses.
import { HandlerService } from '../../src/services/handler-service.js';
import { ServiceRegistry } from '../../src/services/service-registry.js';

import { HANDLER_CLASSES } from '../../src/simulation-framework/handlers.js';
import { ACTION_CLASSES }  from '../../src/simulation-framework/actions.js';
import { REDUCER_CLASSES, PRIORITY } from '../../src/simulation-framework/reducers.js';

beforeEach(() => ServiceRegistry.resetAll());

// ─── Shared SimGraphNode field checker ────────────────────────────────────────

/**
 * Asserts that `node` has the SimGraphNode base fields properly initialised.
 * Before the fix, Object.create skipped the constructor chain and left these
 * fields undefined on replaced instances.
 */
function assertSimGraphNodeFields(node, expectedKind) {
  assert.strictEqual(node.kind,  expectedKind, `kind should be "${expectedKind}"`);
  assert.strictEqual(node.layer, 'config',     'layer should be "config"');
  assert.ok(node.data !== undefined,  'data should be initialised by SimGraphNode constructor');
  assert.ok(node.meta !== undefined,  'meta should be initialised by SimGraphNode constructor');
}

// ─── replaceReducer ───────────────────────────────────────────────────────────

test('replaceReducer: SimGraphNode base fields are initialised on the fresh instance', () => {
  const { reducerService } = ServiceRegistry.getInstance();
  const original = reducerService.createFieldReducer('balance');

  const fresh = reducerService.replaceReducer(original.id, 'NumericSumReducer');

  assertSimGraphNodeFields(fresh, 'reducer');
});

test('replaceReducer: preserves id and name', () => {
  const { reducerService } = ServiceRegistry.getInstance();
  const original = reducerService.createFieldReducer('balance', 'My Balance Reducer');

  const fresh = reducerService.replaceReducer(original.id, 'NumericSumReducer');

  assert.strictEqual(fresh.id,   original.id,   'id must be preserved');
  assert.strictEqual(fresh.name, original.name, 'name must be preserved');
});

test('replaceReducer: preserves priority', () => {
  const { reducerService } = ServiceRegistry.getInstance();
  const original = reducerService.createFieldReducer('balance', 'R', PRIORITY.CASH_FLOW);

  const fresh = reducerService.replaceReducer(original.id, 'NumericSumReducer');

  assert.strictEqual(fresh.priority, PRIORITY.CASH_FLOW, 'priority must be preserved');
});

test('replaceReducer: preserves reducedActionTypes and generatedActionTypes', () => {
  const { reducerService } = ServiceRegistry.getInstance();
  const original = reducerService.createFieldReducer('balance');
  original.reducedActionTypes   = ['ADD_CASH'];
  original.generatedActionTypes = ['RECORD_BALANCE'];

  const fresh = reducerService.replaceReducer(original.id, 'NumericSumReducer');

  assert.deepStrictEqual(fresh.reducedActionTypes,   ['ADD_CASH']);
  assert.deepStrictEqual(fresh.generatedActionTypes, ['RECORD_BALANCE']);
});

test('replaceReducer: fresh instance has correct reducerType for every class in REDUCER_CLASSES', () => {
  const { reducerService } = ServiceRegistry.getInstance();
  const original = reducerService.createFieldReducer('balance', 'Pivot');

  for (const className of Object.keys(REDUCER_CLASSES)) {
    const fresh = reducerService.replaceReducer(original.id, className);
    assert.strictEqual(fresh.reducerType, className,
      `reducerType mismatch after replacing to "${className}"`);
    assert.strictEqual(fresh.id, original.id,
      `id must be preserved after replacing to "${className}"`);
  }
});

// Regression: AccountTransactionReducer had options-object as first constructor
// param, so new Cls(old.name, old.priority) passed the name string as the
// destructured object and the priority number (e.g. 90) became `name`.
test('replaceReducer: AccountTransactionReducer regression — name is not replaced by priority number', () => {
  const { reducerService } = ServiceRegistry.getInstance();
  // createFieldReducer defaults to PRIORITY.METRICS (90) — the value that was
  // incorrectly appearing as `name` before the constructor was reordered.
  const original = reducerService.createFieldReducer('balance', 'My Field Reducer');
  assert.strictEqual(original.priority, PRIORITY.METRICS);

  const fresh = reducerService.replaceReducer(original.id, 'AccountTransactionReducer');

  assert.strictEqual(fresh.name, 'My Field Reducer',
    'name must be the original string, not the priority number');
  assert.strictEqual(typeof fresh.name, 'string',
    'name must be a string, not a number');
  assert.strictEqual(fresh.priority, PRIORITY.METRICS,
    'priority must be preserved as a number');
});

test('replaceReducer: publishes UPDATE ServiceActionEvent', () => {
  const registry = ServiceRegistry.getInstance();
  const original = registry.reducerService.createFieldReducer('balance');
  const events = [];
  registry.bus.subscribe('SERVICE_ACTION', e => { if (e.actionType === 'UPDATE') events.push(e); });

  registry.reducerService.replaceReducer(original.id, 'NumericSumReducer');

  assert.strictEqual(events.length, 1);
  assert.ok(events[0].item instanceof REDUCER_CLASSES['NumericSumReducer']);
  assert.strictEqual(events[0].originalItem.reducerType, 'FieldReducer');
});

// ─── replaceAction ────────────────────────────────────────────────────────────

test('replaceAction: SimGraphNode base fields are initialised on the fresh instance', () => {
  const { actionService } = ServiceRegistry.getInstance();
  const original = actionService.createAmountAction('ADD_CASH', 'Cash In', 1000);

  const fresh = actionService.replaceAction(original.id, 'FieldValueAction');

  assertSimGraphNodeFields(fresh, 'action');
});

test('replaceAction: preserves id and name', () => {
  const { actionService } = ServiceRegistry.getInstance();
  const original = actionService.createAmountAction('ADD_CASH', 'Cash In', 500);

  const fresh = actionService.replaceAction(original.id, 'FieldValueAction');

  assert.strictEqual(fresh.id,   original.id,   'id must be preserved');
  assert.strictEqual(fresh.name, original.name, 'name must be preserved');
});

test('replaceAction: preserves type, fieldName, and value', () => {
  const { actionService } = ServiceRegistry.getInstance();
  const original = actionService.createFieldValueAction('SET_RATE', 'Set Rate', 'interestRate', 0.05);

  const fresh = actionService.replaceAction(original.id, 'FieldAction');

  assert.strictEqual(fresh.type,      'SET_RATE',     'type must be preserved');
  assert.strictEqual(fresh.fieldName, 'interestRate', 'fieldName must be preserved');
});

test('replaceAction: actionClass getter returns the new class name', () => {
  const { actionService } = ServiceRegistry.getInstance();
  const original = actionService.createAmountAction('X', 'X', 0);

  const fresh = actionService.replaceAction(original.id, 'ScriptedAction');

  assert.strictEqual(fresh.actionClass, 'ScriptedAction');
});

test('replaceAction: fresh instance has correct actionClass for every class in ACTION_CLASSES', () => {
  const { actionService } = ServiceRegistry.getInstance();
  const original = actionService.createAmountAction('PIVOT', 'Pivot', 0);

  for (const className of Object.keys(ACTION_CLASSES)) {
    const fresh = actionService.replaceAction(original.id, className);
    assert.strictEqual(fresh.actionClass, className,
      `actionClass mismatch after replacing to "${className}"`);
    assert.strictEqual(fresh.id, original.id,
      `id must be preserved after replacing to "${className}"`);
    assertSimGraphNodeFields(fresh, 'action');
  }
});

test('replaceAction: publishes UPDATE ServiceActionEvent', () => {
  const registry = ServiceRegistry.getInstance();
  const original = registry.actionService.createAmountAction('X', 'X', 0);
  const events = [];
  registry.bus.subscribe('SERVICE_ACTION', e => { if (e.actionType === 'UPDATE') events.push(e); });

  registry.actionService.replaceAction(original.id, 'FieldValueAction');

  assert.strictEqual(events.length, 1);
  assert.ok(events[0].item instanceof ACTION_CLASSES['FieldValueAction']);
  assert.strictEqual(events[0].originalItem.actionClass, 'AmountAction');
});

// ─── replaceHandler ───────────────────────────────────────────────────────────

test('replaceHandler: SimGraphNode base fields are initialised on the fresh instance', () => {
  const { handlerService } = ServiceRegistry.getInstance();
  const original = handlerService.createHandler(null, 'My Handler');

  const fresh = handlerService.replaceHandler(original.id, 'HandlerEntry');

  assertSimGraphNodeFields(fresh, 'handler');
});

test('replaceHandler: preserves id and name', () => {
  const { handlerService } = ServiceRegistry.getInstance();
  const original = handlerService.createHandler(null, 'My Handler');

  const fresh = handlerService.replaceHandler(original.id, 'HandlerEntry');

  assert.strictEqual(fresh.id,   original.id,   'id must be preserved');
  assert.strictEqual(fresh.name, original.name, 'name must be preserved');
});

test('replaceHandler: preserves handledEvents', () => {
  const { handlerService } = ServiceRegistry.getInstance();
  const original = handlerService.createHandler(null, 'H');
  original.handledEvents = ['MONTHLY_SALARY', 'QUARTERLY_BONUS'];

  const fresh = handlerService.replaceHandler(original.id, 'HandlerEntry');

  assert.deepStrictEqual(fresh.handledEvents, ['MONTHLY_SALARY', 'QUARTERLY_BONUS'],
    'handledEvents must be preserved across a type change');
});

test('replaceHandler: preserves generatedActionTypes and generatedActionDefinitions', () => {
  const { handlerService } = ServiceRegistry.getInstance();
  const original = handlerService.createHandler(null, 'H');
  original.generatedActionTypes      = ['ADD_CASH'];
  original.generatedActionDefinitions = [{ type: 'ADD_CASH' }];

  const fresh = handlerService.replaceHandler(original.id, 'HandlerEntry');

  assert.deepStrictEqual(fresh.generatedActionTypes, ['ADD_CASH']);
  assert.deepStrictEqual(fresh.generatedActionDefinitions, [{ type: 'ADD_CASH' }]);
});

test('replaceHandler: handlerClass getter returns the new class name', () => {
  const { handlerService } = ServiceRegistry.getInstance();
  const original = handlerService.createHandler(null, 'H');

  const fresh = handlerService.replaceHandler(original.id, 'MonthlyExpensesHandler');

  assert.strictEqual(fresh.handlerClass, 'MonthlyExpensesHandler');
});

test('replaceHandler: fresh instance has correct handlerClass for every class in HANDLER_CLASSES', () => {
  const { handlerService } = ServiceRegistry.getInstance();
  const original = handlerService.createHandler(null, 'Pivot');

  for (const className of Object.keys(HANDLER_CLASSES)) {
    const fresh = handlerService.replaceHandler(original.id, className);
    assert.strictEqual(fresh.handlerClass, className,
      `handlerClass mismatch after replacing to "${className}"`);
    assert.strictEqual(fresh.id, original.id,
      `id must be preserved after replacing to "${className}"`);
    assertSimGraphNodeFields(fresh, 'handler');
  }
});

test('replaceHandler: publishes UPDATE ServiceActionEvent', () => {
  const registry = ServiceRegistry.getInstance();
  const original = registry.handlerService.createHandler(null, 'H');
  const events = [];
  registry.bus.subscribe('SERVICE_ACTION', e => { if (e.actionType === 'UPDATE') events.push(e); });

  registry.handlerService.replaceHandler(original.id, 'MonthlyExpensesHandler');

  assert.strictEqual(events.length, 1);
  assert.ok(events[0].item instanceof HANDLER_CLASSES['MonthlyExpensesHandler']);
  assert.strictEqual(events[0].originalItem.handlerClass, 'HandlerEntry');
});
