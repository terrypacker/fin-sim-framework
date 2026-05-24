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
 * workbench-app.test.mjs
 * tests for WorkbenchApp constructor state.
 * Run with: npm run test:viz
 */

import assert from 'node:assert/strict';
import { WorkbenchApp } from '../../src/apps/workbench-app.js';

// ─── Helper ───────────────────────────────────────────────────────────────────
function makeApp() {
  return new WorkbenchApp({ chartSeries: null });
}

// ─── Constructor ──────────────────────────────────────────────────────────────

test('WorkbenchApp: scenario initializes to null', () => {
  assert.strictEqual(makeApp().scenario, null);
});

test('WorkbenchApp: lastSliderValue initializes to 0', () => {
  assert.strictEqual(makeApp().lastSliderValue, 0);
});

test('WorkbenchApp: chartSeries stores the provided value', () => {
  const series = [{ key: 'cash', color: '#fff', label: 'Cash' }];
  const app = new WorkbenchApp({ chartSeries: series });
  assert.strictEqual(app.chartSeries, series);
});

test('WorkbenchApp: chartSeries defaults to null when omitted', () => {
  const app = new WorkbenchApp({});
  assert.strictEqual(app.chartSeries, null);
});

test('WorkbenchApp: displayCurrency accessible via timeControls', () => {
  const app = makeApp();
  app.timeControls = { displayCurrency: 'USD' };
  assert.strictEqual(app.timeControls.displayCurrency, 'USD');
});
