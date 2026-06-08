/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import { ChartController } from '../../src/visualization/chart/chart-controller.js';

// Design 31 / R2: the chart-filter multi-select was removed; the controller is
// now a lightweight registry of known series (discoverKey + getAllKeys). It no
// longer tracks visibility or serves a QueryApi — selection lives on the
// ChartPresenter active set instead.

function makeCtrl() {
  return new ChartController();
}

const labelOf = (ctrl, key) => ctrl._knownKeys.get(key)?.name;

// ─── Constructor ──────────────────────────────────────────────────────────────

test('ChartController: starts with no known keys', () => {
  assert.strictEqual(makeCtrl().getAllKeys().length, 0);
});

// ─── discoverKey ──────────────────────────────────────────────────────────────

test('ChartController.discoverKey: returns true for a new key', () => {
  assert.strictEqual(makeCtrl().discoverKey('balance'), true);
});

test('ChartController.discoverKey: returns false for an already-known key', () => {
  const ctrl = makeCtrl();
  ctrl.discoverKey('balance');
  assert.strictEqual(ctrl.discoverKey('balance'), false);
});

test('ChartController.discoverKey: adds key to getAllKeys', () => {
  const ctrl = makeCtrl();
  ctrl.discoverKey('balance');
  assert.deepStrictEqual(ctrl.getAllKeys(), ['balance']);
});

test('ChartController.discoverKey: multiple distinct keys accumulate', () => {
  const ctrl = makeCtrl();
  ctrl.discoverKey('a');
  ctrl.discoverKey('b');
  ctrl.discoverKey('c');
  assert.strictEqual(ctrl.getAllKeys().length, 3);
});

test('ChartController.discoverKey: stores the curated group', () => {
  const ctrl = makeCtrl();
  ctrl.discoverKey('metrics.netWorth', 'Metrics');
  assert.strictEqual(ctrl._knownKeys.get('metrics.netWorth').group, 'Metrics');
});

// ─── label generation ──────────────────────────────────────────────────────────

test('ChartController.discoverKey: human label from camelCase', () => {
  const ctrl = makeCtrl();
  ctrl.discoverKey('totalBalance');
  assert.strictEqual(labelOf(ctrl, 'totalBalance'), 'Total Balance');
});

test('ChartController.discoverKey: human label from snake_case', () => {
  const ctrl = makeCtrl();
  ctrl.discoverKey('gross_income');
  assert.strictEqual(labelOf(ctrl, 'gross_income'), 'Gross Income');
});

test('ChartController.discoverKey: single-word key passes through capitalised', () => {
  const ctrl = makeCtrl();
  ctrl.discoverKey('balance');
  assert.strictEqual(labelOf(ctrl, 'balance'), 'Balance');
});

test('ChartController.discoverKey: dotted path label uses › separator', () => {
  const ctrl = makeCtrl();
  ctrl.discoverKey('metrics.netWorth');
  assert.strictEqual(labelOf(ctrl, 'metrics.netWorth'), 'Metrics › Net Worth');
});

// ─── getAllKeys ───────────────────────────────────────────────────────────────

test('ChartController.getAllKeys: returns empty array initially', () => {
  assert.deepStrictEqual(makeCtrl().getAllKeys(), []);
});

test('ChartController.getAllKeys: returns all discovered keys in insertion order', () => {
  const ctrl = makeCtrl();
  ctrl.discoverKey('z');
  ctrl.discoverKey('a');
  ctrl.discoverKey('m');
  assert.deepStrictEqual(ctrl.getAllKeys(), ['z', 'a', 'm']);
});
