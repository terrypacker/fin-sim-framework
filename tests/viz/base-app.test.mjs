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
 * base-app.test.mjs
 * Regression tests for BaseApp pure/logic methods.
 * Run with: npm run test:viz
 */

import assert from 'node:assert/strict';
import { BaseApp } from '../../src/apps/base-app.js';

// ─── FinSimLib stub (constructor-only dependency) ─────────────────────────────
global.FinSimLib = {
  Finance: {
    PeriodService:        class { constructor() {} },
    applyTo:              () => {},
    buildUsCalendarYear:  () => ({}),
    buildAuFiscalYear:    () => ({}),
  },
};

// ─── Helper ───────────────────────────────────────────────────────────────────
function makeApp() {
  return new BaseApp({ newScenario: () => {}, chartSeries: null });
}

// ─── Constructor ──────────────────────────────────────────────────────────────

test('BaseApp: displayCurrency defaults to USD', () => {
  assert.strictEqual(makeApp().displayCurrency, 'USD');
});

test('BaseApp: playing initializes to false', () => {
  assert.strictEqual(makeApp().playing, false);
});

test('BaseApp: scenario initializes to null', () => {
  assert.strictEqual(makeApp().scenario, null);
});

test('BaseApp: lastSliderValue initializes to 0', () => {
  assert.strictEqual(makeApp().lastSliderValue, 0);
});

test('BaseApp: chartSeries stores the provided value', () => {
  const series = [{ key: 'cash', color: '#fff', label: 'Cash' }];
  const app = new BaseApp({ newScenario: () => {}, chartSeries: series });
  assert.strictEqual(app.chartSeries, series);
});

test('BaseApp: chartSeries defaults to null when omitted', () => {
  const app = new BaseApp({ newScenario: () => {} });
  assert.strictEqual(app.chartSeries, null);
});

// ─── diffStates ───────────────────────────────────────────────────────────────

test('BaseApp.diffStates: returns empty array when prev is null', () => {
  assert.deepEqual(makeApp().diffStates(null, { cash: 100 }), []);
});

test('BaseApp.diffStates: returns empty array when next is null', () => {
  assert.deepEqual(makeApp().diffStates({ cash: 100 }, null), []);
});

test('BaseApp.diffStates: returns empty array for identical states', () => {
  const state = { cash: 1000, name: 'Alice' };
  assert.deepEqual(makeApp().diffStates(state, { ...state }), []);
});

test('BaseApp.diffStates: detects numeric change and computes delta', () => {
  const changes = makeApp().diffStates({ cash: 500 }, { cash: 750 });
  assert.strictEqual(changes.length, 1);
  assert.strictEqual(changes[0].field, 'cash');
  assert.strictEqual(changes[0].before, 500);
  assert.strictEqual(changes[0].after, 750);
  assert.strictEqual(changes[0].delta, 250);
});

test('BaseApp.diffStates: delta is null for non-numeric change', () => {
  const changes = makeApp().diffStates({ status: 'open' }, { status: 'closed' });
  assert.strictEqual(changes.length, 1);
  assert.strictEqual(changes[0].delta, null);
});

test('BaseApp.diffStates: skips "credits" key', () => {
  const prev = { credits: [1, 2, 3], cash: 100 };
  const next  = { credits: [1, 2, 3, 4], cash: 100 };
  const changes = makeApp().diffStates(prev, next);
  assert.ok(!changes.some(c => c.field === 'credits'), '"credits" should be skipped');
  assert.strictEqual(changes.length, 0);
});

test('BaseApp.diffStates: skips "debits" key', () => {
  const prev = { debits: [10], cash: 200 };
  const next  = { debits: [10, 20], cash: 200 };
  const changes = makeApp().diffStates(prev, next);
  assert.ok(!changes.some(c => c.field === 'debits'), '"debits" should be skipped');
  assert.strictEqual(changes.length, 0);
});

test('BaseApp.diffStates: recursively walks nested objects', () => {
  const prev = { account: { balance: 1000 } };
  const next  = { account: { balance: 1200 } };
  const changes = makeApp().diffStates(prev, next);
  assert.strictEqual(changes.length, 1);
  assert.strictEqual(changes[0].field, 'account.balance');
  assert.strictEqual(changes[0].delta, 200);
});

test('BaseApp.diffStates: detects added key (before is null)', () => {
  const changes = makeApp().diffStates({ cash: 100 }, { cash: 100, bonus: 50 });
  assert.strictEqual(changes.length, 1);
  assert.strictEqual(changes[0].field, 'bonus');
  assert.strictEqual(changes[0].before, null);
  assert.strictEqual(changes[0].after, 50);
});

test('BaseApp.diffStates: detects removed key (after is null)', () => {
  const changes = makeApp().diffStates({ cash: 100, bonus: 50 }, { cash: 100 });
  assert.strictEqual(changes.length, 1);
  assert.strictEqual(changes[0].field, 'bonus');
  assert.strictEqual(changes[0].after, null);
});

