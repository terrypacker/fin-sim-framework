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
import { FieldSeriesStore } from '../../src/visualization/state/field-series-store.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeStore() {
  return new FieldSeriesStore();
}

function makeHistory(snapshots) {
  return { snapshots };
}

const D1 = new Date(2025, 0, 1);
const D2 = new Date(2025, 6, 1);
const D3 = new Date(2026, 0, 1);

// ─── append ──────────────────────────────────────────────────────────────────

test('FieldSeriesStore.append: stores a data point', () => {
  const store = makeStore();
  store.append('metrics.netWorth', D1, 100_000);
  const buf = store.get('metrics.netWorth');
  assert.ok(buf !== null);
  assert.strictEqual(buf.length, 1);
  assert.strictEqual(buf[0].value, 100_000);
  assert.ok(buf[0].date instanceof Date);
});

test('FieldSeriesStore.append: accumulates multiple points', () => {
  const store = makeStore();
  store.append('balance', D1, 1000);
  store.append('balance', D2, 2000);
  assert.strictEqual(store.get('balance').length, 2);
});

test('FieldSeriesStore.append: keeps full history (no ring cap — R10.2)', () => {
  const store = makeStore();
  for (let i = 0; i < 250; i++) {
    store.append('x', new Date(2025, 0, i + 1), i);
  }
  const buf = store.get('x');
  assert.strictEqual(buf.length, 250, 'all points retained — count of active paths is the bound, not series length');
  assert.strictEqual(buf[0].value, 0,   'oldest value retained');
  assert.strictEqual(buf[buf.length - 1].value, 249, 'latest value retained');
});

test('FieldSeriesStore.append: ignores NaN and Infinity', () => {
  const store = makeStore();
  store.append('x', D1, NaN);
  store.append('x', D1, Infinity);
  store.append('x', D1, -Infinity);
  assert.strictEqual(store.get('x'), null, 'no points should be buffered for non-finite values');
});

test('FieldSeriesStore.get: returns null for unknown path', () => {
  const store = makeStore();
  assert.strictEqual(store.get('unknown.path'), null);
});

// ─── backfill ─────────────────────────────────────────────────────────────────

test('FieldSeriesStore.backfill: returns empty array when no history injected', () => {
  const store = makeStore();
  assert.deepStrictEqual(store.backfill('some.path'), []);
});

test('FieldSeriesStore.backfill: reconstructs series from snapshots', () => {
  const store = makeStore();
  store.simulationHistory = makeHistory([
    { date: D1, state: { account: { balance: 10_000 } } },
    { date: D2, state: { account: { balance: 12_000 } } },
    { date: D3, state: { account: { balance: 15_000 } } },
  ]);
  const series = store.backfill('account.balance');
  assert.strictEqual(series.length, 3);
  assert.strictEqual(series[0].value, 10_000);
  assert.strictEqual(series[1].value, 12_000);
  assert.strictEqual(series[2].value, 15_000);
  assert.ok(series.every(p => p.backfilled === true), 'all points should be marked backfilled');
});

test('FieldSeriesStore.backfill: skips snapshots where path is missing or non-numeric', () => {
  const store = makeStore();
  store.simulationHistory = makeHistory([
    { date: D1, state: { account: { balance: 1000 } } },
    { date: D2, state: { account: {} } },            // balance missing
    { date: D3, state: { account: { balance: 2000 } } },
  ]);
  const series = store.backfill('account.balance');
  assert.strictEqual(series.length, 2);
  assert.strictEqual(series[0].value, 1000);
  assert.strictEqual(series[1].value, 2000);
});

test('FieldSeriesStore.backfill: reads nested paths', () => {
  const store = makeStore();
  store.simulationHistory = makeHistory([
    { date: D1, state: { effectiveExchangeRates: { USD_AUD: 0.65 } } },
  ]);
  const series = store.backfill('effectiveExchangeRates.USD_AUD');
  assert.strictEqual(series.length, 1);
  assert.strictEqual(series[0].value, 0.65);
});

// ─── getOrBackfill ────────────────────────────────────────────────────────────

test('FieldSeriesStore.getOrBackfill: returns live buffer when available', () => {
  const store = makeStore();
  store.simulationHistory = makeHistory([
    { date: D1, state: { x: 999 } },
  ]);
  store.append('x', D2, 42);
  const { series, backfilled } = store.getOrBackfill('x');
  assert.strictEqual(series.length, 1);
  assert.strictEqual(series[0].value, 42);
  assert.strictEqual(backfilled, false, 'should prefer live buffer');
});

test('FieldSeriesStore.getOrBackfill: falls back to backfill when no live data', () => {
  const store = makeStore();
  store.simulationHistory = makeHistory([
    { date: D1, state: { x: 100 } },
  ]);
  const { series, backfilled } = store.getOrBackfill('x');
  assert.strictEqual(series.length, 1);
  assert.strictEqual(series[0].value, 100);
  assert.strictEqual(backfilled, true);
});

test('FieldSeriesStore.getOrBackfill: returns empty series for unknown path with no history', () => {
  const store = makeStore();
  const { series, backfilled } = store.getOrBackfill('unknown');
  assert.deepStrictEqual(series, []);
  assert.strictEqual(backfilled, false);
});

// ─── clear ────────────────────────────────────────────────────────────────────

test('FieldSeriesStore.clear: removes all live buffers', () => {
  const store = makeStore();
  store.append('x', D1, 1);
  store.append('y', D1, 2);
  store.clear();
  assert.strictEqual(store.get('x'), null);
  assert.strictEqual(store.get('y'), null);
});

test('FieldSeriesStore.clear: backfill still works after clear', () => {
  const store = makeStore();
  store.simulationHistory = makeHistory([
    { date: D1, state: { z: 77 } },
  ]);
  store.append('z', D1, 99);
  store.clear();
  const { series, backfilled } = store.getOrBackfill('z');
  assert.strictEqual(series[0].value, 77, 'should fall back to snapshot after clearing live buffer');
  assert.strictEqual(backfilled, true);
});
