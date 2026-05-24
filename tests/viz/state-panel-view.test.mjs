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
import { StatePanelView } from '../../src/visualization/simulation/state-panel-view.js';
import { EventBus }       from '../../src/simulation-framework/event-bus.js';
import { EXECUTION_KINDS, EXECUTION_PHASES } from '../../src/simulation-framework/bus-messages.js';
import assert from 'node:assert/strict';

beforeEach(() => {
  global.requestAnimationFrame = cb => setTimeout(cb, 0);
  global.performance = global.performance ?? { now: () => Date.now() };
});

function makePanel() {
  return new StatePanelView();
}

const D1 = new Date(2025, 0, 1);

function makeExecEndMsg(date = D1, state = { balance: 100 }) {
  return {
    type:          `EXECUTION_${EXECUTION_PHASES.END}`,
    kind:          EXECUTION_KINDS.EVENT,
    date:          date.toISOString(),
    stateSnapshot: state,
  };
}


// ─── getNodeDetail ────────────────────────────────────────────────────────────

test('StatePanelView.getNodeDetail: returns a JSON string', () => {
  const panel  = makePanel();
  const node = {
    stateDiff: [{ field: 'cash', before: 100, after: 250, delta: 150 }],
    type:        'ADD_CASH',
  };
  const result = panel.getNodeDetail(node);
  assert.ok(typeof result === 'string');
  assert.doesNotThrow(() => JSON.parse(result));
});

test('StatePanelView.getNodeDetail: includes stateDiff in the result', () => {
  const panel  = makePanel();
  const node = {
    stateDiff: [{ field: 'cash', before: 100, after: 250, delta: 150 }],
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
    stateDiff: [{ field: 'cash', before: 100, after: 200, delta: 100 }],
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
    stateDiff: [],
    emittedActions: [],
    action:         { type: 'NOOP' },
  };
  assert.strictEqual(panel.buildActionDetail(entry).emitted, '(none)');
});

test('StatePanelView.buildActionDetail: emitted lists action types when actions were emitted', () => {
  const panel  = makePanel();
  const entry = {
    stateDiff:    [],
    emittedTypes: ['TAX_DUE', 'NOTIFY'],
    action:       { type: 'SELL', name: 'Sell', data: {} },
  };
  const { emitted } = panel.buildActionDetail(entry);
  assert.ok(emitted.includes('TAX_DUE'),  `expected "TAX_DUE" in "${emitted}"`);
  assert.ok(emitted.includes('NOTIFY'),   `expected "NOTIFY" in "${emitted}"`);
});

