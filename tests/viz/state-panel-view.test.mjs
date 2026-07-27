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
import { APP_EVENTS }     from '../../src/visualization/app-display-settings.js';
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

// ─── showNodeDetail ───────────────────────────────────────────────────────────

function makeEntry() {
  return {
    seq:        0,
    date:       new Date(2025, 0, 1),
    event:      { type: 'TEST_EVENT', name: 'Test Event' },
    action:     { instanceId: 'abc', parentId: null, rootId: null, siblingIndex: 0,
                  nodeId: null, type: 'TEST_ACTION', name: 'Test Action', data: {} },
    reducer:    { name: 'TestReducer', nodeId: null },
    stateDiff:  [],
    emittedInstanceIds: [],
    emittedTypes: [],
  };
}

test('StatePanelView.showNodeDetail: does not throw when #actionPanelDetails is absent', () => {
  const panel = makePanel();
  // Stub _buildActionDetailEl to avoid template lookup in jsdom
  panel._buildActionDetailEl = () => document.createElement('div');
  assert.doesNotThrow(() => panel.showNodeDetail(makeEntry()));
});

test('StatePanelView.showNodeDetail: calls onShowActionDetail before writing to the container', () => {
  const panel = makePanel();
  panel._buildActionDetailEl = () => document.createElement('div');

  const order = [];

  const container = document.createElement('div');
  container.id = 'actionPanelDetails';
  document.body.appendChild(container);

  const origReplaceChildren = container.replaceChildren.bind(container);
  container.replaceChildren = (...args) => {
    order.push('replaceChildren');
    origReplaceChildren(...args);
  };

  panel.onShowActionDetail = () => { order.push('onShowActionDetail'); };

  try {
    panel.showNodeDetail(makeEntry());
    assert.deepEqual(order, ['onShowActionDetail', 'replaceChildren'],
      'onShowActionDetail must fire before replaceChildren');
  } finally {
    container.remove();
  }
});

test('StatePanelView.showNodeDetail: renders content into #actionPanelDetails', () => {
  const panel = makePanel();
  const sentinel = document.createElement('span');
  sentinel.id = 'sentinel';
  panel._buildActionDetailEl = () => sentinel;

  const container = document.createElement('div');
  container.id = 'actionPanelDetails';
  document.body.appendChild(container);

  try {
    panel.showNodeDetail(makeEntry());
    assert.ok(container.contains(sentinel), 'sentinel element should be inside #actionPanelDetails');
  } finally {
    container.remove();
  }
});

// ─── _subtreeTouchedPath ──────────────────────────────────────────────────────

function makeMockEg(nodes = [], childMap = {}) {
  const nodeMap = new Map(nodes.map(n => [n.id, n]));
  return {
    getExecutionNodes: () => nodes,
    getChildren: (id) => (childMap[id] ?? []).map(cid => nodeMap.get(cid)).filter(Boolean),
    getParent: (id) => null,
  };
}

test('StatePanelView._subtreeTouchedPath: reducer node that touched the path returns true', () => {
  const panel = makePanel();
  const reducer = { id: 'r1', kind: 'reducer', meta: { stateDiff: [{ field: 'usSavingsAccount.balance', before: 100, after: 200 }] } };
  const eg = makeMockEg([reducer], {});
  assert.strictEqual(panel._subtreeTouchedPath(reducer, 'usSavingsAccount.balance', eg), true);
});

test('StatePanelView._subtreeTouchedPath: reducer node that did NOT touch the path returns false', () => {
  const panel = makePanel();
  const reducer = { id: 'r1', kind: 'reducer', meta: { stateDiff: [{ field: 'other.field', before: 1, after: 2 }] } };
  const eg = makeMockEg([reducer], {});
  assert.strictEqual(panel._subtreeTouchedPath(reducer, 'usSavingsAccount.balance', eg), false);
});

test('StatePanelView._subtreeTouchedPath: event node with child reducer that touched path returns true', () => {
  const panel = makePanel();
  const reducer = { id: 'r1', kind: 'reducer', meta: { stateDiff: [{ field: 'metrics.netWorth', before: 0, after: 500 }] } };
  const handler = { id: 'h1', kind: 'handler', meta: {} };
  const evNode  = { id: 'e1', kind: 'event', timestamp: new Date(), meta: {} };
  const eg = makeMockEg([evNode, handler, reducer], { e1: ['h1'], h1: ['r1'] });
  assert.strictEqual(panel._subtreeTouchedPath(evNode, 'metrics.netWorth', eg), true);
});

