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
import { FieldFormatter }      from '../../../src/visualization/state/field-format.js';

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

test('ChartView: a series label set by the presenter names it in the legend (design 101 R2)', () => {
  const view = makeView();
  view.setSeriesLabel('superAccount.balance', 'AU Super · Balance');
  assert.strictEqual(view._labelFor('superAccount.balance'), 'AU Super · Balance');
  view.removeSeries('superAccount.balance');
  assert.notStrictEqual(view._labelFor('superAccount.balance'), 'AU Super · Balance', 'dropped with the series');
});

test('ChartView._fmtSeriesValue: money in its plotted currency; the rest via the formatter', () => {
  const reg = new StateSchemaRegistry();
  reg.registerAccount('superAccount', { currency: { code: 'AUD' }, type: 'super' });
  const conv = { convert: (v, from, to) => (from === 'AUD' && to === 'USD' ? v * 0.65 : null) };
  const view = makeView({
    schemaRegistry: reg, currencyConverter: conv, rateStateProvider: () => ({}),
    displaySettings: { displayCurrency: 'USD' },
    formatter: new FieldFormatter({ registry: reg }),
  });
  assert.strictEqual(view._fmtSeriesValue('superAccount.balance', 650), '$650.00', 'converted: display currency');
  view._displaySettings = { displayCurrency: 'AUD' };
  assert.strictEqual(view._fmtSeriesValue('superAccount.balance', 1000), 'A$1,000.00', 'native: its own currency');
  assert.strictEqual(view._fmtSeriesValue('effectiveExchangeRates.USD_AUD', 1.55), '1.5500');
  assert.strictEqual(view._fmtSeriesValue('effectiveGrowthRates.EQUITY_US', 0.0715), '7.15%');
});

test('ChartView.setSeriesAxis: an override beats the kind; auto returns to it (design 101 W3)', () => {
  const view = makeView();
  view._seriesKinds.set('metrics.netWorth', 'currency');
  assert.strictEqual(view._axisIndexFor('metrics.netWorth'), 0);
  view.setSeriesAxis('metrics.netWorth', 'right');
  assert.strictEqual(view._axisIndexFor('metrics.netWorth'), 1);
  assert.ok([].concat(view._buildYAxes()).some(a => a.position === 'right'), 'a forced series opens the right axis');
  view.setSeriesAxis('metrics.netWorth', 'auto');
  assert.strictEqual(view._axisIndexFor('metrics.netWorth'), 0);
  view._seriesKinds.set('effectiveGrowthRates.EQUITY_US', 'rate');
  view.setSeriesAxis('effectiveGrowthRates.EQUITY_US', 'left');
  assert.strictEqual(view._axisIndexFor('effectiveGrowthRates.EQUITY_US'), 0, 'a rate can be forced left');
});

test('ChartView._buildYAxes: a rate-only right axis reads as percent (design 101 R-2)', () => {
  const view = makeView();
  view._seriesKinds.set('effectiveGrowthRates.EQUITY_US', 'rate');
  const right = [].concat(view._buildYAxes()).find(a => a.position === 'right');
  assert.strictEqual(right.axisLabel.formatter(0.05), '5%');
});

