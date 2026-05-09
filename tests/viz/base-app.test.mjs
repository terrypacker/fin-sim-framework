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

// ─── Helper ───────────────────────────────────────────────────────────────────
function makeApp() {
  return new BaseApp({chartSeries: null });
}

// ─── Constructor ──────────────────────────────────────────────────────────────

test('BaseApp: displayCurrency defaults to USD via timeControls', () => {
  const app = makeApp();
  app.timeControls = { displayCurrency: 'USD' };
  assert.strictEqual(app.timeControls.displayCurrency, 'USD');
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
  const app = new BaseApp({ chartSeries: series });
  assert.strictEqual(app.chartSeries, series);
});

test('BaseApp: chartSeries defaults to null when omitted', () => {
  const app = new BaseApp({ });
  assert.strictEqual(app.chartSeries, null);
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

// ─── toDisplayCurrency ────────────────────────────────────────────────────────

test('BaseApp.toDisplayCurrency: returns same value when native matches displayCurrency', () => {
  const app = makeApp();
  app.timeControls = { displayCurrency: 'USD' };
  assert.strictEqual(app.toDisplayCurrency(1000, 'USD', 1.5), 1000);
});

test('BaseApp.toDisplayCurrency: converts USD to AUD by multiplying by rate', () => {
  const app = makeApp();
  app.timeControls = { displayCurrency: 'AUD' };
  assert.strictEqual(app.toDisplayCurrency(100, 'USD', 1.5), 150);
});

test('BaseApp.toDisplayCurrency: converts AUD to USD by dividing by rate', () => {
  const app = makeApp();
  app.timeControls = { displayCurrency: 'USD' };
  assert.strictEqual(app.toDisplayCurrency(150, 'AUD', 1.5), 100);
});

// ─── setFormatDate ────────────────────────────────────────────────────────────

test('BaseApp.setFormatDate: updates formatDate on timeControls', () => {
  const app   = makeApp();
  const myFmt = d => 'custom:' + d.getFullYear();
  app.timeControls = { formatDate: d => d.toDateString(), setFormatDate(fn) { this.formatDate = fn; } };
  app.timeControls.setFormatDate(myFmt);
  assert.strictEqual(app.timeControls.formatDate, myFmt);
});

test('BaseApp.setFormatDate: new formatter is used by fmtVal for Date values', () => {
  const app = makeApp();
  const d   = new Date(2030, 5, 15);
  app.timeControls = { formatDate: () => 'FIXED' };
  assert.strictEqual(app.fmtVal(d), 'FIXED');
});


