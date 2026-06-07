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
import { ChartController } from '../../../src/visualization/chart/chart-controller.js';
import { ChartPresenter }  from '../../../src/visualization/chart/chart-presenter.js';
import { EventBus }        from '../../../src/simulation-framework/event-bus.js';
import { EXECUTION_KINDS, EXECUTION_PHASES } from '../../../src/simulation-framework/bus-messages.js';

// ─── DOM / globals ──────────────────────────────────────────────────────────────

beforeEach(() => {
  document.body.innerHTML = '';
  global.requestAnimationFrame = cb => setTimeout(cb, 0);
  global.performance = global.performance ?? { now: () => Date.now() };
});

// ─── Mock view ──────────────────────────────────────────────────────────────────
// Records calls without needing the Chart library.

function makeMockView() {
  const calls = {
    addSnapshot:       [],
    setDatasetVisible: [],
    setSeriesKind:     [],
    setSeriesBackfilled: [],
    removeSeries:      [],
    resetHistory:      0,
    startViz:          0,
    stopViz:           0,
    addAnnotation:     [],
    removeAnnotation:  [],
  };
  return {
    calls,
    running: false,
    addSnapshot(date, data)         { calls.addSnapshot.push({ date, data }); },
    setDatasetVisible(key, visible) { calls.setDatasetVisible.push({ key, visible }); },
    setSeriesKind(key, kind)        { calls.setSeriesKind.push({ key, kind }); },
    setSeriesBackfilled(key, on)    { calls.setSeriesBackfilled.push({ key, on }); },
    removeSeries(key)               { calls.removeSeries.push(key); },
    resetHistory()                  { calls.resetHistory++; },
    startViz()                      { calls.startViz++; this.running = true; },
    stopViz()                       { calls.stopViz++;  this.running = false; },
    addAnnotation(id, opts)         { calls.addAnnotation.push({ id, opts }); },
    removeAnnotation(id)            { calls.removeAnnotation.push(id); },
    resize() {},
  };
}

function makePresenter(viewOverride) {
  const controller = new ChartController();
  const view       = viewOverride ?? makeMockView();
  const presenter  = new ChartPresenter({ controller, view });
  return { presenter, controller, view };
}

const D1 = new Date(2025, 0, 1);
const D2 = new Date(2025, 6, 1);

function makeSimBus() { return new EventBus(); }

function makeExecEndMsg(date, metrics = {}, extraState = {}) {
  return {
    type:          `EXECUTION_${EXECUTION_PHASES.END}`,
    kind:          EXECUTION_KINDS.EVENT,
    date:          date.toISOString(),
    stateSnapshot: { metrics, ...extraState },
  };
}

// ─── Lifecycle ──────────────────────────────────────────────────────────────────

test('ChartPresenter.startViz: delegates to view.startViz', () => {
  const { presenter, view } = makePresenter();
  presenter.startViz();
  assert.strictEqual(view.calls.startViz, 1);
});

test('ChartPresenter.stopViz: delegates to view.stopViz', () => {
  const { presenter, view } = makePresenter();
  presenter.stopViz();
  assert.strictEqual(view.calls.stopViz, 1);
});

// ─── Annotations ────────────────────────────────────────────────────────────────

test('ChartPresenter.addAnnotation: delegates to view', () => {
  const { presenter, view } = makePresenter();
  presenter.addAnnotation('evt1', { label: 'A', date: D1 });
  assert.strictEqual(view.calls.addAnnotation.length, 1);
  assert.strictEqual(view.calls.addAnnotation[0].id, 'evt1');
});

test('ChartPresenter.removeAnnotation: delegates to view', () => {
  const { presenter, view } = makePresenter();
  presenter.removeAnnotation('evt1');
  assert.deepStrictEqual(view.calls.removeAnnotation, ['evt1']);
});

// ─── _doRender — allow-list only (the hang fix; no auto-charting) ────────────────

