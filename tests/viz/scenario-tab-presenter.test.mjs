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
 * scenario-tab-presenter.test.mjs
 *
 * Tests for ScenarioTabPresenter: wiring between view callbacks and controller,
 * initial dropdown population, lastUsed persistence, and DOM reads.
 *
 * Run with: npm run test:viz
 */

import assert from 'node:assert/strict';
import { jest }                  from '@jest/globals';
import { ScenarioRegistry }      from '../../src/scenarios/scenario-registry.js';
import { ScenarioService }       from '../../src/services/scenario-service.js';
import { ScenarioTabController } from '../../src/visualization/scenario/scenario-tab-controller.js';
import { ScenarioTabView }       from '../../src/visualization/scenario/scenario-tab-view.js';
import { ScenarioTabPresenter }  from '../../src/visualization/scenario/scenario-tab-presenter.js';
import { ScenarioStorage }       from '../../src/scenarios/scenario-storage.js';
import { PrebuiltScenario }      from '../../src/scenarios/prebuilt-scenario.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makePrebuilt(id, order = 1) {
  const factory = jest.fn((_p, _i) => ({ id, buildSim: jest.fn(), loadDefaults: jest.fn() }));
  return new PrebuiltScenario({
    id, label: `Label ${id}`, order,
    simStart: new Date(Date.UTC(2026, 0, 1)),
    simEnd: new Date(Date.UTC(2041, 0, 1)),
    factory,
  });
}

function setStorageData(data) {
  localStorage.setItem(ScenarioStorage.STORAGE_KEY, JSON.stringify(data));
}

function setupDOM() {
  document.body.innerHTML = `
    <select  id="scenarioSelect"></select>
    <input   id="scenarioName" />
    <input   id="simStartInput" />
    <input   id="simEndInput" />
    <textarea id="initialStateJson"></textarea>
    <div     id="paramsList"></div>
    <button  id="loadScenarioBtn"></button>
    <button  id="newScenarioBtn"></button>
    <button  id="deleteScenarioBtn"></button>
    <button  id="saveScenarioBtn"></button>
    <button  id="addParamBtn"></button>
    <button  id="downloadJsonBtn"></button>
    <input   id="uploadJsonFileInput" type="file" />
  `;
  if (typeof global.structuredClone !== 'function') {
    global.structuredClone = (obj) => JSON.parse(JSON.stringify(obj));
    // Note: JSON.parse/stringify is a basic fallback.
    // For full support (Dates, Sets, etc.), use a real polyfill like 'core-js'.
  }
}

function makeStack({ prebuiltScenarios = [] } = {}) {
  const registry   = new ScenarioRegistry(new ScenarioStorage());
  registry.loadPrebuilt(prebuiltScenarios);
  const service    = new ScenarioService({}, registry);
  const controller = new ScenarioTabController({ scenarioService: service });
  const view       = new ScenarioTabView();
  const presenter  = new ScenarioTabPresenter({ controller, view, bus: {}, initScenario: () => {} });
  return { registry, service, controller, view, presenter };
}

// ─── Setup / teardown ─────────────────────────────────────────────────────────

beforeEach(() => {
  localStorage.clear();
  setupDOM();
});

// ═════════════════════════════════════════════════════════════════════════════
// Constructor — initial dropdown population
// ═════════════════════════════════════════════════════════════════════════════

test('constructor: populates dropdown with prebuilt optgroup', () => {
  makeStack({ prebuiltScenarios: [makePrebuilt('alpha', 1), makePrebuilt('beta', 2)] });
  const sel    = document.getElementById('scenarioSelect');
  const groups = sel.querySelectorAll('optgroup');
  assert.ok(groups.length >= 1);
  assert.strictEqual(groups[0].label, 'Pre-built Scenarios');
  const opts = groups[0].querySelectorAll('option');
  assert.strictEqual(opts[0].value, 'p:alpha');
  assert.strictEqual(opts[1].value, 'p:beta');
});

test('constructor: dropdown shows saved optgroup when user scenarios exist', () => {
  setStorageData({ scenarios: [{ name: 'My Scenario', simStart: '2026-01-01', simEnd: '2041-01-01' }] });
  makeStack({ prebuiltScenarios: [makePrebuilt('alpha')] });
  const sel    = document.getElementById('scenarioSelect');
  const groups = sel.querySelectorAll('optgroup');
  assert.strictEqual(groups.length, 2);
  assert.strictEqual(groups[1].label, 'Saved Scenarios');
  const opts = groups[1].querySelectorAll('option');
  assert.strictEqual(opts[0].value, 'u:0');
  assert.strictEqual(opts[0].textContent, 'My Scenario');
});