test('StatePanelView.buildActionDetail: actionPayload includes type, name, and data sub-object', () => {
  const panel  = makePanel();
  const entry = {
    stateDiff:    [],
    emittedTypes: [],
    action:       { instanceId: 'abc', parentId: null, rootId: null, siblingIndex: 0,
                    nodeId: null, type: 'FOO', name: 'Foo', data: { amount: 50 } },
  };
  const payload = JSON.parse(panel.buildActionDetail(entry).actionPayload);
  assert.ok('type' in payload,               '"type" should be in payload');
  assert.ok('name' in payload,               '"name" should be in payload');
  assert.ok('data' in payload,               '"data" sub-object should be in payload');
  assert.strictEqual(payload.data.amount, 50, 'data.amount should be 50');
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

// ─── wireSimBus ───────────────────────────────────────────────────────────────

test('StatePanelView.wireSimBus: creates a drain function', () => {
  const panel = makePanel();
  const bus   = new EventBus();
  panel.wireSimBus(bus);
  assert.strictEqual(typeof panel._drainExecEndMsgs, 'function');
});

test('StatePanelView.wireSimBus: queues EXECUTION_END(EVENT) messages', () => {
  const panel = makePanel();
  const bus   = new EventBus();
  panel.wireSimBus(bus);
  bus.publish(makeExecEndMsg());
  const msgs = panel._drainExecEndMsgs();
  assert.strictEqual(msgs.length, 1);
});

test('StatePanelView.wireSimBus: rejects non-EVENT-kind messages', () => {
  const panel = makePanel();
  const bus   = new EventBus();
  panel.wireSimBus(bus);
  bus.publish({ type: `EXECUTION_${EXECUTION_PHASES.END}`, kind: EXECUTION_KINDS.ACTION, date: D1.toISOString() });
  assert.strictEqual(panel._drainExecEndMsgs().length, 0);
});

test('StatePanelView.wireSimBus: queued message carries the stateSnapshot', () => {
  const panel = makePanel();
  const bus   = new EventBus();
  panel.wireSimBus(bus);
  const state = { balance: 500 };
  bus.publish(makeExecEndMsg(D1, state));
  // Drain to verify the message arrived with the correct stateSnapshot
  const msgs = panel._drainExecEndMsgs();
  assert.strictEqual(msgs.length, 1);
  assert.deepStrictEqual(msgs[0].stateSnapshot, state);
});

test('StatePanelView.updateStatePanel: sets pending date and state', () => {
  const panel = makePanel();
  const state = { savings: 1000 };
  panel.updateStatePanel(D1, state);
  assert.strictEqual(panel._pendingDate,  D1);
  assert.strictEqual(panel._pendingState, state);
});

test('StatePanelView: setRenderThrottle inherited from BaseComponent', () => {
  const panel = makePanel();
  panel.setRenderThrottle(750);
  assert.strictEqual(panel._renderThrottleMs, 750);
});

// ─── _updateFailureBanner ─────────────────────────────────────────────────────

function makeChartPresenter() {
  const calls = { addAnnotation: [], removeAnnotation: [] };
  return {
    calls,
    addAnnotation(id, opts)  { calls.addAnnotation.push({ id, opts }); },
    removeAnnotation(id)     { calls.removeAnnotation.push(id); },
  };
}

test('StatePanelView._updateFailureBanner: shows banner when outOfFundsDate appears', () => {
  document.body.innerHTML = `
    <div id="failureBanner" style="display:none"></div>
    <span id="failureBannerDate"></span>
    <span id="failureBannerDeficit"></span>
    <span id="failureBannerMonths"></span>
  `;
  const panel = makePanel();
  const oofDate = new Date(2028, 5, 1);
  panel._updateFailureBanner({ outOfFundsDate: oofDate, cumulativeDeficit: 5000, deficitMonths: 3 });
  assert.strictEqual(document.getElementById('failureBanner').style.display, '',
    'banner should be visible when outOfFundsDate is present');
});

test('StatePanelView._updateFailureBanner: hides banner when outOfFundsDate clears', () => {
  document.body.innerHTML = `
    <div id="failureBanner"></div>
    <span id="failureBannerDate"></span>
    <span id="failureBannerDeficit"></span>
    <span id="failureBannerMonths"></span>
  `;
  const panel = makePanel();
  const oofDate = new Date(2028, 5, 1);
  // First render: banner appears
  panel._updateFailureBanner({ outOfFundsDate: oofDate });
  // Second render: no more OOF → should hide
  panel._updateFailureBanner({ outOfFundsDate: null });
  assert.strictEqual(document.getElementById('failureBanner').style.display, 'none',
    'banner should be hidden when outOfFundsDate clears');
});

test('StatePanelView._updateFailureBanner: calls chartPresenter.addAnnotation on first OOF', () => {
  document.body.innerHTML = `
    <div id="failureBanner"></div>
    <span id="failureBannerDate"></span>
    <span id="failureBannerDeficit"></span>
    <span id="failureBannerMonths"></span>
  `;
  const chart = makeChartPresenter();
  const panel = makePanel();
  const bus   = new EventBus();
  panel.wireSimBus(bus, { chartPresenter: chart });
  const oofDate = new Date(2029, 0, 1);
  panel._updateFailureBanner({ outOfFundsDate: oofDate });
  assert.strictEqual(chart.calls.addAnnotation.length, 1);
  assert.strictEqual(chart.calls.addAnnotation[0].id, 'out_of_funds');
});

test('StatePanelView._updateFailureBanner: calls chartPresenter.removeAnnotation when OOF clears', () => {
  document.body.innerHTML = `
    <div id="failureBanner"></div>
    <span id="failureBannerDate"></span>
    <span id="failureBannerDeficit"></span>
    <span id="failureBannerMonths"></span>
  `;
  const chart = makeChartPresenter();
  const panel = makePanel();
  const bus   = new EventBus();
  panel.wireSimBus(bus, { chartPresenter: chart });
  const oofDate = new Date(2029, 0, 1);
  panel._updateFailureBanner({ outOfFundsDate: oofDate });
  panel._updateFailureBanner({ outOfFundsDate: null });
  assert.strictEqual(chart.calls.removeAnnotation.length, 1);
  assert.strictEqual(chart.calls.removeAnnotation[0], 'out_of_funds');
});

test('StatePanelView._updateFailureBanner: does not re-add annotation on repeated OOF renders', () => {
  document.body.innerHTML = `
    <div id="failureBanner"></div>
    <span id="failureBannerDate"></span>
    <span id="failureBannerDeficit"></span>
    <span id="failureBannerMonths"></span>
  `;
  const chart = makeChartPresenter();
  const panel = makePanel();
  const bus   = new EventBus();
  panel.wireSimBus(bus, { chartPresenter: chart });
  const oofDate = new Date(2029, 0, 1);
  panel._updateFailureBanner({ outOfFundsDate: oofDate });
  panel._updateFailureBanner({ outOfFundsDate: oofDate, cumulativeDeficit: 1000, deficitMonths: 1 });
  panel._updateFailureBanner({ outOfFundsDate: oofDate, cumulativeDeficit: 2000, deficitMonths: 2 });
  assert.strictEqual(chart.calls.addAnnotation.length, 1,
    'annotation should only be added once even when OOF state persists across renders');
});

test('StatePanelView._updateFailureBanner: works without chartPresenter (no annotation errors)', () => {
  document.body.innerHTML = `
    <div id="failureBanner"></div>
    <span id="failureBannerDate"></span>
    <span id="failureBannerDeficit"></span>
    <span id="failureBannerMonths"></span>
  `;
  const panel = makePanel();
  assert.doesNotThrow(() => {
    panel._updateFailureBanner({ outOfFundsDate: new Date(2029, 0, 1) });
    panel._updateFailureBanner({ outOfFundsDate: null });
  });
});

test('StatePanelView.wireSimBus: stores chartPresenter reference', () => {
  const panel = makePanel();
  const bus   = new EventBus();
  const chart = makeChartPresenter();
  panel.wireSimBus(bus, { chartPresenter: chart });
  assert.strictEqual(panel._chartPresenter, chart);
});