test('StatePanelView._subtreeTouchedPath: event node whose subtree only touches unrelated fields returns false', () => {
  const panel = makePanel();
  const reducer = { id: 'r1', kind: 'reducer', meta: { stateDiff: [{ field: 'unrelated', before: 1, after: 2 }] } };
  const evNode  = { id: 'e1', kind: 'event', timestamp: new Date(), meta: {} };
  const eg = makeMockEg([evNode, reducer], { e1: ['r1'] });
  assert.strictEqual(panel._subtreeTouchedPath(evNode, 'metrics.netWorth', eg), false);
});

test('StatePanelView._subtreeTouchedPath: reducer with empty stateDiff returns false', () => {
  const panel = makePanel();
  const reducer = { id: 'r1', kind: 'reducer', meta: { stateDiff: [] } };
  const eg = makeMockEg([reducer], {});
  assert.strictEqual(panel._subtreeTouchedPath(reducer, 'metrics.netWorth', eg), false);
});

test('StatePanelView._subtreeTouchedPath: reducer with no meta returns false', () => {
  const panel = makePanel();
  const reducer = { id: 'r1', kind: 'reducer', meta: {} };
  const eg = makeMockEg([reducer], {});
  assert.strictEqual(panel._subtreeTouchedPath(reducer, 'metrics.netWorth', eg), false);
});

// ─── Unified field rows + chart toggle (design 31 / R3, R4) ─────────────────────

test('renderState: numeric leaf becomes an lsp-metric-row with a chart toggle', () => {
  const panel = makePanel();
  const c = document.createElement('div');
  panel.renderState({ cash: 100 }, c);
  const row = c.querySelector('.lsp-metric-row');
  assert.ok(row, 'a metric row should be produced');
  assert.ok(row.querySelector('input.lsp-chart-toggle'), 'row has a chart toggle checkbox');
  assert.ok(row.querySelector('.lsp-metric-value').textContent.length > 0, 'value rendered');
});

test('renderState: checkbox checked-state reflects isPathCharted', () => {
  const panel = makePanel();
  panel.isPathCharted = (p) => p === 'cash';
  const c = document.createElement('div');
  panel.renderState({ cash: 100, tax: 5 }, c);
  const byLabel = (t) => [...c.querySelectorAll('.lsp-metric-row')]
    .find(r => r.querySelector('.lsp-metric-label').textContent === t)
    .querySelector('input.lsp-chart-toggle');
  assert.strictEqual(byLabel('Cash').checked, true);
  assert.strictEqual(byLabel('Tax').checked,  false);
});

test('renderState: toggling a row checkbox calls onChartToggle(path, active)', () => {
  const panel = makePanel();
  const calls = [];
  panel.onChartToggle = (path, active) => calls.push([path, active]);
  const c = document.createElement('div');
  panel.renderState({ cash: 100 }, c);
  const cb = c.querySelector('input.lsp-chart-toggle');
  cb.checked = true;
  cb.dispatchEvent(new Event('change'));
  assert.deepStrictEqual(calls, [['cash', true]]);
});

test('renderState: row checkbox click does not bubble to the row history handler', () => {
  const panel = makePanel();
  panel.onChartToggle = () => {};
  let rowClicked = false;
  const c = document.createElement('div');
  panel.renderState({ cash: 100 }, c);
  const row = c.querySelector('.lsp-metric-row');
  row.addEventListener('click', () => { rowClicked = true; });
  row.querySelector('input.lsp-chart-toggle').dispatchEvent(new MouseEvent('click', { bubbles: true }));
  assert.strictEqual(rowClicked, false, 'checkbox click is stopped from opening the modal');
});

// ─── Stable holdings paths (R11.3) ──────────────────────────────────────────────

