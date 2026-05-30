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
 * scenario-tab-controller.test.mjs
 *
 * Tests for ScenarioTabController: delegation to ScenarioService and correct
 * return values.
 *
 * Run with: npm run test:viz
 */

import assert from 'node:assert/strict';
import { jest }                  from '@jest/globals';
import { ScenarioRegistry }      from '../../src/scenarios/scenario-registry.js';
import { Graph } from '../../src/graph/graph.js';
import { ScenarioService }       from '../../src/services/scenario-service.js';
import { ScenarioTabController } from '../../src/visualization/scenario/scenario-tab-controller.js';
import { ScenarioStorage }       from '../../src/scenarios/scenario-storage.js';
// ─── Helpers ─────────────────────────────────────────────────────────────────

function makePrebuilt(id, order = 1) {
  return {
    cls: {
      scenarioId:         () => id,
      scenarioName:       () => `Label ${id}`,
      getParamSchema:     () => [],
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

function makeStack({ prebuiltScenarios = [] } = {}) {
  const registry   = new ScenarioRegistry(new ScenarioStorage(), new Graph());
  registry.loadPrebuilt(prebuiltScenarios);
  const service    = new ScenarioService({}, registry);
  const controller = new ScenarioTabController({ scenarioService: service });
  return { registry, service, controller };
}

beforeEach(() => {
  localStorage.clear();
  if (typeof global.structuredClone !== 'function') {
    global.structuredClone = (obj) => JSON.parse(JSON.stringify(obj));
    // Note: JSON.parse/stringify is a basic fallback.
    // For full support (Dates, Sets, etc.), use a real polyfill like 'core-js'.
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// get / getActiveScenario
// ═════════════════════════════════════════════════════════════════════════════

test('get: returns scenario by id', () => {
  const { controller } = makeStack({ prebuiltScenarios: [makePrebuilt('alpha')] });
  assert.strictEqual(controller.get('p:alpha').id, 'p:alpha');
});

test('get: returns undefined for unknown id', () => {
  const { controller } = makeStack({ prebuiltScenarios: [makePrebuilt('alpha')] });
  assert.strictEqual(controller.get('p:nonexistent'), undefined);
});

test('getActiveScenario: returns current active scenario', () => {
  const { controller } = makeStack({ prebuiltScenarios: [makePrebuilt('alpha')] });
  assert.strictEqual(controller.getActiveScenario().id, 'p:alpha');
});

// ═════════════════════════════════════════════════════════════════════════════
// setActiveById
// ═════════════════════════════════════════════════════════════════════════════

test('setActiveById: changes active scenario', () => {
  const { controller, registry } = makeStack({
    prebuiltScenarios: [makePrebuilt('alpha', 1), makePrebuilt('beta', 2)],
  });
  controller.setActiveById('p:beta');
  assert.strictEqual(registry.getActive().id, 'p:beta');
});

// ═════════════════════════════════════════════════════════════════════════════
// newScenario
// ═════════════════════════════════════════════════════════════════════════════

test('newScenario: creates user scenario and returns it', () => {
  const pb = makePrebuilt('alpha');
  const { controller, registry } = makeStack({ prebuiltScenarios: [pb] });
  const fromScenario = registry.getActive();
  const created = controller.newScenario(fromScenario);
  assert.strictEqual(created.id, 'u:0');
  assert.strictEqual(registry.getActive().id, 'u:0');
});

// ═════════════════════════════════════════════════════════════════════════════
// delete
// ═════════════════════════════════════════════════════════════════════════════

test('delete: removes scenario and returns new active', () => {
  setStorageData({
    lastUsed: 'u:0',
    scenarios: [{ name: 'ToDelete', simStart: '2026-01-01', simEnd: '2041-01-01' }],
  });
  const { controller, registry } = makeStack({ prebuiltScenarios: [makePrebuilt('alpha')] });
  const toDelete = registry.get('u:0');
  const newActive = controller.delete(toDelete);
  assert.strictEqual(registry.getUserScenarios().length, 0);
  assert.strictEqual(newActive.id, 'p:alpha');
});

// ═════════════════════════════════════════════════════════════════════════════
// getAll / save
// ═════════════════════════════════════════════════════════════════════════════

test('getAll: returns all scenarios', () => {
  const { controller } = makeStack({
    prebuiltScenarios: [makePrebuilt('alpha', 1), makePrebuilt('beta', 2)],
  });
  assert.strictEqual(controller.getAll().length, 2);
});

test('save: makes scenario active', () => {
  const { controller, registry } = makeStack({
    prebuiltScenarios: [makePrebuilt('alpha', 1), makePrebuilt('beta', 2)],
  });
  const beta = registry.get('p:beta');
  controller.save(beta);
  assert.strictEqual(registry.getActive().id, 'p:beta');
});
