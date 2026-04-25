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
 * balance-chart-view.test.mjs
 * Tests for BalanceChartView
 * Run with: node --test tests/balance-chart-view.test.mjs
 */

import assert from 'node:assert/strict';

import { BalanceChartView } from '../src/visualization/balance-chart-view.js';

// ─── Stub requestAnimationFrame (not available in Node.js) ───────────────────
global.requestAnimationFrame = () => {};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeCtx() {
  const counts = {};
  const track  = name => () => { counts[name] = (counts[name] || 0) + 1; };
  return {
    counts,
    clearRect:  track('clearRect'),
    fillRect:   track('fillRect'),
    fillText:   track('fillText'),
    beginPath:  track('beginPath'),
    moveTo:     track('moveTo'),
    lineTo:     track('lineTo'),
    stroke:     track('stroke'),
    fillStyle:  '',
    strokeStyle: '',
    lineWidth:  1,
    font:       '',
    textAlign:  ''
  };
}

function makeCanvas(w = 400, h = 300) {
  const ctx = makeCtx();
  return {
    width:      w,
    height:     h,
    getContext: () => ctx,
    _ctx:       ctx
  };
}

function makeView({ w = 400, h = 300 } = {}) {
  const canvas   = makeCanvas(w, h);
  const simStart = new Date(2025, 0, 1);
  const simEnd   = new Date(2030, 0, 1);
  return new BalanceChartView({ canvas, simStart, simEnd });
}

// ─── Constructor ──────────────────────────────────────────────────────────────

test('BalanceChartView: constructor stores canvas, simStart, simEnd', () => {
  const canvas = makeCanvas();
  const start  = new Date(2025, 0, 1);
  const end    = new Date(2030, 0, 1);
  const view   = new BalanceChartView({ canvas, simStart: start, simEnd: end });

  assert.strictEqual(view.canvas,   canvas);
  assert.strictEqual(view.simStart, start);
  assert.strictEqual(view.simEnd,   end);
});

test('BalanceChartView: constructor initialises history to empty array', () => {
  assert.deepStrictEqual(makeView().history, []);
});

test('BalanceChartView: constructor sets running to false', () => {
  assert.strictEqual(makeView().running, false);
});

test('BalanceChartView: constructor acquires 2d context from canvas', () => {
  const view = makeView();
  assert.ok(view.ctx, 'ctx should be set by constructor via getContext');
});

// ─── addSnapshot ─────────────────────────────────────────────────────────────

test('BalanceChartView.addSnapshot: appends entry to history', () => {
  const view = makeView();
  view.addSnapshot(new Date(2025, 0, 1), 1000, 2000);
  assert.strictEqual(view.history.length, 1);
});

test('BalanceChartView.addSnapshot: stores correct checking and savings values', () => {
  const view = makeView();
  view.addSnapshot(new Date(2025, 0, 1), 1000, 2500);

  assert.strictEqual(view.history[0].checking, 1000);
  assert.strictEqual(view.history[0].savings,  2500);
});

test('BalanceChartView.addSnapshot: stores a copy of the date (mutation-safe)', () => {
  const view = makeView();
  const d    = new Date(2025, 0, 1);
  view.addSnapshot(d, 0, 0);

  d.setFullYear(2099);
  assert.strictEqual(view.history[0].date.getFullYear(), 2025,
    'stored date should not be affected by mutations to the original');
});

test('BalanceChartView.addSnapshot: multiple calls accumulate in order', () => {
  const view = makeView();
  view.addSnapshot(new Date(2025, 0, 1), 1000, 2000);
  view.addSnapshot(new Date(2025, 3, 1), 1100, 2100);
  view.addSnapshot(new Date(2025, 6, 1), 1200, 2200);

  assert.strictEqual(view.history.length, 3);
  assert.strictEqual(view.history[2].checking, 1200);
});

// ─── resetHistory ─────────────────────────────────────────────────────────────

test('BalanceChartView.resetHistory: clears all snapshots', () => {
  const view = makeView();
  view.addSnapshot(new Date(2025, 0, 1), 1000, 2000);
  view.addSnapshot(new Date(2025, 3, 1), 1100, 2100);
  view.resetHistory();
  assert.deepStrictEqual(view.history, []);
});

test('BalanceChartView.resetHistory: on already-empty history is a no-op', () => {
  const view = makeView();
  assert.doesNotThrow(() => view.resetHistory());
  assert.deepStrictEqual(view.history, []);
});

test('BalanceChartView.resetHistory: new snapshots can be added after reset', () => {
  const view = makeView();
  view.addSnapshot(new Date(2025, 0, 1), 5000, 10000);
  view.resetHistory();
  view.addSnapshot(new Date(2026, 0, 1), 6000, 11000);

  assert.strictEqual(view.history.length, 1);
  assert.strictEqual(view.history[0].checking, 6000);
});

// ─── startViz / stopViz ───────────────────────────────────────────────────────

