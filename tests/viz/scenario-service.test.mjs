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

test('newScenario: params is empty array when fromScenario has no getParamSchema', () => {
  const pb = makePrebuilt('alpha');  // no scenarioClass → getParamSchema() returns []
  const { registry, service } = makeStack({ prebuiltScenarios: [pb] });
  const created = service.newScenario(registry.getActive());
  assert.ok(Array.isArray(created.params));
  assert.strictEqual(created.params.length, 0);
});

test('newScenario: pre-populates params from scenarioClass.getParamSchema()', () => {
  const fakeSchema = [
    { key: 'monthlyExpenses', label: 'Monthly Expenses', type: 'Number', group: 'Expenses', defaultValue: 6000 },
    { key: 'retirementDate',  label: 'Retirement Date',  type: 'Date',   group: 'People',   defaultValue: '2040-01-01' },
    { key: 'reinvest',        label: 'Reinvest',         type: 'Boolean', group: 'People',  defaultValue: false },
  ];
  const scenarioClass = { getParamSchema: () => fakeSchema };
  const pb = new PrebuiltScenario({
    id: 'test', label: 'Test', order: 1, factory: jest.fn(), scenarioClass,
  });
  const { registry, service } = makeStack({ prebuiltScenarios: [pb] });
  const created = service.newScenario(registry.getActive());
  assert.strictEqual(created.params.length, 3);
  assert.deepStrictEqual(created.params[0], { name: 'monthlyExpenses', label: 'Monthly Expenses', type: 'Number', group: 'Expenses', value: 6000 });
  assert.deepStrictEqual(created.params[1], { name: 'retirementDate',  label: 'Retirement Date',  type: 'Date',   group: 'People',  value: '2040-01-01' });
  assert.deepStrictEqual(created.params[2], { name: 'reinvest',        label: 'Reinvest',         type: 'Boolean', group: 'People', value: false });
});

// ═════════════════════════════════════════════════════════════════════════════
// _getParams() — typed param conversion
// ═════════════════════════════════════════════════════════════════════════════

test('_getParams: converts Number params to flat object', () => {
  setStorageData({
    lastUsed: 'u:0',
    scenarios: [{ name: 'S', params: [{ name: 'drift', type: 'Number', value: 0.07 }] }],
  });
  const { service } = makeStack({ prebuiltScenarios: [makePrebuilt('alpha')] });
  // Access via createActiveScenario to observe what the factory receives
  const pb = service._registry.get('p:alpha');
  service.createActiveScenario();
  const callArgs = pb.factory.mock.calls[0][0];
  assert.strictEqual(callArgs.drift, 0.07);
});

test('_getParams: converts Date params to Date objects', () => {
  setStorageData({
    lastUsed: 'u:0',
    scenarios: [{
      name: 'S', scenarioId: 'p:alpha',
      params: [{ name: 'primaryRetirementDate', type: 'Date', value: '2040-01-01' }],
    }],
  });
  const pb = makePrebuilt('alpha');
  const { service } = makeStack({ prebuiltScenarios: [pb] });
  service.createActiveScenario();
  const callArgs = pb.factory.mock.calls[0][0];
  assert.ok(callArgs.primaryRetirementDate instanceof Date, 'Date param should be converted to Date');
  assert.strictEqual(callArgs.primaryRetirementDate.toISOString().slice(0, 10), '2040-01-01');
});

test('_getParams: Boolean params remain as boolean values', () => {
  setStorageData({
    lastUsed: 'u:0',
    scenarios: [{
      name: 'S', scenarioId: 'p:alpha',
      params: [{ name: 'reinvest', type: 'Boolean', value: true }],
    }],
  });
  const pb = makePrebuilt('alpha');
  const { service } = makeStack({ prebuiltScenarios: [pb] });
  service.createActiveScenario();
  const callArgs = pb.factory.mock.calls[0][0];
  assert.strictEqual(callArgs.reinvest, true);
});

test('_getParams: empty Date value does not produce an Invalid Date', () => {
  setStorageData({
    lastUsed: 'u:0',
    scenarios: [{
      name: 'S', scenarioId: 'p:alpha',
      params: [{ name: 'retirementDate', type: 'Date', value: '' }],
    }],
  });
  const pb = makePrebuilt('alpha');
  const { service } = makeStack({ prebuiltScenarios: [pb] });
  service.createActiveScenario();
  const callArgs = pb.factory.mock.calls[0][0];
  // Empty date value should pass through as empty string (falsy guard in _getParams)
  assert.strictEqual(callArgs.retirementDate, '');
});
