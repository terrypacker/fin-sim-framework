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
 * scenario-registry.test.mjs
 *
 * Tests for ScenarioRegistry: ID scheme, active scenario selection,
 * last-used persistence, save/delete/filter operations.
 *
 * Run with: npm run test:viz
 */

import assert from 'node:assert/strict';
import { jest }             from '@jest/globals';
import { ScenarioRegistry } from '../../src/scenarios/scenario-registry.js';
import { ScenarioStorage }  from '../../src/scenarios/scenario-storage.js';
import { PrebuiltScenario } from '../../src/scenarios/prebuilt-scenario.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makePrebuilt(id, order = 1, active = false) {
  return new PrebuiltScenario({
    id, label: `Label ${id}`, order, simStart: '2026-01-01', simEnd: '2041-01-01',
    factory: jest.fn(),
    active,
  });
}

function setStorageData(data) {
  localStorage.setItem(ScenarioStorage.STORAGE_KEY, JSON.stringify(data));
}

function makeRegistry(prebuiltScenarios = []) {
  const registry = new ScenarioRegistry(new ScenarioStorage());
  registry.loadPrebuilt(prebuiltScenarios);
  return registry;
}

// ─── Setup / teardown ─────────────────────────────────────────────────────────

beforeEach(() => { localStorage.clear(); });

// ═════════════════════════════════════════════════════════════════════════════
// Initial active selection
// ═════════════════════════════════════════════════════════════════════════════

test('no storage, no prebuilts → getActive() is undefined', () => {
  assert.strictEqual(makeRegistry().getActive(), undefined);
});

test('one prebuilt → getActive() is that prebuilt with p: prefix', () => {
  const r = makeRegistry([makePrebuilt('alpha')]);
  assert.strictEqual(r.getActive().id, 'p:alpha');
});

test('two prebuilts, lowest order is selected', () => {
  const r = makeRegistry([makePrebuilt('second', 2), makePrebuilt('first', 1)]);
  assert.strictEqual(r.getActive().id, 'p:first');
});

test('prebuilt marked active:true is selected over first-by-order', () => {
  const r = makeRegistry([makePrebuilt('alpha', 1, false), makePrebuilt('beta', 2, true)]);
  assert.strictEqual(r.getActive().id, 'p:beta');
});

test('user scenarios in storage but no lastUsed → default prebuilt is selected', () => {
  setStorageData({ scenarios: [{ name: 'MySaved', simStart: '2026-01-01', simEnd: '2041-01-01' }] });
  const r = makeRegistry([makePrebuilt('alpha')]);
  assert.strictEqual(r.getActive().id, 'p:alpha');
});

test('lastUsed: u:1 in storage → u:1 is active', () => {
  setStorageData({
    lastUsed: 'u:1',
    scenarios: [
      { name: 'First',  simStart: '2026-01-01', simEnd: '2041-01-01' },
      { name: 'Second', simStart: '2026-01-01', simEnd: '2041-01-01' },
    ],
  });
  const r = makeRegistry([makePrebuilt('alpha')]);
  assert.strictEqual(r.getActive().id, 'u:1');
});

test('lastUsed: p:alpha in storage → p:alpha is active', () => {
  setStorageData({ lastUsed: 'p:alpha', scenarios: [] });
  const r = makeRegistry([makePrebuilt('alpha')]);
  assert.strictEqual(r.getActive().id, 'p:alpha');
});

// ═════════════════════════════════════════════════════════════════════════════
// save()
// ═════════════════════════════════════════════════════════════════════════════

test('save(s, true) makes scenario active and persists lastUsed', () => {
  const r = makeRegistry([makePrebuilt('alpha', 1), makePrebuilt('beta', 2)]);
  r.save(r.get('p:beta'), true);
  assert.strictEqual(r.getActive().id, 'p:beta');
  const stored = JSON.parse(localStorage.getItem(ScenarioStorage.STORAGE_KEY));
  assert.strictEqual(stored.lastUsed, 'p:beta');
});

test('save(s, false) does not change the active scenario', () => {
  const r = makeRegistry([makePrebuilt('alpha', 1), makePrebuilt('beta', 2)]);
  r.save(r.get('p:beta'), false);
  assert.strictEqual(r.getActive().id, 'p:alpha');
});

test('save(s, true) ensures only one scenario is active', () => {
  const r = makeRegistry([makePrebuilt('alpha', 1), makePrebuilt('beta', 2)]);
  r.save(r.get('p:beta'), true);
  const active = r.getAll().filter(s => s.active);
  assert.strictEqual(active.length, 1);
});

// ═════════════════════════════════════════════════════════════════════════════
// delete()
// ═════════════════════════════════════════════════════════════════════════════

test('delete removes scenario and falls back to getAll()[0]', () => {
  setStorageData({ lastUsed: 'u:0', scenarios: [{ name: 'ToDelete', simStart: '2026-01-01', simEnd: '2041-01-01' }] });
  const r = makeRegistry([makePrebuilt('alpha')]);
  r.delete('u:0');
  assert.strictEqual(r.getUserScenarios().length, 0);
  assert.strictEqual(r.getActive().id, 'p:alpha');
});

// ═════════════════════════════════════════════════════════════════════════════
// setActiveById()
// ═════════════════════════════════════════════════════════════════════════════

test('setActiveById changes the active scenario', () => {
  const r = makeRegistry([makePrebuilt('alpha', 1), makePrebuilt('beta', 2)]);
  r.setActiveById('p:beta');
  assert.strictEqual(r.getActive().id, 'p:beta');
});

test('setActiveById with unknown id does nothing', () => {
  const r = makeRegistry([makePrebuilt('alpha')]);
  r.setActiveById('p:nonexistent');
  assert.strictEqual(r.getActive().id, 'p:alpha');
});

// ═════════════════════════════════════════════════════════════════════════════
// getAll / filters
// ═════════════════════════════════════════════════════════════════════════════

test('getAll returns scenarios sorted by order ascending', () => {
  const r = makeRegistry([makePrebuilt('beta', 2), makePrebuilt('alpha', 1)]);
  assert.deepStrictEqual(r.getAll().map(s => s.id), ['p:alpha', 'p:beta']);
});

test('getUserScenarios returns only user scenarios with u: ids', () => {
  setStorageData({ scenarios: [{ name: 'Mine', simStart: '2026-01-01', simEnd: '2041-01-01' }] });
  const r = makeRegistry([makePrebuilt('alpha')]);
  const userScenarios = r.getUserScenarios();
  assert.strictEqual(userScenarios.length, 1);
  assert.strictEqual(userScenarios[0].id, 'u:0');
});

test('getPrebuiltScenarios returns only prebuilts', () => {
  setStorageData({ scenarios: [{ name: 'Mine', simStart: '2026-01-01', simEnd: '2041-01-01' }] });
  const r = makeRegistry([makePrebuilt('alpha'), makePrebuilt('beta', 2)]);
  const prebuilts = r.getPrebuiltScenarios();
  assert.strictEqual(prebuilts.length, 2);
  assert.ok(prebuilts.every(s => s.prebuilt === true));
});