test('BalanceChartView.startViz: sets running to true', () => {
  const view = makeView();
  view.startViz();
  assert.strictEqual(view.running, true);
});

test('BalanceChartView.stopViz: sets running to false', () => {
  const view = makeView();
  view.startViz();
  view.stopViz();
  assert.strictEqual(view.running, false);
});

test('BalanceChartView.stopViz: can be called without startViz (no-op)', () => {
  const view = makeView();
  assert.doesNotThrow(() => view.stopViz());
  assert.strictEqual(view.running, false);
});

// ─── _loop ────────────────────────────────────────────────────────────────────

test('BalanceChartView._loop: does not call draw when running is false', () => {
  const view = makeView();
  view.running = false;
  view._loop();
  assert.strictEqual(view.ctx.counts.clearRect || 0, 0,
    'draw should not execute when running is false');
});

test('BalanceChartView._loop: calls draw when running is true', () => {
  const view = makeView();
  view.running = true;
  view._loop();
  assert.ok((view.ctx.counts.clearRect || 0) >= 1,
    'draw should execute when running is true');
});

// ─── draw — empty history ─────────────────────────────────────────────────────

test('BalanceChartView.draw: does not throw with empty history', () => {
  assert.doesNotThrow(() => makeView().draw());
});

test('BalanceChartView.draw: calls clearRect on every draw', () => {
  const view = makeView();
  view.draw();
  assert.ok((view.ctx.counts.clearRect || 0) >= 1);
});

test('BalanceChartView.draw: calls fillRect for background on every draw', () => {
  const view = makeView();
  view.draw();
  assert.ok((view.ctx.counts.fillRect || 0) >= 1);
});

test('BalanceChartView.draw: with empty history shows a fallback text message', () => {
  const view = makeView();
  view.draw();
  assert.ok((view.ctx.counts.fillText || 0) >= 1,
    'fillText should be called for the empty-state message');
});

test('BalanceChartView.draw: with empty history does not call stroke', () => {
  const view = makeView();
  view.draw();
  assert.strictEqual(view.ctx.counts.stroke || 0, 0,
    'stroke should not be called when no history exists');
});

// ─── draw — with data ─────────────────────────────────────────────────────────

test('BalanceChartView.draw: does not throw with a single snapshot', () => {
  const view = makeView();
  view.addSnapshot(new Date(2025, 0, 1), 5000, 10000);
  assert.doesNotThrow(() => view.draw());
});

test('BalanceChartView.draw: does not throw with multiple snapshots', () => {
  const view = makeView();
  view.addSnapshot(new Date(2025, 0, 1), 5000, 10000);
  view.addSnapshot(new Date(2025, 3, 1), 5500, 10500);
  view.addSnapshot(new Date(2025, 6, 1), 6000, 11000);
  assert.doesNotThrow(() => view.draw());
});

test('BalanceChartView.draw: calls beginPath and stroke at least twice (one per series)', () => {
  const view = makeView();
  view.addSnapshot(new Date(2025, 0, 1), 5000, 10000);
  view.addSnapshot(new Date(2025, 6, 1), 6000, 11000);
  view.draw();

  assert.ok((view.ctx.counts.beginPath || 0) >= 2, 'at least 2 beginPath calls (one per series)');
  assert.ok((view.ctx.counts.stroke    || 0) >= 2, 'at least 2 stroke calls (one per series)');
});

test('BalanceChartView.draw: calls lineTo for points beyond the first in each series', () => {
  const view = makeView();
  view.addSnapshot(new Date(2025, 0, 1), 5000, 10000);
  view.addSnapshot(new Date(2025, 3, 1), 5500, 10500);
  view.addSnapshot(new Date(2025, 6, 1), 6000, 11000);
  view.draw();

  // 3 points per series → 2 lineTo per series → ≥ 4 total lineTo (plus grid lines)
  assert.ok((view.ctx.counts.lineTo || 0) >= 4, 'lineTo should be called for non-first points');
});

test('BalanceChartView.draw: draws correctly after resetHistory + new snapshots', () => {
  const view = makeView();
  view.addSnapshot(new Date(2025, 0, 1), 5000, 10000);
  view.resetHistory();
  view.addSnapshot(new Date(2026, 0, 1), 7000, 12000);
  view.addSnapshot(new Date(2026, 6, 1), 8000, 13000);
  assert.doesNotThrow(() => view.draw());
});

test('BalanceChartView.draw: handles zero-value balances without throwing', () => {
  const view = makeView();
  view.addSnapshot(new Date(2025, 0, 1), 0, 0);
  view.addSnapshot(new Date(2025, 6, 1), 0, 0);
  assert.doesNotThrow(() => view.draw());
});

test('BalanceChartView.draw: handles negative checking balance without throwing', () => {
  const view = makeView();
  view.addSnapshot(new Date(2025, 0, 1),  5000, 10000);
  view.addSnapshot(new Date(2025, 6, 1), -1000, 10000);
  assert.doesNotThrow(() => view.draw());
});