test('_doRender: nothing is ingested when the active set is empty', () => {
  const { presenter, view } = makePresenter();
  const bus = makeSimBus();
  presenter.wireSimBus(bus);
  bus.publish(makeExecEndMsg(D1, { netWorth: 500_000, income: 120_000 }));
  presenter._doRender();
  assert.strictEqual(view.calls.addSnapshot.length, 0,
    'no auto-charting — only the active set is ingested');
});

test('_doRender: only active paths are ingested (metrics included)', () => {
  const { presenter, view } = makePresenter();
  const bus = makeSimBus();
  presenter.wireSimBus(bus);
  presenter.activatePath('metrics.netWorth');
  bus.publish(makeExecEndMsg(D1, { netWorth: 500_000, income: 120_000 }));
  presenter._doRender();
  const data = view.calls.addSnapshot[0].data;
  assert.strictEqual(data['metrics.netWorth'], 500_000);
  assert.strictEqual(data['metrics.income'],  undefined, 'unselected metric not ingested');
});

test('_doRender: non-active non-metrics paths are NOT ingested (the hang fix)', () => {
  const { presenter, view } = makePresenter();
  const bus = makeSimBus();
  presenter.wireSimBus(bus);
  presenter.activatePath('metrics.netWorth');
  bus.publish(makeExecEndMsg(D1, { netWorth: 1 }, { usSavingsAccount: { balance: 75_000 } }));
  presenter._doRender();
  const data = view.calls.addSnapshot[0].data;
  assert.strictEqual(data['usSavingsAccount.balance'], undefined,
    'non-active path must not be ingested');
  assert.strictEqual(data['metrics.netWorth'], 1);
});

test('_doRender: an activated non-metrics path IS ingested', () => {
  const { presenter, view } = makePresenter();
  const bus = makeSimBus();
  presenter.wireSimBus(bus);
  presenter.activatePath('usSavingsAccount.balance');
  bus.publish(makeExecEndMsg(D1, {}, { usSavingsAccount: { balance: 75_000 } }));
  presenter._doRender();
  const data = view.calls.addSnapshot[0].data;
  assert.strictEqual(data['usSavingsAccount.balance'], 75_000);
});

test('_doRender: reads a key-matched array path (holdings[id=..])', () => {
  const { presenter, view } = makePresenter();
  const bus = makeSimBus();
  presenter.wireSimBus(bus);
  presenter.activatePath('acct.holdings[id=sfbay].marketValue');
  bus.publish(makeExecEndMsg(D1, {}, {
    acct: { holdings: [{ id: 'other', marketValue: 1 }, { id: 'sfbay', marketValue: 999 }] },
  }));
  presenter._doRender();
  assert.strictEqual(view.calls.addSnapshot[0].data['acct.holdings[id=sfbay].marketValue'], 999);
});

test('_doRender: handles missing stateSnapshot gracefully', () => {
  const { presenter } = makePresenter();
  const bus = makeSimBus();
  presenter.wireSimBus(bus);
  bus.publish({ type: `EXECUTION_${EXECUTION_PHASES.END}`, kind: EXECUTION_KINDS.EVENT, date: D1.toISOString() });
  assert.doesNotThrow(() => presenter._doRender());
});

test('_doRender: empty stateSnapshot with no active paths adds nothing', () => {
  const { presenter, view } = makePresenter();
  const bus = makeSimBus();
  presenter.wireSimBus(bus);
  bus.publish({ type: `EXECUTION_${EXECUTION_PHASES.END}`, kind: EXECUTION_KINDS.EVENT, date: D1.toISOString(), stateSnapshot: {} });
  presenter._doRender();
  assert.strictEqual(view.calls.addSnapshot.length, 0);
});

test('_doRender: drains and processes each queued message', () => {
  const { presenter, view } = makePresenter();
  const bus = makeSimBus();
  presenter.wireSimBus(bus);
  presenter.activatePath('metrics.netWorth');
  bus.publish(makeExecEndMsg(D1, { netWorth: 1 }));
  bus.publish(makeExecEndMsg(D2, { netWorth: 2 }));
  presenter._doRender();
  assert.strictEqual(view.calls.addSnapshot.length, 2);
});

// ─── activatePath ───────────────────────────────────────────────────────────────

