/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import assert from 'node:assert/strict';
import { ChartView } from '../../../src/visualization/chart/chart-view.js';
import { StateSchemaRegistry } from '../../../src/finance/services/state-schema-registry.js';
import { CurrencyConverter }   from '../../../src/finance/fx/currency-converter.js';

// ─── DOM setup ────────────────────────────────────────────────────────────────
// Provide the two DOM fixtures ChartView needs: a canvas with a parent div
// (for _buildControls) and the filter bar template + container.

beforeEach(() => {
  document.body.innerHTML = `
    <div id="chartWrap">
      <canvas id="testCanvas"></canvas>
    </div>
  `;
  global.requestAnimationFrame = cb => setTimeout(cb, 0);
  global.performance = global.performance ?? { now: () => Date.now() };
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeView(opts = {}) {
  const canvas   = document.getElementById('testCanvas');
  const simStart = new Date(2025, 0, 1);
  const simEnd   = new Date(2030, 0, 1);
  return new ChartView({ canvas, simStart, simEnd, ...opts });
}

const D1 = new Date(2025, 0, 1);
const D2 = new Date(2025, 6, 1);

// ─── Constructor ──────────────────────────────────────────────────────────────

test('ChartView: constructor initialises with no series and not running', () => {
  const view = makeView();
  assert.strictEqual(view.running,          false);
  assert.strictEqual(view._seriesMap.size,  0);
  assert.strictEqual(view._colorIdx,        0);
  assert.strictEqual(view._chart,           null);
});

test('ChartView: constructor stores optional series config', () => {
  const series = [{ key: 'cash', color: '#fff', label: 'Cash' }];
  const view   = makeView({ series });
  assert.strictEqual(view._seriesConfig.get('cash').label, 'Cash');
});

// ─── startViz / stopViz ───────────────────────────────────────────────────────

test('ChartView.stopViz: sets running to false and destroys Chart', () => {
  const view = makeView();
  view.startViz();
  view.stopViz();
  assert.strictEqual(view.running, false);
  assert.strictEqual(view._chart,  null);
});

test('ChartView.stopViz: is safe before startViz', () => {
  assert.doesNotThrow(() => makeView().stopViz());
});


// ─── addSnapshot ─────────────────────────────────────────────────────────────

test('ChartView.addSnapshot: discovers new series in _seriesMap', () => {
  const view = makeView();
  view.startViz();
  view.addSnapshot(D1, { balance: 1000 });
  assert.strictEqual(view._seriesMap.size, 1);
  assert.ok(view._seriesMap.has('balance'));
});

test('ChartView.addSnapshot: multiple keys create multiple series', () => {
  const view = makeView();
  view.startViz();
  view.addSnapshot(D1, { a: 1, b: 2, c: 3 });
  assert.strictEqual(view._seriesMap.size, 3);
});

test('ChartView.addSnapshot: appends data point to series', () => {
  const view = makeView();
  view.startViz();
  view.addSnapshot(D1, { balance: 1000 });
  const { dataArr } = view._seriesMap.get('balance');
  assert.strictEqual(dataArr.length, 1);
  assert.strictEqual(dataArr[0][1], 1000);
});

test('ChartView.addSnapshot: same timestamp updates existing point in-place', () => {
  const view = makeView();
  view.startViz();
  view.addSnapshot(D1, { balance: 1000 });
  view.addSnapshot(D1, { balance: 2000 });
  const { dataArr } = view._seriesMap.get('balance');
  assert.strictEqual(dataArr.length, 1);
  assert.strictEqual(dataArr[0][1], 2000);
});

test('ChartView.addSnapshot: different timestamps create separate points', () => {
  const view = makeView();
  view.startViz();
  view.addSnapshot(D1, { balance: 1000 });
  view.addSnapshot(D2, { balance: 2000 });
  const { dataArr } = view._seriesMap.get('balance');
  assert.strictEqual(dataArr.length, 2);
});

test('ChartView.addSnapshot: non-numeric values are skipped', () => {
  const view = makeView();
  view.startViz();
  view.addSnapshot(D1, { balance: 1000, label: 'hello', obj: {} });
  assert.strictEqual(view._seriesMap.size, 1);
  assert.ok(view._seriesMap.has('balance'));
});

test('ChartView.addSnapshot: boolean values are accepted as 0/1', () => {
  const view = makeView();
  view.startViz();
  view.addSnapshot(D1, { active: true });
  assert.ok(view._seriesMap.has('active'));
  const { dataArr } = view._seriesMap.get('active');
  assert.strictEqual(dataArr[0][1], 1);
});

test('ChartView.addSnapshot: null/undefined data is a no-op', () => {
  const view = makeView();
  view.startViz();
  assert.doesNotThrow(() => view.addSnapshot(D1, null));
  assert.doesNotThrow(() => view.addSnapshot(D1, undefined));
  assert.strictEqual(view._seriesMap.size, 0);
});


test('ChartView.addSnapshot: increments _colorIdx per new series', () => {
  const view = makeView();
  view.startViz();
  view.addSnapshot(D1, { a: 1, b: 2 });
  assert.strictEqual(view._colorIdx, 2);
});

// ─── setDatasetVisible ────────────────────────────────────────────────────────

test('ChartView.setDatasetVisible(false): adds key to _hiddenSeries', () => {
  const view = makeView();
  view.setDatasetVisible('balance', false);
  assert.ok(view._hiddenSeries.has('balance'));
});

test('ChartView.setDatasetVisible(true): removes key from _hiddenSeries', () => {
  const view = makeView();
  view.setDatasetVisible('balance', false);
  view.setDatasetVisible('balance', true);
  assert.ok(!view._hiddenSeries.has('balance'));
});

test('ChartView.setDatasetVisible: does not affect other keys in _hiddenSeries', () => {
  const view = makeView();
  view.setDatasetVisible('a', false);
  assert.ok(!view._hiddenSeries.has('b'));
});

test('ChartView.setDatasetVisible: is a no-op when chart is not initialised', () => {
  const view = makeView();
  assert.doesNotThrow(() => view.setDatasetVisible('balance', false));
});

test('ChartView.setDatasetVisible: is a no-op for an unknown series key', () => {
  const view = makeView();
  view.startViz();
  assert.doesNotThrow(() => view.setDatasetVisible('nosuchkey', false));
});

// ─── resetHistory ─────────────────────────────────────────────────────────────

test('ChartView.resetHistory: clears _seriesMap', () => {
  const view = makeView();
  view.startViz();
  view.addSnapshot(D1, { balance: 1000 });
  view.resetHistory();
  assert.strictEqual(view._seriesMap.size, 0);
});

test('ChartView.resetHistory: resets _colorIdx to 0', () => {
  const view = makeView();
  view.startViz();
  view.addSnapshot(D1, { a: 1, b: 2 });
  view.resetHistory();
  assert.strictEqual(view._colorIdx, 0);
});


test('ChartView.resetHistory: new snapshots can be added after reset', () => {
  const view = makeView();
  view.startViz();
  view.addSnapshot(D1, { balance: 1000 });
  view.resetHistory();
  view.addSnapshot(D2, { income: 500 });
  assert.strictEqual(view._seriesMap.size, 1);
  assert.ok(view._seriesMap.has('income'));
});

test('ChartView.resetHistory: is safe before startViz', () => {
  assert.doesNotThrow(() => makeView().resetHistory());
});

// ─── removeSeries ─────────────────────────────────────────────────────────────

test('ChartView.removeSeries: deletes the series from _seriesMap', () => {
  const view = makeView();
  view.startViz();
  view.addSnapshot(D1, { a: 1, b: 2 });
  view.removeSeries('a');
  assert.strictEqual(view._seriesMap.has('a'), false);
  assert.strictEqual(view._seriesMap.has('b'), true);
});

test('ChartView.removeSeries: clears kind and hidden bookkeeping', () => {
  const view = makeView();
  view.startViz();
  view.addSnapshot(D1, { a: 1 });
  view.setSeriesKind('a', 'currency');
  view.setDatasetVisible('a', false);
  view.removeSeries('a');
  assert.strictEqual(view._seriesKinds.has('a'),  false);
  assert.strictEqual(view._hiddenSeries.has('a'), false);
});

test('ChartView.removeSeries: is a no-op when chart is not initialised', () => {
  const view = makeView();
  assert.doesNotThrow(() => view.removeSeries('a'));
});

// ─── setRenderThrottle ────────────────────────────────────────────────────────

test('ChartView.setRenderThrottle: stores the throttle value', () => {
  const view = makeView();
  view.setRenderThrottle(500);
  assert.strictEqual(view._renderThrottleMs, 500);
});

test('ChartView.setRenderThrottle: null resets to 0', () => {
  const view = makeView();
  view.setRenderThrottle(500);
  view.setRenderThrottle(null);
  assert.strictEqual(view._renderThrottleMs, 0);
});

// ─── Display-currency conversion (design 10 §Phase 4) ──────────────────────────

function wiredView(displayCurrency, rate = 1.5) {
  const reg = new StateSchemaRegistry();
  reg.registerAccount('usSavingsAccount', { currency: { code: 'USD' }, type: 'savings' });
  const view = makeView({
    schemaRegistry:    reg,
    currencyConverter: new CurrencyConverter(),
    displaySettings:   { displayCurrency },
    rateStateProvider: () => ({ effectiveExchangeRates: { USD_AUD: rate } }),
  });
  view._seriesKinds.set('usSavingsAccount.balance', 'currency');
  return view;
}

test('ChartView._displaySeriesData: converts a USD series to AUD display', () => {
  const view = wiredView('AUD', 1.5);
  const out = view._displaySeriesData('usSavingsAccount.balance', [[0, 1000], [1, 2000]]);
  assert.deepStrictEqual(out, [[0, 1500], [1, 3000]]);
});

test('ChartView._displaySeriesData: native == display leaves data unchanged', () => {
  const view = wiredView('USD');
  const data = [[0, 1000]];
  assert.strictEqual(view._displaySeriesData('usSavingsAccount.balance', data), data);
});

test('ChartView._displaySeriesData: non-currency series is unchanged', () => {
  const view = wiredView('AUD');
  view._seriesKinds.set('someRate', 'rate');
  const data = [[0, 0.05]];
  assert.strictEqual(view._displaySeriesData('someRate', data), data);
});

test('ChartView._displaySeriesData: no recorded rate leaves data native', () => {
  const reg = new StateSchemaRegistry();
  reg.registerAccount('usSavingsAccount', { currency: { code: 'USD' }, type: 'savings' });
  const view = makeView({
    schemaRegistry:    reg,
    currencyConverter: new CurrencyConverter(),
    displaySettings:   { displayCurrency: 'AUD' },
    rateStateProvider: () => ({}),
  });
  view._seriesKinds.set('usSavingsAccount.balance', 'currency');
  const data = [[0, 1000]];
  assert.strictEqual(view._displaySeriesData('usSavingsAccount.balance', data), data);
});

test('ChartView._displaySeriesData: without conversion wiring, data is unchanged', () => {
  const view = makeView();
  view._seriesKinds.set('usSavingsAccount.balance', 'currency');
  const data = [[0, 1000]];
  assert.strictEqual(view._displaySeriesData('usSavingsAccount.balance', data), data);
});

test('ChartView._displaySeriesData: metrics.<account> converts via injected registry (kind says metric)', () => {
  // design 10 §Phase 4 — RecordBalanceAction stores account balances under
  // metrics.<stateKey>; state-paths types them 'metric', but registerAccount
  // stamps them as the account currency. Conversion must use the injected registry.
  const reg = new StateSchemaRegistry();
  reg.registerAccount('usStockAccount', { currency: { code: 'USD' }, type: 'brokerage' });
  assert.equal(reg.resolve('metrics.usStockAccount').currencyCode, 'USD');

  const view = makeView({
    schemaRegistry: reg,
    currencyConverter: new CurrencyConverter(),
    displaySettings: { displayCurrency: 'AUD' },
    rateStateProvider: () => ({ effectiveExchangeRates: { USD_AUD: 1.55 } }),
  });
  view._seriesKinds.set('metrics.usStockAccount', 'metric'); // what typeForPath would set
  const out = view._displaySeriesData('metrics.usStockAccount', [[0, 1000], [1, 2000]]);
  assert.deepStrictEqual(out, [[0, 1550], [1, 3100]]);
});