test('renderState: deep-renders array-of-objects with stable id-addressed paths', () => {
  const panel = makePanel();
  panel._expandedSections.add('acct');
  panel._expandedSections.add('acct.holdings');
  panel._expandedSections.add('acct.holdings[id=sf]');
  const c = document.createElement('div');
  panel.renderState({ acct: { holdings: [{ id: 'sf', label: 'SF Bay', marketValue: 999 }] } }, c);
  const titles = [...c.querySelectorAll('.lsp-metric-label')].map(s => s.title);
  assert.ok(titles.includes('acct.holdings[id=sf].marketValue'),
    'holding numeric leaf uses a stable [id=..] path');
});

test('renderState: array element without id falls back to positional index', () => {
  const panel = makePanel();
  panel._expandedSections.add('rows');
  panel._expandedSections.add('rows.0');
  const c = document.createElement('div');
  panel.renderState({ rows: [{ v: 7 }] }, c);
  const titles = [...c.querySelectorAll('.lsp-metric-label')].map(s => s.title);
  assert.ok(titles.includes('rows.0.v'));
});

// ─── Collapsible sections (folding) ─────────────────────────────────────────────

test('renderState: sections are collapsed by default (header shown, body omitted)', () => {
  const panel = makePanel();
  const c = document.createElement('div');
  panel.renderState({ acct: { balance: 5 } }, c);
  assert.ok(c.querySelector('.lsp-section-header'), 'header is shown');
  assert.strictEqual(c.querySelector('.lsp-section-body'), null, 'body not built while collapsed');
  assert.strictEqual(c.querySelector('.lsp-section-caret').textContent, '▶');
});

test('renderState: an expanded section renders its body and a ▼ caret', () => {
  const panel = makePanel();
  panel._expandedSections.add('acct');
  const c = document.createElement('div');
  panel.renderState({ acct: { balance: 5 } }, c);
  assert.ok(c.querySelector('.lsp-section-body'), 'body built when expanded');
  assert.strictEqual(c.querySelector('.lsp-section-caret').textContent, '▼');
  const titles = [...c.querySelectorAll('.lsp-metric-label')].map(s => s.title);
  assert.ok(titles.includes('acct.balance'));
});

test('renderState: an active filter auto-expands matching sections', () => {
  const panel = makePanel();           // nothing in _expandedSections
  panel.setFilter('balance');
  const c = document.createElement('div');
  panel.renderState({ acct: { balance: 5 } }, c);
  assert.ok(c.querySelector('.lsp-section-body'), 'filter forces the section open');
  const labels = [...c.querySelectorAll('.lsp-metric-label')].map(s => s.textContent);
  assert.ok(labels.includes('Balance'));
});

// ─── Filter (R6) ────────────────────────────────────────────────────────────────

test('renderState: filter hides rows whose path does not match', () => {
  const panel = makePanel();
  panel.setFilter('marketValue');
  const c = document.createElement('div');
  panel.renderState({ acct: { holdings: [{ id: 'sf', marketValue: 999 }] }, cash: 5 }, c);
  const labels = [...c.querySelectorAll('.lsp-metric-label')].map(s => s.textContent);
  assert.ok(labels.includes('Market Value'), 'matching field shown');
  assert.ok(!labels.includes('Cash'),        'non-matching field hidden');
});

test('renderState: a section whose every descendant is filtered out is omitted', () => {
  const panel = makePanel();
  panel.setFilter('zzz-no-match');
  const c = document.createElement('div');
  panel.renderState({ acct: { holdings: [{ id: 'sf', marketValue: 999 }] } }, c);
  assert.strictEqual(c.querySelector('.lsp-section-header'), null, 'empty section header omitted');
});

// ─── Section tri-state select-all (R5) ──────────────────────────────────────────

test('renderHeaderRow: select-all is indeterminate when some descendants are charted', () => {
  const panel = makePanel();
  panel.onChartToggle = () => {};
  panel.isPathCharted = (p) => p === 'a.x';
  const c = document.createElement('div');
  panel.renderState({ a: { x: 1, y: 2 } }, c);
  const cb = c.querySelector('.lsp-section-header input.lsp-section-toggle');
  assert.ok(cb, 'section toggle present');
  assert.strictEqual(cb.indeterminate, true);
  assert.strictEqual(cb.checked, false);
});