test('ChartView._buildYAxes: an FX multiplier on the right axis keeps plain numbers', () => {
  const view = makeView();
  view._seriesKinds.set('effectiveGrowthRates.EQUITY_US', 'rate');
  view._seriesKinds.set('effectiveExchangeRates.USD_AUD', 'fxRate');
  const right = [].concat(view._buildYAxes()).find(a => a.position === 'right');
  assert.strictEqual(right.axisLabel.formatter(1.55), '1.55');
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

test('ChartView._displaySeriesData: an account balance converts via the injected registry (kind says metric)', () => {
  // design 10 §Phase 4: whatever kind the view was told, conversion follows the
  // injected (stamped) registry, which knows the account's currency.
  const reg = new StateSchemaRegistry();
  reg.registerAccount('usStockAccount', { currency: { code: 'USD' }, type: 'brokerage' });
  assert.equal(reg.resolve('usStockAccount.balance').currencyCode, 'USD');

  const view = makeView({
    schemaRegistry: reg,
    currencyConverter: new CurrencyConverter(),
    displaySettings: { displayCurrency: 'AUD' },
    rateStateProvider: () => ({ effectiveExchangeRates: { USD_AUD: 1.55 } }),
  });
  view._seriesKinds.set('usStockAccount.balance', 'metric'); // a wrong kind must not stop conversion
  const out = view._displaySeriesData('usStockAccount.balance', [[0, 1000], [1, 2000]]);
  assert.deepStrictEqual(out, [[0, 1550], [1, 3100]]);
});

// ─── Real value basis: per-point deflation (design 79 §5) ──────────────────────

const Y = (y) => Date.UTC(y, 0, 1);

/** A view whose registry does the real restatement, as the app wires it. */
function realView(displayCurrency, { basis = 'real' } = {}) {
  const reg = new StateSchemaRegistry();
  reg.registerAccount('usSavingsAccount', { currency: { code: 'USD' }, type: 'savings' });
  const ds = { displayCurrency, valueBasis: basis };
  reg.currencyConverter = new CurrencyConverter();
  reg.displaySettings   = ds;
  const view = makeView({
    schemaRegistry:    reg,
    currencyConverter: reg._currencyConverter,
    displaySettings:   ds,
    // The LIVE rate — the one a single-factor shortcut would wrongly apply everywhere.
    rateStateProvider: () => ({ effectiveExchangeRates: { USD_AUD: 9 }, inflationAccumulator: { US: 9, AU: 9 } }),
  });
  view._seriesKinds.set('usSavingsAccount.balance', 'currency');
  view.addRateSample(Y(2026), { effectiveExchangeRates: { USD_AUD: 1.5 }, inflationAccumulator: { US: 1,   AU: 1 } });
  view.addRateSample(Y(2030), { effectiveExchangeRates: { USD_AUD: 1.4 }, inflationAccumulator: { US: 1.2, AU: 1.25 } });
  view.addRateSample(Y(2040), { effectiveExchangeRates: { USD_AUD: 1.2 }, inflationAccumulator: { US: 2,   AU: 2.4 } });
  return view;
}

test('ChartView real: each point divides by ITS OWN date\'s US level, not one factor', () => {
  const view = realView('USD');
  const out  = view._displaySeriesData('usSavingsAccount.balance',
    [[Y(2026), 1000], [Y(2035), 1200], [Y(2045), 4000]]);
  // sim start ÷ 1.0; 2035 reads the 2030 sample (nearest prior); 2045 the 2040 one.
  assert.deepStrictEqual(out, [[Y(2026), 1000], [Y(2035), 1000], [Y(2045), 2000]]);
  assert.deepStrictEqual(view._plotted.get('usSavingsAccount.balance'), { code: 'USD', basis: 'real' });
  assert.match(view._fmtSeriesValue('usSavingsAccount.balance', 1000), /^\$1,000\.00 real$/);
});

test('ChartView real: an AUD view converts at fx(t) AND divides by the AU level at t', () => {
  const view = realView('AUD');
  const [[, a], [, b]] = view._displaySeriesData('usSavingsAccount.balance', [[Y(2026), 1000], [Y(2041), 1000]]);
  assert.equal(a, 1500);                            // 1000 × 1.5 ÷ 1.0
  assert.ok(Math.abs(b - 1000 * 1.2 / 2.4) < 1e-9); // 1000 × 1.2 ÷ 2.4 — neither the live 9 nor US 2
});

test('ChartView real: a point before the first sample reads the first sample', () => {
  const view = realView('USD');
  assert.deepStrictEqual(view._displaySeriesData('usSavingsAccount.balance', [[Y(2020), 700]]), [[Y(2020), 700]]);
});

test('ChartView real: no rate track ⇒ plotted nominal and NOT labelled real', () => {
  const view = realView('USD');
  view._rateTrack = [];
  const data = [[Y(2030), 1000]];
  assert.strictEqual(view._displaySeriesData('usSavingsAccount.balance', data), data);
  assert.equal(view._plotted.has('usSavingsAccount.balance'), false);
  assert.doesNotMatch(view._fmtSeriesValue('usSavingsAccount.balance', 1000), /real/);
});

test('ChartView real: nominal basis is exactly the pre-design-79 path', () => {
  const view = realView('USD', { basis: 'nominal' });
  const data = [[Y(2045), 4000]];
  assert.strictEqual(view._displaySeriesData('usSavingsAccount.balance', data), data);
});

test('ChartView.addRateSample: collapses repeats, keeps order, and resets with history', () => {
  const view = makeView();
  const s = { effectiveExchangeRates: { USD_AUD: 1.5 }, inflationAccumulator: { US: 1 } };
  view.addRateSample(Y(2026), s);
  view.addRateSample(Y(2027), { ...s });                          // unchanged → dropped
  view.addRateSample(Y(2028), { ...s, inflationAccumulator: { US: 1.03 } });
  view.addRateSample(Y(2025), s);                                  // out of order → sorted in
  assert.deepStrictEqual(view._rateTrack.map(r => new Date(r.t).getUTCFullYear()), [2025, 2026, 2028]);
  view.resetHistory();
  assert.equal(view.hasRateTrack, false);
});