test('constructor: pre-selects the active scenario', () => {
  makeStack({ prebuiltScenarios: [makePrebuilt('alpha')] });
  assert.strictEqual(document.getElementById('scenarioSelect').value, 'p:alpha');
});

// ═════════════════════════════════════════════════════════════════════════════
// onOpen — dropdown change
// ═════════════════════════════════════════════════════════════════════════════

test('onOpen: switching scenario makes it active', () => {
  const { registry } = makeStack({ prebuiltScenarios: [makePrebuilt('alpha', 1), makePrebuilt('beta', 2)] });
  const sel = document.getElementById('scenarioSelect');
  sel.value = 'p:beta';
  sel.dispatchEvent(new Event('change'));
  assert.strictEqual(registry.getActive().id, 'p:beta');
});

test('onOpen: persists lastUsed to localStorage', () => {
  makeStack({ prebuiltScenarios: [makePrebuilt('alpha', 1), makePrebuilt('beta', 2)] });
  const sel = document.getElementById('scenarioSelect');
  sel.value = 'p:beta';
  sel.dispatchEvent(new Event('change'));
  const stored = JSON.parse(localStorage.getItem(ScenarioStorage.STORAGE_KEY));
  assert.strictEqual(stored.lastUsed, 'p:beta');
});

test('lastUsed restored correctly on next construction', () => {
  makeStack({ prebuiltScenarios: [makePrebuilt('alpha', 1), makePrebuilt('beta', 2)] });
  const sel = document.getElementById('scenarioSelect');
  sel.value = 'p:beta';
  sel.dispatchEvent(new Event('change'));

  setupDOM();
  const { registry: r2 } = makeStack({
    prebuiltScenarios: [makePrebuilt('alpha', 1), makePrebuilt('beta', 2)],
  });
  assert.strictEqual(r2.getActive().id, 'p:beta');
});

// ═════════════════════════════════════════════════════════════════════════════
// onNew
// ═════════════════════════════════════════════════════════════════════════════

test('onNew: creates user scenario with scenarioId of active prebuilt', () => {
  const pb = makePrebuilt('alpha');
  const { registry } = makeStack({ prebuiltScenarios: [pb] });
  document.getElementById('newScenarioBtn').click();
  assert.strictEqual(registry.getUserScenarios().length, 1);
  assert.strictEqual(registry.getUserScenarios()[0].scenarioId, 'p:alpha');
  assert.strictEqual(registry.getActive().id, 'u:0');
});

// ═════════════════════════════════════════════════════════════════════════════
// onDelete
// ═════════════════════════════════════════════════════════════════════════════

test('onDelete: removes user scenario and falls back to first prebuilt', () => {
  setStorageData({ lastUsed: 'u:0', scenarios: [{ name: 'ToDelete', simStart: '2026-01-01', simEnd: '2041-01-01', params: [] }] });
  const pb = makePrebuilt('alpha');
  const { registry } = makeStack({ prebuiltScenarios: [pb] });
  document.getElementById('deleteScenarioBtn').click();
  assert.strictEqual(registry.getUserScenarios().length, 0);
  assert.strictEqual(registry.getActive().id, 'p:alpha');
});

test('onDelete: does nothing when a prebuilt is active', () => {
  const pb = makePrebuilt('alpha');
  const { registry } = makeStack({ prebuiltScenarios: [pb] });
  document.getElementById('deleteScenarioBtn').click();
  assert.strictEqual(registry.getPrebuiltScenarios().length, 1);
  assert.strictEqual(registry.getActive().id, 'p:alpha');
});

// ═════════════════════════════════════════════════════════════════════════════
// getSimStart / getSimEnd
// ═════════════════════════════════════════════════════════════════════════════

test('getSimStart: returns Date parsed from simStartInput', () => {
  const { presenter } = makeStack({ prebuiltScenarios: [makePrebuilt('alpha')] });
  document.getElementById('simStartInput').value = '2025-06-15';
  assert.deepStrictEqual(presenter.getSimStart(), new Date('2025-06-15'));
});

test('getSimEnd: returns Date parsed from simEndInput', () => {
  const { presenter } = makeStack({ prebuiltScenarios: [makePrebuilt('alpha')] });
  document.getElementById('simEndInput').value = '2040-12-31';
  assert.deepStrictEqual(presenter.getSimEnd(), new Date('2040-12-31'));
});

test('getSimStart: returns undefined when simStartInput is empty', () => {
  const { presenter } = makeStack({ prebuiltScenarios: [makePrebuilt('alpha')] });
  document.getElementById('simStartInput').value = '';
  assert.strictEqual(presenter.getSimStart(), undefined);
});
