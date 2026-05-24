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
 * type-registries.test.mjs
 *
 * Guards against the class registries drifting out of sync with the domain.
 *
 * Two failure modes this catches:
 *
 *   1. A new class is added to the domain but never registered — the view's
 *      type select would silently omit it.
 *
 *   2. The Object.assign augmentation in handler-service.js (which populates
 *      HANDLER_CLASSES with domain subclasses) is removed or moved — replaceHandler
 *      would throw for any domain class, and the view's handler type select
 *      would only show "HandlerEntry".
 *
 * Run with: npm run test:unit
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

// Importing HandlerService triggers the Object.assign block that augments
// HANDLER_CLASSES.  This import must appear before any HANDLER_CLASSES read.
import { HandlerService } from '../../src/services/handler-service.js';
import { HANDLER_CLASSES } from '../../src/simulation-framework/handlers.js';
import { REDUCER_CLASSES } from '../../src/simulation-framework/reducers.js';
import { ACTION_CLASSES }  from '../../src/simulation-framework/actions.js';
import { ServiceRegistry } from '../../src/services/service-registry.js';

// ─── REDUCER_CLASSES ──────────────────────────────────────────────────────────

const KNOWN_REDUCERS = [
  'NoOpReducer',
  'BalanceSnapshotReducer',
  'FieldReducer',
  'FieldValueReducer',
  'ScriptedReducer',
  'ArrayReducer',
  'NumericSumReducer',
  'MultiplicativeReducer',
  'AccountTransactionReducer',
  'RepeatingReducer',
];

test('REDUCER_CLASSES: contains all known reducer types', () => {
  for (const name of KNOWN_REDUCERS) {
    assert.ok(name in REDUCER_CLASSES, `REDUCER_CLASSES missing "${name}"`);
  }
});

test('REDUCER_CLASSES: every value is a constructor function', () => {
  for (const [name, Cls] of Object.entries(REDUCER_CLASSES)) {
    assert.strictEqual(typeof Cls, 'function', `REDUCER_CLASSES["${name}"] is not a function`);
  }
});

// ─── ACTION_CLASSES ───────────────────────────────────────────────────────────

const KNOWN_ACTIONS = [
  'Action',
  'AmountAction',
  'FieldAction',
  'FieldValueAction',
  'RecordBalanceAction',
  'RecordMetricAction',
  'ScriptedAction',
];

test('ACTION_CLASSES: contains all known action types', () => {
  for (const name of KNOWN_ACTIONS) {
    assert.ok(name in ACTION_CLASSES, `ACTION_CLASSES missing "${name}"`);
  }
});

test('ACTION_CLASSES: every value is a constructor function', () => {
  for (const [name, Cls] of Object.entries(ACTION_CLASSES)) {
    assert.strictEqual(typeof Cls, 'function', `ACTION_CLASSES["${name}"] is not a function`);
  }
});

// ─── HANDLER_CLASSES augmentation ─────────────────────────────────────────────
//
// HANDLER_CLASSES is declared in handlers.js with only HandlerEntry.
// handler-service.js augments it via Object.assign after importing all domain
// handlers.  These tests verify that augmentation has happened and that the
// resulting registry is usable by both the view type select and replaceHandler.

const KNOWN_HANDLERS = [
  'HandlerEntry',
  'UsSavingsInterestMonthlyHandler',
  'MonthlyExpensesHandler',
  'IntlTransferToUsHandler',
  'IntlTransferToAuHandler',
  'AuSavingsInterestHandler',
  'FixedIncomeInterestHandler',
  'SuperEarningsHandler',
  'DividendScheduledHandler',
  'ChangeResidencyHandler',
  'OutOfFundsHandler',
];

test('HANDLER_CLASSES: augmented with all domain handler subclasses after HandlerService import', () => {
  for (const name of KNOWN_HANDLERS) {
    assert.ok(name in HANDLER_CLASSES, `HANDLER_CLASSES missing "${name}" — was the Object.assign in handler-service.js removed?`);
  }
});

test('HANDLER_CLASSES: every value is a constructor function', () => {
  for (const [name, Cls] of Object.entries(HANDLER_CLASSES)) {
    assert.strictEqual(typeof Cls, 'function', `HANDLER_CLASSES["${name}"] is not a function`);
  }
});

test('HANDLER_CLASSES: constructor.name matches registry key for every entry', () => {
  for (const [key, Cls] of Object.entries(HANDLER_CLASSES)) {
    assert.strictEqual(Cls.name, key,
      `HANDLER_CLASSES key "${key}" does not match constructor.name "${Cls.name}" — ` +
      `handlerClass getter on the instance would return the wrong value`);
  }
});

// ─── replaceHandler round-trip ────────────────────────────────────────────────
//
// Verifies that HandlerService.replaceHandler works for every registered class,
// which is the service-level contract the UI type select depends on.

test('HandlerService.replaceHandler: succeeds for every class in HANDLER_CLASSES', () => {
  ServiceRegistry.reset();
  const { handlerService } = ServiceRegistry.getInstance();
  const original = handlerService.createHandler(null, 'test handler');

  for (const className of Object.keys(HANDLER_CLASSES)) {
    const replaced = handlerService.replaceHandler(original.id, className);
    assert.strictEqual(replaced.handlerClass, className,
      `replaceHandler("${className}") produced handlerClass "${replaced.handlerClass}"`);
    assert.strictEqual(replaced.id, original.id, 'id should be preserved after replace');
  }
});