test('activatePath: adds to active set, discovers, makes visible', () => {
  const { presenter, controller, view } = makePresenter();
  presenter.activatePath('effectiveExchangeRates.USD_AUD');
  assert.ok(presenter.isPathActive('effectiveExchangeRates.USD_AUD'));
  assert.ok(controller.getAllKeys().includes('effectiveExchangeRates.USD_AUD'));
  const vis = view.calls.setDatasetVisible.filter(c => c.key === 'effectiveExchangeRates.USD_AUD' && c.visible);
  assert.strictEqual(vis.length, 1);
});

test('activatePath: resolves the series kind from the registry (not hard-coded unknown)', () => {
  const { presenter, view } = makePresenter();
  presenter.activatePath('effectiveExchangeRates.USD_AUD');
  const kindCall = view.calls.setSeriesKind.find(c => c.key === 'effectiveExchangeRates.USD_AUD');
  assert.ok(kindCall, 'setSeriesKind should be called');
  assert.notStrictEqual(kindCall.kind, 'unknown',
    'a typed FX path must resolve to a real kind, fixing the v1 hard-coded-unknown bug');
});

test('activatePath: backfills from fieldStore when provided', () => {
  const { presenter, view } = makePresenter();
  const fieldStore = {
    getOrBackfill(path) {
      if (path === 'metrics.netWorth') {
        return { series: [{ date: D1, value: 100_000 }, { date: D2, value: 110_000 }], backfilled: true };
      }
      return { series: [], backfilled: false };
    },
  };
  presenter.activatePath('metrics.netWorth', fieldStore);
  const snaps = view.calls.addSnapshot.filter(c => c.data['metrics.netWorth'] !== undefined);
  assert.strictEqual(snaps.length, 2);
  assert.strictEqual(snaps[0].data['metrics.netWorth'], 100_000);
  assert.strictEqual(snaps[1].data['metrics.netWorth'], 110_000);
});

test('activatePath: works without fieldStore (no throw)', () => {
  const { presenter } = makePresenter();
  assert.doesNotThrow(() => presenter.activatePath('some.path'));
});

// ─── deactivatePath / isPathActive ──────────────────────────────────────────────

test('deactivatePath: removes from active set and drops the view series', () => {
  const { presenter, view } = makePresenter();
  presenter.activatePath('usSavingsAccount.balance');
  presenter.deactivatePath('usSavingsAccount.balance');
  assert.strictEqual(presenter.isPathActive('usSavingsAccount.balance'), false);
  assert.deepStrictEqual(view.calls.removeSeries, ['usSavingsAccount.balance']);
});

test('deactivatePath: a deactivated path is no longer ingested', () => {
  const { presenter, view } = makePresenter();
  const bus = makeSimBus();
  presenter.wireSimBus(bus);
  presenter.activatePath('usSavingsAccount.balance');
  presenter.deactivatePath('usSavingsAccount.balance');
  bus.publish(makeExecEndMsg(D1, {}, { usSavingsAccount: { balance: 5 } }));
  presenter._doRender();
  const ingested = view.calls.addSnapshot.some(c => c.data['usSavingsAccount.balance'] !== undefined);
  assert.strictEqual(ingested, false);
});

// ─── resetHistory ───────────────────────────────────────────────────────────────

test('resetHistory: delegates to view.resetHistory', () => {
  const { presenter, view } = makePresenter();
  presenter.resetHistory();
  assert.strictEqual(view.calls.resetHistory, 1);
});

test('resetHistory: active-path selection survives a rewind', () => {
  const { presenter, view } = makePresenter();
  const bus = makeSimBus();
  presenter.wireSimBus(bus);
  presenter.activatePath('usSavingsAccount.balance');
  presenter.resetHistory();
  assert.ok(presenter.isPathActive('usSavingsAccount.balance'), 'active set must persist across reset');
  // On replay the path is still ingested.
  bus.publish(makeExecEndMsg(D1, {}, { usSavingsAccount: { balance: 9 } }));
  presenter._doRender();
  assert.ok(view.calls.addSnapshot.some(c => c.data['usSavingsAccount.balance'] === 9));
});

