/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

// ─── Helper ───────────────────────────────────────────────────────────────────
import {StatePanelView} from "../../src/apps/state-panel-view.js";
import assert   from 'node:assert/strict';

function makePanel() {
  return new StatePanelView();
}


// ─── getNodeDetail ────────────────────────────────────────────────────────────

test('StatePanelView.getNodeDetail: returns a JSON string', () => {
  const panel  = makePanel();
  const node = {
    stateBefore: { cash: 100 },
    stateAfter:  { cash: 250 },
    type:        'ADD_CASH',
  };
  const result = panel.getNodeDetail(node);
  assert.ok(typeof result === 'string');
  assert.doesNotThrow(() => JSON.parse(result));
});

test('StatePanelView.getNodeDetail: includes stateDiff in the result', () => {
  const panel  = makePanel();
  const node = {
    stateBefore: { cash: 100 },
    stateAfter:  { cash: 250 },
  };
  const parsed = JSON.parse(panel.getNodeDetail(node));
  assert.ok('stateDiff' in parsed, 'result should include "stateDiff"');
  assert.ok(Array.isArray(parsed.stateDiff));
  assert.strictEqual(parsed.stateDiff[0].field, 'cash');
});

// ─── buildActionDetail ────────────────────────────────────────────────────────

test('StatePanelView.buildActionDetail: returns changes array', () => {
  const panel  = makePanel();
  const entry = {
    prevState:      { cash: 100 },
    nextState:      { cash: 200 },
    emittedActions: [],
    action:         { type: 'ADD_CASH', amount: 100 },
  };
  const detail = panel.buildActionDetail(entry);
  assert.ok(Array.isArray(detail.changes));
  assert.strictEqual(detail.changes.length, 1);
  assert.strictEqual(detail.changes[0].field, 'cash');
});

test('StatePanelView.buildActionDetail: emitted is "(none)" when emittedActions is empty', () => {
  const panel  = makePanel();
  const entry = {
    prevState:      { cash: 100 },
    nextState:      { cash: 100 },
    emittedActions: [],
    action:         { type: 'NOOP' },
  };
  assert.strictEqual(panel.buildActionDetail(entry).emitted, '(none)');
});

test('StatePanelView.buildActionDetail: emitted lists action types when actions were emitted', () => {
  const panel  = makePanel();
  const entry = {
    prevState:      { cash: 100 },
    nextState:      { cash: 100 },
    emittedActions: [{ type: 'TAX_DUE' }, { type: 'NOTIFY' }],
    action:         { type: 'SELL' },
  };
  const { emitted } = panel.buildActionDetail(entry);
  assert.ok(emitted.includes('TAX_DUE'),  `expected "TAX_DUE" in "${emitted}"`);
  assert.ok(emitted.includes('NOTIFY'),   `expected "NOTIFY" in "${emitted}"`);
});

test('StatePanelView.buildActionDetail: actionPayload excludes underscore-prefixed keys', () => {
  const panel  = makePanel();
  const entry = {
    prevState:      {},
    nextState:      {},
    emittedActions: [],
    action:         { type: 'FOO', amount: 50, _internal: 'hidden' },
  };
  const payload = JSON.parse(panel.buildActionDetail(entry).actionPayload);
  assert.ok('type'   in payload,     '"type" should be in payload');
  assert.ok('amount' in payload,     '"amount" should be in payload');
  assert.ok(!('_internal' in payload), '"_internal" should be excluded');
});

// ─── getNestedProperty ────────────────────────────────────────────────────────

test('StatePanelView.getNestedProperty: retrieves a simple top-level property', () => {
  assert.strictEqual(makePanel().getNestedProperty({ a: 42 }, 'a'), 42);
});

test('StatePanelView.getNestedProperty: retrieves a nested property', () => {
  assert.strictEqual(makePanel().getNestedProperty({ a: { b: { c: 99 } } }, 'a.b.c'), 99);
});

test('StatePanelView.getNestedProperty: returns undefined for missing path', () => {
  assert.strictEqual(makePanel().getNestedProperty({ a: 1 }, 'a.b.c'), undefined);
});

// ─── toLabel ──────────────────────────────────────────────────────────────────

test('StatePanelView.toLabel: converts camelCase to title case with spaces', () => {
  assert.strictEqual(makePanel().toLabel('cashBalance'), 'Cash Balance');
});

test('StatePanelView.toLabel: converts underscores to spaces', () => {
  assert.strictEqual(makePanel().toLabel('net_worth'), 'Net Worth');
});

test('StatePanelView.toLabel: handles single word', () => {
  assert.strictEqual(makePanel().toLabel('cash'), 'Cash');
});

test('StatePanelView.toLabel: handles consecutive caps', () => {
  const result = makePanel().toLabel('totalUSA');
  assert.ok(result.includes('Total'), `expected "Total" in "${result}"`);
});

// ─── isDate ───────────────────────────────────────────────────────────────────

test('StatePanelView.isDate: returns true for a Date instance', () => {
  assert.ok(makePanel().isDate(new Date()));
});

test('StatePanelView.isDate: returns false for a string', () => {
  assert.ok(!makePanel().isDate('2026-01-01'));
});

test('StatePanelView.isDate: returns false for a number', () => {
  assert.ok(!makePanel().isDate(1234567890));
});

test('StatePanelView.isDate: returns false for a plain object', () => {
  assert.ok(!makePanel().isDate({ year: 2026 }));
});

test('StatePanelView.isDate: returns false for null', () => {
  assert.ok(!makePanel().isDate(null));
});

// ─── fmtArray ─────────────────────────────────────────────────────────────────

test('StatePanelView.fmtArray: returns empty string for non-array', () => {
  assert.strictEqual(makePanel().fmtArray('not-an-array'), '');
});

test('StatePanelView.fmtArray: formats empty array as "—"', () => {
  assert.strictEqual(makePanel().fmtArray([]), '—');
});

test('StatePanelView.fmtArray: joins elements with ", "', () => {
  const result = makePanel().fmtArray([1, 2, 3]);
  assert.ok(result.includes(','), `expected comma separator in "${result}"`);
});

test('StatePanelView.fmtArray: truncates arrays longer than 10 with "..."', () => {
  const big = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
  const result = makePanel().fmtArray(big);
  assert.ok(result.endsWith('...'), `expected "..." suffix in "${result}"`);
});

test('StatePanelView.fmtArray: does not truncate arrays of exactly 10', () => {
  const exact = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  const result = makePanel().fmtArray(exact);
  assert.ok(!result.endsWith('...'), `should not truncate 10-item array, got "${result}"`);
});
