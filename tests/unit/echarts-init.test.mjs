/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { initEChartWhenReady } from '../../src/visualization/components/echarts-init.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeContainer(width = 0, height = 0) {
  return { clientWidth: width, clientHeight: height };
}

let savedResizeObserver;

before(() => {
  savedResizeObserver = globalThis.ResizeObserver;
});

after(() => {
  globalThis.ResizeObserver = savedResizeObserver;
});

function installMockRO() {
  let instance;
  class MockResizeObserver {
    constructor(cb) {
      this.cb          = cb;
      this.observed    = null;
      this.disconnected = false;
      instance = this;
    }
    observe(el)   { this.observed = el; }
    disconnect()  { this.disconnected = true; }
    fire(w, h)    { this.cb([{ contentRect: { width: w, height: h } }]); }
  }
  globalThis.ResizeObserver = MockResizeObserver;
  return () => instance;
}

// ── Immediate init ─────────────────────────────────────────────────────────────

test('initEChartWhenReady: calls doInit immediately when width > 0', () => {
  let called = false;
  const result = initEChartWhenReady(makeContainer(100, 0), () => { called = true; });
  assert.strictEqual(called, true);
  assert.strictEqual(result, null);
});

test('initEChartWhenReady: calls doInit immediately when height > 0', () => {
  let called = false;
  const result = initEChartWhenReady(makeContainer(0, 50), () => { called = true; });
  assert.strictEqual(called, true);
  assert.strictEqual(result, null);
});

test('initEChartWhenReady: calls doInit immediately when both dimensions > 0', () => {
  let called = false;
  const result = initEChartWhenReady(makeContainer(200, 100), () => { called = true; });
  assert.strictEqual(called, true);
  assert.strictEqual(result, null);
});

// ── Deferred init ─────────────────────────────────────────────────────────────

test('initEChartWhenReady: does not call doInit when container is 0×0', () => {
  const getInstance = installMockRO();
  let called = false;

  initEChartWhenReady(makeContainer(0, 0), () => { called = true; });

  assert.strictEqual(called, false);
  assert.ok(getInstance(), 'ResizeObserver was created');
});

test('initEChartWhenReady: observes the container when deferred', () => {
  const getInstance = installMockRO();
  const container = makeContainer(0, 0);

  initEChartWhenReady(container, () => {});

  assert.strictEqual(getInstance().observed, container);
});

test('initEChartWhenReady: returns the pending ResizeObserver when deferred', () => {
  const getInstance = installMockRO();

  const result = initEChartWhenReady(makeContainer(0, 0), () => {});

  assert.strictEqual(result, getInstance());
});

test('initEChartWhenReady: calls doInit when ResizeObserver fires with non-zero width', () => {
  const getInstance = installMockRO();
  let called = false;

  initEChartWhenReady(makeContainer(0, 0), () => { called = true; });
  getInstance().fire(100, 0);

  assert.strictEqual(called, true);
});

test('initEChartWhenReady: calls doInit when ResizeObserver fires with non-zero height', () => {
  const getInstance = installMockRO();
  let called = false;

  initEChartWhenReady(makeContainer(0, 0), () => { called = true; });
  getInstance().fire(0, 200);

  assert.strictEqual(called, true);
});

test('initEChartWhenReady: disconnects the observer after doInit fires', () => {
  const getInstance = installMockRO();

  initEChartWhenReady(makeContainer(0, 0), () => {});
  getInstance().fire(100, 100);

  assert.strictEqual(getInstance().disconnected, true);
});

test('initEChartWhenReady: does not call doInit when ResizeObserver fires with 0×0', () => {
  const getInstance = installMockRO();
  let callCount = 0;

  initEChartWhenReady(makeContainer(0, 0), () => { callCount++; });
  getInstance().fire(0, 0);

  assert.strictEqual(callCount, 0);
  assert.strictEqual(getInstance().disconnected, false);
});

test('initEChartWhenReady: calls doInit exactly once even if RO fires multiple times', () => {
  const getInstance = installMockRO();
  let callCount = 0;

  initEChartWhenReady(makeContainer(0, 0), () => { callCount++; });

  // First non-zero fire → init + disconnect
  getInstance().fire(100, 100);
  // Second fire would only reach the callback if still connected
  // (after disconnect the browser stops sending entries, but we test the guard anyway)
  getInstance().fire(200, 200);

  assert.strictEqual(callCount, 1);
});

// ── Caller disconnect (cleanup) ────────────────────────────────────────────────

test('initEChartWhenReady: returned RO can be disconnected by caller before firing', () => {
  const getInstance = installMockRO();
  let called = false;

  const ro = initEChartWhenReady(makeContainer(0, 0), () => { called = true; });
  ro.disconnect();

  assert.strictEqual(getInstance().disconnected, true);
  // doInit should never have been called
  assert.strictEqual(called, false);
});