test('renderHeaderRow: select-all checked when all descendants are charted', () => {
  const panel = makePanel();
  panel.onChartToggle = () => {};
  panel.isPathCharted = () => true;
  const c = document.createElement('div');
  panel.renderState({ a: { x: 1, y: 2 } }, c);
  const cb = c.querySelector('.lsp-section-toggle');
  assert.strictEqual(cb.checked, true);
  assert.strictEqual(cb.indeterminate, false);
});

test('renderHeaderRow: toggling select-all activates every descendant path', () => {
  const panel = makePanel();
  const calls = [];
  panel.onChartToggle = (p, a) => calls.push([p, a]);
  const c = document.createElement('div');
  panel.renderState({ a: { x: 1, y: 2 } }, c);
  const cb = c.querySelector('.lsp-section-toggle');
  cb.checked = true;
  cb.dispatchEvent(new Event('change'));
  assert.deepStrictEqual(calls.sort(), [['a.x', true], ['a.y', true]]);
});

test('renderHeaderRow: no select-all checkbox when onChartToggle is not wired', () => {
  const panel = makePanel();
  const c = document.createElement('div');
  panel.renderState({ a: { x: 1 } }, c);
  assert.strictEqual(c.querySelector('.lsp-section-toggle'), null);
});

// ─── appBus wiring ────────────────────────────────────────────────────────────

test('StatePanelView: DISPLAY_SETTINGS_CHANGED updates _formatDate', () => {
  const appBus = new EventBus();
  const panel  = new StatePanelView({ appBus });
  const newFmt = d => `Y:${d.getFullYear()}`;

  appBus.publish({ type: APP_EVENTS.DISPLAY_SETTINGS_CHANGED, formatDate: newFmt, currency: 'USD', theme: 'dark', timezone: 'utc' });

  assert.strictEqual(panel._formatDate, newFmt);
});

test('StatePanelView: initial _formatDate is taken from displaySettings.formatDate', () => {
  const initialFmt = d => `init:${d.getFullYear()}`;
  const fakeSettings = { formatDate: initialFmt };
  const panel = new StatePanelView({ displaySettings: fakeSettings, appBus: new EventBus() });

  assert.strictEqual(panel._formatDate, initialFmt);
});

// ─── _formatActionPayload: currency annotation (design 10 §Phase 4) ─────────────

import { StateSchemaRegistry } from '../../src/finance/services/state-schema-registry.js';
import { CurrencyConverter }   from '../../src/finance/fx/currency-converter.js';

function wiredPanel(displayCurrency, rate = 1.5) {
  const panel = makePanel();
  const reg = new StateSchemaRegistry();
  reg.currencyConverter = new CurrencyConverter();
  reg.displaySettings   = { displayCurrency };
  reg.rateStateProvider = () => ({ effectiveExchangeRates: { USD_AUD: rate } });
  panel.schemaRegistry = reg;
  panel.typeRegistry = {
    getAction: () => ({ fields: { amount: { kind: 'currency', opts: { code: 'USD' } } } }),
  };
  return panel;
}

test('_formatActionPayload: annotates a currency field with the display value', () => {
  const panel = wiredPanel('AUD', 1.5);
  const out = panel._formatActionPayload({ type: 'WAGES_INCOME_APPLY', data: { amount: 1000, residency: 'US' } });
  assert.ok(out.includes('1000 USD → '), `expected native+code in "${out}"`);
  assert.ok(/A\$1,500\.00/.test(out), `expected converted A$1,500.00 in "${out}"`);
  assert.ok(out.includes('"residency": "US"'), 'non-money fields stay verbatim');
});

test('_formatActionPayload: no annotation when display equals native', () => {
  const panel = wiredPanel('USD', 1.5);
  const out = panel._formatActionPayload({ type: 'WAGES_INCOME_APPLY', data: { amount: 1000 } });
  assert.ok(out.includes('"amount": 1000'), `expected raw amount in "${out}"`);
  assert.ok(!out.includes('→'), 'no conversion arrow when native==display');
});

test('_formatActionPayload: falls back to plain dump without TypeRegistry', () => {
  const panel = makePanel();
  const out = panel._formatActionPayload({ type: 'X', data: { amount: 1000 } });
  assert.ok(out.includes('"amount": 1000'));
});

// ─── Display names (design 70 §6.1) ─────────────────────────────────────────

