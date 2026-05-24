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
 * scenario-service.test.mjs
 *
 * Tests for ScenarioService: getParams, getInitialState, createScenario,
 * newScenario, and helper methods.
 *
 * Run with: npm run test:viz
 */

import assert from 'node:assert/strict';
import { jest }            from '@jest/globals';
import { ScenarioRegistry } from '../../src/scenarios/scenario-registry.js';
import { ScenarioService }  from '../../src/services/scenario-service.js';
import { ScenarioStorage }  from '../../src/scenarios/scenario-storage.js';
import { PrebuiltScenario } from '../../src/scenarios/prebuilt-scenario.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makePrebuilt(id, order = 1) {
  const factory = jest.fn((_p, _i) => ({ id, buildSim: jest.fn(), loadDefaults: jest.fn() }));
  return new PrebuiltScenario({
    id, label: `Label ${id}`, order, simStart: '2026-01-01', simEnd: '2041-01-01', factory,
  });
}

function setStorageData(data) {
  localStorage.setItem(ScenarioStorage.STORAGE_KEY, JSON.stringify(data));
}

function makeStack({ prebuiltScenarios = [] } = {}) {
  const registry = new ScenarioRegistry(new ScenarioStorage());
  registry.loadPrebuilt(prebuiltScenarios);
  return { registry, service: new ScenarioService({}, registry) };
}

beforeEach(() => { localStorage.clear(); });

// ═════════════════════════════════════════════════════════════════════════════
// getParams()
// ═════════════════════════════════════════════════════════════════════════════

test('getParams: returns {} when prebuilt is active', () => {
  const { service } = makeStack({ prebuiltScenarios: [makePrebuilt('alpha')] });
  const active = service.getActive();
  assert.deepStrictEqual(active.params, {});
});

test('getParams: returns mapped params for user scenario', () => {
  setStorageData({
    lastUsed: 'u:0',
    scenarios: [{ name: 'S', params: [{ name: 'drift', type: 'Number', value: 0.05 }] }],
  });
  const { service } = makeStack({ prebuiltScenarios: [makePrebuilt('alpha')] });
  const active = service.getActive();
  assert.deepStrictEqual(active.params, [{ name: 'drift', type: 'Number', value: 0.05 }]);
});

test('getParams: returns [] for user scenario with no params', () => {
  setStorageData({ lastUsed: 'u:0', scenarios: [{ name: 'S', params: [] }] });
  const { service } = makeStack({ prebuiltScenarios: [makePrebuilt('alpha')] });
  const active = service.getActive();
  assert.deepStrictEqual(active.params, []);
});

// ═════════════════════════════════════════════════════════════════════════════
// getInitialState()
// ═════════════════════════════════════════════════════════════════════════════

test('getInitialState: returns {} when prebuilt is active', () => {
  const { service } = makeStack({ prebuiltScenarios: [makePrebuilt('alpha')] });
  const active = service.getActive();
  assert.deepStrictEqual(active.initialState, {});
});

test('getInitialState: returns initialState for user scenario', () => {
  const state = { metrics: { amount: 99 } };
  setStorageData({ lastUsed: 'u:0', scenarios: [{ name: 'S', initialState: state }] });
  const { service } = makeStack({ prebuiltScenarios: [makePrebuilt('alpha')] });
  const active = service.getActive();
  assert.deepStrictEqual(active.initialState, state);
});

// ═════════════════════════════════════════════════════════════════════════════
// createActiveScenario()
// ═════════════════════════════════════════════════════════════════════════════

test('createActiveScenario: calls prebuilt factory when prebuilt is active', () => {
  const pb = makePrebuilt('alpha');
  const { service } = makeStack({ prebuiltScenarios: [pb] });
  service.createActiveScenario();
  expect(pb.factory).toHaveBeenCalledWith({}, {}, new Date(pb.simStart), new Date(pb.simEnd));
});

test('createActiveScenario: uses scenarioId to find matching prebuilt factory', () => {
  const pbA = makePrebuilt('alpha', 1);
  const pbB = makePrebuilt('beta',  2);
  const expectedStart = '2025-01-01';
  const expectedEnd   = '2026-01-01';
  setStorageData({
    lastUsed: 'u:0',
    scenarios: [{
      name: 'S', scenarioId: 'p:beta', params: [], initialState: {},
      simStart: expectedStart, simEnd: expectedEnd,
    }],
  });
  const { service } = makeStack({ prebuiltScenarios: [pbA, pbB] });
  service.createActiveScenario();
  expect(pbA.factory).not.toHaveBeenCalled();
  expect(pbB.factory).toHaveBeenCalledWith({}, {}, new Date(expectedStart), new Date(expectedEnd));
});

test('createActiveScenario: falls back to first prebuilt for user scenario without scenarioId match', () => {
  const pbA = makePrebuilt('alpha', 1);
  const pbB = makePrebuilt('beta',  2);
  const expectedStart = '2025-01-01';
  const expectedEnd   = '2026-01-01';
  setStorageData({
    lastUsed: 'u:0',
    scenarios: [{ name: 'S', params: [], initialState: {}, simStart: expectedStart, simEnd: expectedEnd }],
  });
  const { service } = makeStack({ prebuiltScenarios: [pbA, pbB] });
  service.createActiveScenario();
  expect(pbA.factory).toHaveBeenCalledWith({}, {});
});

test('createActiveScenario: throws when no factory available', () => {
  const registry = new ScenarioRegistry(new ScenarioStorage());
  registry.loadPrebuilt([]);
  const service = new ScenarioService({}, registry);
  assert.throws(() => service.createActiveScenario(), /no scenario factory/i);
});

// ═════════════════════════════════════════════════════════════════════════════
// newScenario()
// ═════════════════════════════════════════════════════════════════════════════

test('newScenario: returns new scenario with u:0 id and scenarioId from fromScenario', () => {
  const pb = makePrebuilt('alpha');
  const { registry, service } = makeStack({ prebuiltScenarios: [pb] });
  const fromScenario = registry.getActive();
  const created = service.newScenario(fromScenario);
  assert.strictEqual(created.id, 'u:0');
  assert.strictEqual(created.scenarioId, 'p:alpha');
  assert.strictEqual(registry.getActive().id, 'u:0');
});

test('newScenario: copies simStart and simEnd from fromScenario', () => {
  const pb = makePrebuilt('alpha');
  const { registry, service } = makeStack({ prebuiltScenarios: [pb] });
  const fromScenario = registry.getActive();
  const created = service.newScenario(fromScenario);
  assert.strictEqual(created.simStart, fromScenario.simStart);
  assert.strictEqual(created.simEnd,   fromScenario.simEnd);
});
