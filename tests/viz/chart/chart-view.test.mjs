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

// ─── DOM setup ────────────────────────────────────────────────────────────────
// Provide the two DOM fixtures ChartView needs: a canvas with a parent div
// (for _buildControls) and the filter bar template + container.

beforeEach(() => {
  document.body.innerHTML = `
    <div id="chartWrap">
      <canvas id="testCanvas"></canvas>
    </div>
    <div id="chartFilterContainer"></div>
    <template id="tpl-chart-filter-bar">
      <div class="tl-filter-bar">
        <div id="chart-metric-select"></div>
      </div>
    </template>
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

test('ChartView.startViz: sets running to true and creates Chart instance', () => {
  const view = makeView();
  view.startViz();
  assert.strictEqual(view.running, true);
  assert.ok(view._chart !== null, '_chart should be created');
});

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

test('ChartView.stopViz: removes filter bar element from DOM', () => {
  const view = makeView();
  view.mountFilterBar();
  assert.ok(view._filterBarEl !== null, 'filter bar should be mounted');
  view.stopViz();
  assert.strictEqual(view._filterBarEl, null);
  assert.strictEqual(document.getElementById('chartFilterContainer').childElementCount, 0);
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
  assert.strictEqual(dataArr[0].y, 1000);
});

test('ChartView.addSnapshot: same timestamp updates existing point in-place', () => {
  const view = makeView();
  view.startViz();
  view.addSnapshot(D1, { balance: 1000 });
  view.addSnapshot(D1, { balance: 2000 });
  const { dataArr } = view._seriesMap.get('balance');
  assert.strictEqual(dataArr.length, 1);
  assert.strictEqual(dataArr[0].y, 2000);
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
  assert.strictEqual(dataArr[0].y, 1);
});

test('ChartView.addSnapshot: null/undefined data is a no-op', () => {
  const view = makeView();
  view.startViz();
  assert.doesNotThrow(() => view.addSnapshot(D1, null));
  assert.doesNotThrow(() => view.addSnapshot(D1, undefined));
  assert.strictEqual(view._seriesMap.size, 0);
});

test('ChartView.addSnapshot: adds dataset to Chart.js when series first seen', () => {
  const view = makeView();
  view.startViz();
  view.addSnapshot(D1, { balance: 500 });
  assert.strictEqual(view._chart.data.datasets.length, 1);
  assert.strictEqual(view._chart.data.datasets[0]._seriesKey, 'balance');
});

test('ChartView.addSnapshot: increments _colorIdx per new series', () => {
  const view = makeView();
  view.startViz();
  view.addSnapshot(D1, { a: 1, b: 2 });
  assert.strictEqual(view._colorIdx, 2);
});

// ─── setDatasetVisible ────────────────────────────────────────────────────────

test('ChartView.setDatasetVisible(false): marks dataset hidden', () => {
  const view = makeView();
  view.startViz();
  view.addSnapshot(D1, { balance: 1000 });
  view.setDatasetVisible('balance', false);
  const ds = view._chart.data.datasets.find(d => d._seriesKey === 'balance');
  assert.strictEqual(ds.hidden, true);
});

test('ChartView.setDatasetVisible(true): marks dataset visible', () => {
  const view = makeView();
  view.startViz();
  view.addSnapshot(D1, { balance: 1000 });
  view.setDatasetVisible('balance', false);
  view.setDatasetVisible('balance', true);
  const ds = view._chart.data.datasets.find(d => d._seriesKey === 'balance');
  assert.strictEqual(ds.hidden, false);
});

test('ChartView.setDatasetVisible: does not affect other datasets', () => {
  const view = makeView();
  view.startViz();
  view.addSnapshot(D1, { a: 1, b: 2 });
  view.setDatasetVisible('a', false);
  const dsB = view._chart.data.datasets.find(d => d._seriesKey === 'b');
  assert.ok(dsB.hidden == null || dsB.hidden === false, 'b should not be hidden');
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

test('ChartView.resetHistory: clears Chart.js datasets', () => {
  const view = makeView();
  view.startViz();
  view.addSnapshot(D1, { balance: 1000 });
  view.resetHistory();
  assert.strictEqual(view._chart.data.datasets.length, 0);
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

// ─── mountFilterBar ───────────────────────────────────────────────────────────

test('ChartView.mountFilterBar: returns an element', () => {
  const view = makeView();
  const bar  = view.mountFilterBar();
  assert.ok(bar instanceof Element, 'should return a DOM element');
});

test('ChartView.mountFilterBar: second call returns the same element', () => {
  const view = makeView();
  const b1 = view.mountFilterBar();
  const b2 = view.mountFilterBar();
  assert.strictEqual(b1, b2);
});

test('ChartView.mountFilterBar: clears existing container content', () => {
  document.getElementById('chartFilterContainer').innerHTML = '<p>old</p>';
  const view = makeView();
  view.mountFilterBar();
  assert.strictEqual(
    document.getElementById('chartFilterContainer').querySelector('p'),
    null,
    'old content should be replaced'
  );
});

test('ChartView.mountFilterBar: returned element contains #chart-metric-select', () => {
  const view = makeView();
  const bar  = view.mountFilterBar();
  assert.ok(bar.querySelector('#chart-metric-select'), 'filter bar should include #chart-metric-select');
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