// ─── seedWatchlist ──────────────────────────────────────────────────────────────

test('seedWatchlist: activates all paths in the list', () => {
  const { presenter } = makePresenter();
  presenter.seedWatchlist(['metrics.netWorth', 'effectiveExchangeRates.USD_AUD']);
  assert.ok(presenter.isPathActive('metrics.netWorth'));
  assert.ok(presenter.isPathActive('effectiveExchangeRates.USD_AUD'));
});

test('seedWatchlist: no-op for null or empty list', () => {
  const { presenter, controller } = makePresenter();
  presenter.seedWatchlist(null);
  presenter.seedWatchlist([]);
  assert.strictEqual(controller.getAllKeys().length, 0);
});

// ─── wireSimBus filtering ───────────────────────────────────────────────────────

test('wireSimBus: only EXECUTION_END(EVENT) messages are queued', () => {
  const { presenter } = makePresenter();
  const bus = makeSimBus();
  presenter.wireSimBus(bus);
  bus.publish({ type: `EXECUTION_${EXECUTION_PHASES.END}`, kind: EXECUTION_KINDS.HANDLER, date: D1.toISOString() });
  assert.strictEqual(presenter._drainExecEndMsgs().length, 0);
});

// ─── R10.3 live buffering into the shared FieldSeriesStore ───────────────────────

test('_doRender: appends active-path values to the injected field store (R10.3)', () => {
  const { presenter } = makePresenter();
  const appends = [];
  presenter.fieldStore = { append: (path, date, value) => appends.push([path, value]), getOrBackfill: () => ({ series: [], backfilled: false }) };
  const bus = makeSimBus();
  presenter.wireSimBus(bus);
  presenter.activatePath('usSavingsAccount.balance');
  bus.publish(makeExecEndMsg(D1, {}, { usSavingsAccount: { balance: 4242 } }));
  presenter._doRender();
  assert.deepStrictEqual(appends, [['usSavingsAccount.balance', 4242]]);
});

// ─── R10.1 coarse (backfilled) series badge ─────────────────────────────────────

test('activatePath: a backfilled series is marked on the view (dashed)', () => {
  const { presenter, view } = makePresenter();
  const store = { getOrBackfill: () => ({ series: [{ date: D1, value: 5 }], backfilled: true }) };
  presenter.activatePath('metrics.netWorth', store);
  const mark = view.calls.setSeriesBackfilled.find(c => c.key === 'metrics.netWorth');
  assert.ok(mark && mark.on === true, 'series flagged backfilled');
});

test('_doRender: a live value clears the backfilled badge', () => {
  const { presenter, view } = makePresenter();
  const store = { append: () => {}, getOrBackfill: () => ({ series: [{ date: D1, value: 5 }], backfilled: true }) };
  presenter.fieldStore = store;
  const bus = makeSimBus();
  presenter.wireSimBus(bus);
  presenter.activatePath('metrics.netWorth', store);   // becomes backfilled
  bus.publish(makeExecEndMsg(D1, { netWorth: 9 }));
  presenter._doRender();                                 // live value arrives
  const last = view.calls.setSeriesBackfilled.filter(c => c.key === 'metrics.netWorth').at(-1);
  assert.strictEqual(last.on, false, 'badge cleared once live data lands');
});

// ─── R8.5 perf regression guard — _seriesMap tracks the active set, not the state ──

test('R8.5: only active paths reach the view, regardless of state size', () => {
  const { presenter, view } = makePresenter();
  const bus = makeSimBus();
  presenter.wireSimBus(bus);
  presenter.activatePath('metrics.netWorth');
  // A holdings-heavy snapshot with many numeric leaves — none should be ingested.
  const holdings = Array.from({ length: 200 }, (_, i) => ({ id: `h${i}`, marketValue: i }));
  bus.publish(makeExecEndMsg(D1, { netWorth: 1 }, { acct: { holdings } }));
  presenter._doRender();
  const keys = Object.keys(view.calls.addSnapshot[0].data);
  assert.deepStrictEqual(keys, ['metrics.netWorth'],
    'ingestion is O(active set), not O(state paths) — the hang guard');
});