test('BaseApp.diffStates: multiple fields changed returns multiple records', () => {
  const prev = { a: 1, b: 2, c: 3 };
  const next  = { a: 1, b: 5, c: 9 };
  const changes = makeApp().diffStates(prev, next);
  assert.strictEqual(changes.length, 2);
});

// ─── fmtVal ───────────────────────────────────────────────────────────────────

test('BaseApp.fmtVal: returns "—" for null', () => {
  assert.strictEqual(makeApp().fmtVal(null), '—');
});

test('BaseApp.fmtVal: returns "—" for undefined', () => {
  assert.strictEqual(makeApp().fmtVal(undefined), '—');
});

test('BaseApp.fmtVal: formats number with two decimal places', () => {
  const result = makeApp().fmtVal(1234.5);
  assert.ok(result.includes('1,234.50'), `expected '1,234.50' in "${result}"`);
});

test('BaseApp.fmtVal: formats whole number with .00', () => {
  const result = makeApp().fmtVal(100);
  assert.ok(result.endsWith('.00'), `expected ".00" suffix in "${result}"`);
});

test('BaseApp.fmtVal: returns string values unchanged', () => {
  assert.strictEqual(makeApp().fmtVal('hello'), 'hello');
});

test('BaseApp.fmtVal: formats boolean true as "true"', () => {
  assert.strictEqual(makeApp().fmtVal(true), 'true');
});

test('BaseApp.fmtVal: formats Date using _formatDate', () => {
  const app = makeApp();
  const d   = new Date(2026, 0, 1);
  assert.strictEqual(app.fmtVal(d), d.toDateString());
});

test('BaseApp.fmtVal: formats plain object as JSON', () => {
  const obj = { x: 1 };
  const result = makeApp().fmtVal(obj);
  assert.strictEqual(result, JSON.stringify(obj));
});

test('BaseApp.fmtVal: formats array (delegates to fmtArray)', () => {
  const result = makeApp().fmtVal([1, 2, 3]);
  assert.ok(typeof result === 'string');
  assert.ok(result.length > 0);
});

// ─── fmtArray ─────────────────────────────────────────────────────────────────

test('BaseApp.fmtArray: returns empty string for non-array', () => {
  assert.strictEqual(makeApp().fmtArray('not-an-array'), '');
});

test('BaseApp.fmtArray: formats empty array as "—"', () => {
  assert.strictEqual(makeApp().fmtArray([]), '—');
});

test('BaseApp.fmtArray: joins elements with ", "', () => {
  const result = makeApp().fmtArray([1, 2, 3]);
  assert.ok(result.includes(','), `expected comma separator in "${result}"`);
});

test('BaseApp.fmtArray: truncates arrays longer than 10 with "..."', () => {
  const big = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
  const result = makeApp().fmtArray(big);
  assert.ok(result.endsWith('...'), `expected "..." suffix in "${result}"`);
});

test('BaseApp.fmtArray: does not truncate arrays of exactly 10', () => {
  const exact = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  const result = makeApp().fmtArray(exact);
  assert.ok(!result.endsWith('...'), `should not truncate 10-item array, got "${result}"`);
});

// ─── isDate ───────────────────────────────────────────────────────────────────

test('BaseApp.isDate: returns true for a Date instance', () => {
  assert.ok(makeApp().isDate(new Date()));
});

test('BaseApp.isDate: returns false for a string', () => {
  assert.ok(!makeApp().isDate('2026-01-01'));
});

test('BaseApp.isDate: returns false for a number', () => {
  assert.ok(!makeApp().isDate(1234567890));
});

test('BaseApp.isDate: returns false for a plain object', () => {
  assert.ok(!makeApp().isDate({ year: 2026 }));
});

test('BaseApp.isDate: returns false for null', () => {
  assert.ok(!makeApp().isDate(null));
});

// ─── toLabel ──────────────────────────────────────────────────────────────────

test('BaseApp.toLabel: converts camelCase to title case with spaces', () => {
  assert.strictEqual(makeApp().toLabel('cashBalance'), 'Cash Balance');
});

test('BaseApp.toLabel: converts underscores to spaces', () => {
  assert.strictEqual(makeApp().toLabel('net_worth'), 'Net Worth');
});

test('BaseApp.toLabel: handles single word', () => {
  assert.strictEqual(makeApp().toLabel('cash'), 'Cash');
});

test('BaseApp.toLabel: handles consecutive caps', () => {
  const result = makeApp().toLabel('totalUSA');
  assert.ok(result.includes('Total'), `expected "Total" in "${result}"`);
});

// ─── getNestedProperty ────────────────────────────────────────────────────────

test('BaseApp.getNestedProperty: retrieves a simple top-level property', () => {
  assert.strictEqual(makeApp().getNestedProperty({ a: 42 }, 'a'), 42);
});

test('BaseApp.getNestedProperty: retrieves a nested property', () => {
  assert.strictEqual(makeApp().getNestedProperty({ a: { b: { c: 99 } } }, 'a.b.c'), 99);
});