/**
 * Panel wired to a real StateSchemaRegistry carrying display records, so the
 * reroute is exercised against the actual resolver (and the registry's value
 * formatting still works alongside it).
 */
function namedPanel(names) {
  const panel = makePanel();
  const reg   = new StateSchemaRegistry();
  for (const [stateKey, { name, country, kind }] of Object.entries(names)) {
    reg.registerDisplayRecord(stateKey, { name, country }, kind ?? 'account');
  }
  panel.schemaRegistry = reg;
  return panel;
}

test('renderState: an account section renders its display name, not the beautified key', () => {
  const panel = namedPanel({ usSavings2Account: { name: 'Shared Checking', country: 'US' } });
  const c = document.createElement('div');
  panel.renderState({ usSavings2Account: { balance: 5 } }, c);
  const header = c.querySelector('.lsp-section-label');
  assert.strictEqual(header.textContent, 'US Shared Checking');
  assert.strictEqual(header.title, 'usSavings2Account', 'raw stateKey stays reachable on hover');
});

test('renderState: an unnamed section still renders toLabel(key) — nothing regresses', () => {
  const panel = namedPanel({ usSavings2Account: { name: 'Shared Checking', country: 'US' } });
  const c = document.createElement('div');
  panel.renderState({ effectiveGrowthRates: { EQUITY_US: 0.07 } }, c);
  assert.strictEqual(c.querySelector('.lsp-section-label').textContent, 'Effective Growth Rates');
});

test('renderState: sub-field rows keep their own field labels under a named section', () => {
  const panel = namedPanel({ beq1IraAccount: { name: "Mother's IRA", country: 'US' } });
  panel._expandedSections.add('beq1IraAccount');
  const c = document.createElement('div');
  panel.renderState({ beq1IraAccount: { balance: 5 } }, c);
  assert.strictEqual(c.querySelector('.lsp-section-label').textContent, "US Mother's IRA");
  const labels = [...c.querySelectorAll('.lsp-metric-label')].map(s => s.textContent);
  assert.ok(labels.includes('Balance'), 'the field row still names the field');
});

test('renderState: a named numeric leaf and static leaf both use the display name', () => {
  const panel = namedPanel({ 'people.p1': { name: 'Marge', kind: 'person' } });
  const c = document.createElement('div');
  panel._expandedSections.add('people');
  panel.renderState({ people: { p1: 7 } }, c);
  const lbl = c.querySelector('.lsp-metric-label');
  assert.strictEqual(lbl.textContent, 'Marge');
});

test('renderState: a static (non-numeric) row exposes its path as a tooltip', () => {
  const panel = makePanel();
  const c = document.createElement('div');
  panel.renderState({ residency: 'AU' }, c);
  const lbl = c.querySelector('.lsp-static-row .lsp-metric-label');
  assert.strictEqual(lbl.textContent, 'Residency');
  assert.strictEqual(lbl.title, 'residency');
});

test('_renderMetricsPanel: a per-account balance metric shows the account name', () => {
  const panel = namedPanel({ usSavings2Account: { name: 'Shared Checking', country: 'US' } });
  const c = document.createElement('div');
  panel._renderMetricsPanel({ usSavings2Account: 1000, netWorth: 5000 }, c);
  const labels = [...c.querySelectorAll('.lsp-metric-label')].map(s => s.textContent);
  assert.ok(labels.includes('US Shared Checking'), 'account metric renamed');
  assert.ok(labels.includes('Net Worth'),          'a true metric keeps toLabel');
});

test('_pathLabel: resolves the owning record and keeps the field name', () => {
  const panel = namedPanel({ usSavings2Account: { name: 'Shared Checking', country: 'US' } });
  assert.strictEqual(panel._pathLabel('usSavings2Account.balance'), 'US Shared Checking — Balance');
  assert.strictEqual(panel._pathLabel('usSavings2Account'),         'US Shared Checking');
  assert.strictEqual(panel._pathLabel('cumulativeTaxesPaid'),       'Cumulative Taxes Paid');
});

test('display names are inert without a schema registry', () => {
  const panel = makePanel();
  const c = document.createElement('div');
  panel.renderState({ usSavings2Account: { balance: 5 } }, c);
  assert.strictEqual(c.querySelector('.lsp-section-label').textContent, 'Us Savings2 Account');
});
