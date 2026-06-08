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
import { Graph } from '../../src/graph/graph.js';
import { ScenarioStorage }  from '../../src/scenarios/scenario-storage.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makePrebuilt(id, order = 1, active = false) {
  return {
    cls: {
      scenarioId:         () => id,
      scenarioName:       () => `Label ${id}`,
      getParamSchema:     () => [],
      buildDefaultConfig: () => null,
      instantiate:        jest.fn(),
    },
    order,
    active,
    simStart: new Date(Date.UTC(2026, 0, 1)),
    simEnd:   new Date(Date.UTC(2041, 0, 1)),
  };
}

function makePrebuiltWithSchema(id, schema, order = 1) {
  return {
    cls: {
      scenarioId:         () => id,
      scenarioName:       () => `Label ${id}`,
      getParamSchema:     () => schema,
      buildDefaultConfig: () => null,
      instantiate:        jest.fn(),
    },
    order,
    active: false,
    simStart: new Date(Date.UTC(2026, 0, 1)),
    simEnd:   new Date(Date.UTC(2041, 0, 1)),
  };
}

function setStorageData(data) {
  localStorage.setItem(ScenarioStorage.STORAGE_KEY, JSON.stringify(data));
}

function makeRegistry(prebuiltScenarios = []) {
  const registry = new ScenarioRegistry(new ScenarioStorage(), new Graph());
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

test('lastUsed: u:0 with prebuilt active:true → user scenario wins on page load', () => {
  // Regression: prebuilt definitions ship with active:true. When a user scenario is
  // lastUsed, loadPrebuilt must not let the prebuilt's active:true flag override it.
  setStorageData({
    lastUsed: 'u:0',
    scenarios: [{ name: 'MySaved', simStart: '2026-01-01', simEnd: '2041-01-01' }],
  });
  const r = makeRegistry([makePrebuilt('alpha', 1, true)]);
  assert.strictEqual(r.getActive().id, 'u:0');
  // Only one active scenario
  assert.strictEqual(r.getAll().filter(s => s.active).length, 1);
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

// ═════════════════════════════════════════════════════════════════════════════
// loadPrebuilt — typed params initialization and Rebuild preservation
// ═════════════════════════════════════════════════════════════════════════════

const SAMPLE_SCHEMA = [
  { key: 'drift',    label: 'Drift',    type: 'Number',  group: 'Rates',   defaultValue: 0.05 },
  { key: 'retDate',  label: 'Ret Date', type: 'Date',    group: 'Dates',   defaultValue: '2035-01-01' },
  { key: 'enabled',  label: 'Enabled',  type: 'Boolean', group: 'Options', defaultValue: true },
];

test('loadPrebuilt: schema-less prebuilt gets empty params array', () => {
  const r = makeRegistry([makePrebuilt('alpha')]);
  assert.deepStrictEqual(r.getActive().params, []);
});

test('loadPrebuilt: prebuilt with schema gets typed-array params from schema defaults', () => {
  const r = makeRegistry([makePrebuiltWithSchema('alpha', SAMPLE_SCHEMA)]);
  const params = r.getActive().params;
  assert.strictEqual(params.length, 3);
  assert.strictEqual(params[0].name,  'drift');
  assert.strictEqual(params[0].value, 0.05);
  assert.strictEqual(params[0].type,  'Number');
  assert.strictEqual(params[1].name,  'retDate');
  assert.strictEqual(params[1].value, '2035-01-01');
  assert.strictEqual(params[2].name,  'enabled');
  assert.strictEqual(params[2].value, true);
});

test('loadPrebuilt: calling loadPrebuilt a second time preserves edited param values', () => {
  const pb = makePrebuiltWithSchema('alpha', SAMPLE_SCHEMA);
  const r  = makeRegistry([pb]);
  const entry = r.getActive();

  // Simulate user editing a param value
  entry.params[0].value = 0.99;

  // Rebuild path: loadPrebuilt is called again with the same prebuilt definitions
  r.loadPrebuilt([pb]);

  // Entry preserved — edited value survives
  assert.strictEqual(r.getActive().params[0].value, 0.99);
});

test('loadPrebuilt: second call does not add duplicate entries', () => {
  const pb = makePrebuiltWithSchema('alpha', SAMPLE_SCHEMA);
  const r  = makeRegistry([pb]);
  r.loadPrebuilt([pb]);
  assert.strictEqual(r.getPrebuiltScenarios().length, 1);
});

test('loadPrebuilt: schema node field is copied to param entry', () => {
  const schema = [
    { key: 'initialSavings', label: 'Initial Savings', type: 'Number', group: 'Accounts',
      defaultValue: 50000, node: { type: 'account', stateKey: 'savings', field: 'initialValue' } },
  ];
  const r = makeRegistry([makePrebuiltWithSchema('alpha', schema)]);
  const param = r.getActive().params[0];
  assert.deepStrictEqual(param.node, { type: 'account', stateKey: 'savings', field: 'initialValue' });
});

// ═════════════════════════════════════════════════════════════════════════════
// _init — id preservation
// ═════════════════════════════════════════════════════════════════════════════

test('_init: preserves u: ids already stored in storage', () => {
  setStorageData({
    lastUsed: 'u:5',
    scenarios: [
      { id: 'u:5', name: 'Mine', simStart: '2026-01-01', simEnd: '2041-01-01' },
    ],
  });
  const r = makeRegistry([makePrebuilt('alpha')]);
  assert.ok(r.get('u:5'), 'u:5 should exist');
  assert.strictEqual(r.getActive().id, 'u:5');
});

test('_init: assigns u:<i> id when storage record has no id (legacy)', () => {
  setStorageData({ scenarios: [{ name: 'Legacy', simStart: '2026-01-01', simEnd: '2041-01-01' }] });
  const r = makeRegistry([makePrebuilt('alpha')]);
  assert.ok(r.get('u:0'), 'u:0 should be assigned for legacy record');
});

// ═════════════════════════════════════════════════════════════════════════════
// upsertUserScenarios
// ═════════════════════════════════════════════════════════════════════════════

test('upsertUserScenarios: adds new scenario without removing existing ones', () => {
  setStorageData({ lastUsed: 'u:0', scenarios: [{ id: 'u:0', name: 'Existing', simStart: '2026-01-01', simEnd: '2041-01-01' }] });
  const r = makeRegistry([makePrebuilt('alpha')]);
  r.upsertUserScenarios({ scenarios: [{ id: 'u:1', name: 'Uploaded', simStart: '2026-01-01', simEnd: '2041-01-01' }] });
  const user = r.getUserScenarios();
  assert.strictEqual(user.length, 2);
  assert.ok(user.find(s => s.id === 'u:0'), 'existing u:0 preserved');
  assert.ok(user.find(s => s.id === 'u:1'), 'uploaded u:1 added');
});

test('upsertUserScenarios: updates existing scenario with matching id', () => {
  setStorageData({ lastUsed: 'u:0', scenarios: [{ id: 'u:0', name: 'Old Name', simStart: '2026-01-01', simEnd: '2041-01-01' }] });
  const r = makeRegistry([makePrebuilt('alpha')]);
  r.upsertUserScenarios({ scenarios: [{ id: 'u:0', name: 'New Name', simStart: '2026-01-01', simEnd: '2041-01-01' }] });
  const user = r.getUserScenarios();
  assert.strictEqual(user.length, 1);
  assert.strictEqual(user[0].name, 'New Name');
});

test('upsertUserScenarios: assigns fresh id to scenario without a u: id', () => {
  setStorageData({ lastUsed: 'u:0', scenarios: [{ id: 'u:0', name: 'Existing', simStart: '2026-01-01', simEnd: '2041-01-01' }] });
  const r = makeRegistry([makePrebuilt('alpha')]);
  r.upsertUserScenarios({ scenarios: [{ name: 'No Id', simStart: '2026-01-01', simEnd: '2041-01-01' }] });
  const user = r.getUserScenarios();
  assert.strictEqual(user.length, 2);
  const newOne = user.find(s => s.name === 'No Id');
  assert.ok(newOne, 'scenario without id was added');
  assert.ok(newOne.id.startsWith('u:'), 'new id has u: prefix');
  assert.notStrictEqual(newOne.id, 'u:0', 'new id does not collide with existing');
});

test('upsertUserScenarios: active:true in upload changes active scenario', () => {
  setStorageData({ lastUsed: 'u:0', scenarios: [{ id: 'u:0', name: 'A', simStart: '2026-01-01', simEnd: '2041-01-01' }] });
  const r = makeRegistry([makePrebuilt('alpha')]);
  r.upsertUserScenarios({ scenarios: [{ id: 'u:1', name: 'B', active: true, simStart: '2026-01-01', simEnd: '2041-01-01' }] });
  assert.strictEqual(r.getActive().id, 'u:1');
  assert.strictEqual(r.getAll().filter(s => s.active).length, 1);
});

test('upsertUserScenarios: no active flag in upload leaves current active unchanged', () => {
  setStorageData({ lastUsed: 'u:0', scenarios: [{ id: 'u:0', name: 'A', simStart: '2026-01-01', simEnd: '2041-01-01' }] });
  const r = makeRegistry([makePrebuilt('alpha')]);
  r.setActiveById('u:0');
  r.upsertUserScenarios({ scenarios: [{ id: 'u:1', name: 'B', simStart: '2026-01-01', simEnd: '2041-01-01' }] });
  assert.strictEqual(r.getActive().id, 'u:0');
});