test('BaseApp.getNestedProperty: returns undefined for missing path', () => {
  assert.strictEqual(makeApp().getNestedProperty({ a: 1 }, 'a.b.c'), undefined);
});

// ─── toDisplayCurrency ────────────────────────────────────────────────────────

test('BaseApp.toDisplayCurrency: returns same value when native matches displayCurrency', () => {
  const app = makeApp();
  app.displayCurrency = 'USD';
  assert.strictEqual(app.toDisplayCurrency(1000, 'USD', 1.5), 1000);
});

test('BaseApp.toDisplayCurrency: converts USD to AUD by multiplying by rate', () => {
  const app = makeApp();
  app.displayCurrency = 'AUD';
  assert.strictEqual(app.toDisplayCurrency(100, 'USD', 1.5), 150);
});

test('BaseApp.toDisplayCurrency: converts AUD to USD by dividing by rate', () => {
  const app = makeApp();
  app.displayCurrency = 'USD';
  assert.strictEqual(app.toDisplayCurrency(150, 'AUD', 1.5), 100);
});

// ─── setFormatDate ────────────────────────────────────────────────────────────

test('BaseApp.setFormatDate: updates _formatDate to the new function', () => {
  const app    = makeApp();
  const myFmt  = d => 'custom:' + d.getFullYear();
  app.setFormatDate(myFmt);
  assert.strictEqual(app._formatDate, myFmt);
});

test('BaseApp.setFormatDate: new formatter is used by fmtVal for Date values', () => {
  const app   = makeApp();
  const d     = new Date(2030, 5, 15);
  app.setFormatDate(() => 'FIXED');
  assert.strictEqual(app.fmtVal(d), 'FIXED');
});

// ─── buildActionDetail ────────────────────────────────────────────────────────

test('BaseApp.buildActionDetail: returns changes array', () => {
  const app   = makeApp();
  const entry = {
    prevState:      { cash: 100 },
    nextState:      { cash: 200 },
    emittedActions: [],
    action:         { type: 'ADD_CASH', amount: 100 },
  };
  const detail = app.buildActionDetail(entry);
  assert.ok(Array.isArray(detail.changes));
  assert.strictEqual(detail.changes.length, 1);
  assert.strictEqual(detail.changes[0].field, 'cash');
});

test('BaseApp.buildActionDetail: emitted is "(none)" when emittedActions is empty', () => {
  const app   = makeApp();
  const entry = {
    prevState:      { cash: 100 },
    nextState:      { cash: 100 },
    emittedActions: [],
    action:         { type: 'NOOP' },
  };
  assert.strictEqual(app.buildActionDetail(entry).emitted, '(none)');
});

test('BaseApp.buildActionDetail: emitted lists action types when actions were emitted', () => {
  const app   = makeApp();
  const entry = {
    prevState:      { cash: 100 },
    nextState:      { cash: 100 },
    emittedActions: [{ type: 'TAX_DUE' }, { type: 'NOTIFY' }],
    action:         { type: 'SELL' },
  };
  const { emitted } = app.buildActionDetail(entry);
  assert.ok(emitted.includes('TAX_DUE'),  `expected "TAX_DUE" in "${emitted}"`);
  assert.ok(emitted.includes('NOTIFY'),   `expected "NOTIFY" in "${emitted}"`);
});

test('BaseApp.buildActionDetail: actionPayload excludes underscore-prefixed keys', () => {
  const app   = makeApp();
  const entry = {
    prevState:      {},
    nextState:      {},
    emittedActions: [],
    action:         { type: 'FOO', amount: 50, _internal: 'hidden' },
  };
  const payload = JSON.parse(app.buildActionDetail(entry).actionPayload);
  assert.ok('type'   in payload,     '"type" should be in payload');
  assert.ok('amount' in payload,     '"amount" should be in payload');
  assert.ok(!('_internal' in payload), '"_internal" should be excluded');
});

// ─── getNodeDetail ────────────────────────────────────────────────────────────

test('BaseApp.getNodeDetail: returns a JSON string', () => {
  const app  = makeApp();
  const node = {
    stateBefore: { cash: 100 },
    stateAfter:  { cash: 250 },
    type:        'ADD_CASH',
  };
  const result = app.getNodeDetail(node);
  assert.ok(typeof result === 'string');
  assert.doesNotThrow(() => JSON.parse(result));
});

test('BaseApp.getNodeDetail: includes stateDiff in the result', () => {
  const app  = makeApp();
  const node = {
    stateBefore: { cash: 100 },
    stateAfter:  { cash: 250 },
  };
  const parsed = JSON.parse(app.getNodeDetail(node));
  assert.ok('stateDiff' in parsed, 'result should include "stateDiff"');
  assert.ok(Array.isArray(parsed.stateDiff));
  assert.strictEqual(parsed.stateDiff[0].field, 'cash');
});
