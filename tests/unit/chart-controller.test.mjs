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

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeCtrl() {
  return new ChartController();
}

// ─── Constructor ──────────────────────────────────────────────────────────────

test('ChartController: starts with no known keys', () => {
  assert.strictEqual(makeCtrl().getAllKeys().length, 0);
});

test('ChartController: all keys visible by default', () => {
  const ctrl = makeCtrl();
  ctrl.discoverKey('foo');
  assert.strictEqual(ctrl.isVisible('foo'), true);
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

test('ChartController.discoverKey: generates human label from camelCase', async () => {
  const ctrl = makeCtrl();
  ctrl.discoverKey('totalBalance');
  const { items } = await ctrl.getQueryApi().search({ query: '', offset: 0, limit: 50 });
  const item = items.find(i => i.id === 'totalBalance');
  assert.strictEqual(item.name, 'Total Balance');
});

test('ChartController.discoverKey: generates human label from snake_case', async () => {
  const ctrl = makeCtrl();
  ctrl.discoverKey('gross_income');
  const { items } = await ctrl.getQueryApi().search({ query: '', offset: 0, limit: 50 });
  const item = items.find(i => i.id === 'gross_income');
  assert.strictEqual(item.name, 'Gross Income');
});

test('ChartController.discoverKey: single-word key passes through capitalised', async () => {
  const ctrl = makeCtrl();
  ctrl.discoverKey('balance');
  const { items } = await ctrl.getQueryApi().search({ query: '', offset: 0, limit: 50 });
  assert.strictEqual(items[0].name, 'Balance');
});

// ─── isVisible / setVisible ───────────────────────────────────────────────────

test('ChartController.isVisible: undiscovered key is visible', () => {
  assert.strictEqual(makeCtrl().isVisible('unknown'), true);
});

test('ChartController.setVisible(false): marks key as hidden', () => {
  const ctrl = makeCtrl();
  ctrl.discoverKey('balance');
  ctrl.setVisible('balance', false);
  assert.strictEqual(ctrl.isVisible('balance'), false);
});

test('ChartController.setVisible(true): re-shows a hidden key', () => {
  const ctrl = makeCtrl();
  ctrl.discoverKey('balance');
  ctrl.setVisible('balance', false);
  ctrl.setVisible('balance', true);
  assert.strictEqual(ctrl.isVisible('balance'), true);
});

test('ChartController.setVisible: does not affect other keys', () => {
  const ctrl = makeCtrl();
  ctrl.discoverKey('a');
  ctrl.discoverKey('b');
  ctrl.setVisible('a', false);
  assert.strictEqual(ctrl.isVisible('b'), true);
});

// ─── clearHidden ─────────────────────────────────────────────────────────────

test('ChartController.clearHidden: restores all hidden keys to visible', () => {
  const ctrl = makeCtrl();
  ctrl.discoverKey('a');
  ctrl.discoverKey('b');
  ctrl.setVisible('a', false);
  ctrl.setVisible('b', false);
  ctrl.clearHidden();
  assert.strictEqual(ctrl.isVisible('a'), true);
  assert.strictEqual(ctrl.isVisible('b'), true);
});

test('ChartController.clearHidden: no-op when nothing is hidden', () => {
  const ctrl = makeCtrl();
  ctrl.discoverKey('a');
  assert.doesNotThrow(() => ctrl.clearHidden());
  assert.strictEqual(ctrl.isVisible('a'), true);
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

// ─── getQueryApi ─────────────────────────────────────────────────────────────

test('ChartController.getQueryApi: empty search returns all items', async () => {
  const ctrl = makeCtrl();
  ctrl.discoverKey('income');
  ctrl.discoverKey('tax');
  const { items, total } = await ctrl.getQueryApi().search({ query: '', offset: 0, limit: 50 });
  assert.strictEqual(total, 2);
  assert.strictEqual(items.length, 2);
});

test('ChartController.getQueryApi: items have id and name fields', async () => {
  const ctrl = makeCtrl();
  ctrl.discoverKey('netWorth');
  const { items } = await ctrl.getQueryApi().search({ query: '', offset: 0, limit: 50 });
  assert.ok(items[0].id,   'item should have id');
  assert.ok(items[0].name, 'item should have name');
  assert.strictEqual(items[0].id, 'netWorth');
});

test('ChartController.getQueryApi: search filters by name substring', async () => {
  const ctrl = makeCtrl();
  ctrl.discoverKey('taxOwed');
  ctrl.discoverKey('income');
  ctrl.discoverKey('taxPaid');
  const { items, total } = await ctrl.getQueryApi().search({ query: 'contains(name,Tax)', offset: 0, limit: 50 });
  assert.strictEqual(total, 2);
  assert.ok(items.every(i => i.name.toLowerCase().includes('tax')));
});

test('ChartController.getQueryApi: search is case-insensitive', async () => {
  const ctrl = makeCtrl();
  ctrl.discoverKey('totalBalance');
  const { items } = await ctrl.getQueryApi().search({ query: 'contains(name,TOTAL)', offset: 0, limit: 50 });
  assert.strictEqual(items.length, 1);
});

test('ChartController.getQueryApi: pagination — offset and limit are applied', async () => {
  const ctrl = makeCtrl();
  for (let i = 0; i < 10; i++) ctrl.discoverKey(`key${i}`);
  const { items, total } = await ctrl.getQueryApi().search({ query: '', offset: 3, limit: 4 });
  assert.strictEqual(total, 10);
  assert.strictEqual(items.length, 4);
});

test('ChartController.getQueryApi: results are sorted alphabetically by name', async () => {
  const ctrl = makeCtrl();
  ctrl.discoverKey('zzebra');
  ctrl.discoverKey('apple');
  ctrl.discoverKey('mango');
  const { items } = await ctrl.getQueryApi().search({ query: '', sort: [{ field: 'name', dir: 'asc' }], offset: 0, limit: 50 });
  const names = items.map(i => i.name);
  assert.deepStrictEqual(names, [...names].sort((a, b) => a.localeCompare(b)));
});

test('ChartController.getQueryApi: reflects newly discovered keys without re-creating api', async () => {
  const ctrl = makeCtrl();
  const api = ctrl.getQueryApi();
  ctrl.discoverKey('first');
  const { total: t1 } = await api.search({ query: '', offset: 0, limit: 50 });
  ctrl.discoverKey('second');
  const { total: t2 } = await api.search({ query: '', offset: 0, limit: 50 });
  assert.strictEqual(t1, 1);
  assert.strictEqual(t2, 2);
});
