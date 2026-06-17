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
import { Graph } from '../../src/graph/graph.js';
import { ScenarioService }       from '../../src/services/scenario-service.js';
import { ScenarioTabController } from '../../src/visualization/scenario/scenario-tab-controller.js';
import { ScenarioTabView }       from '../../src/visualization/scenario/scenario-tab-view.js';
import { ScenarioTabPresenter }  from '../../src/visualization/scenario/scenario-tab-presenter.js';
import { ScenarioStorage }       from '../../src/scenarios/scenario-storage.js';
// ─── Helpers ─────────────────────────────────────────────────────────────────

function makePrebuilt(id, order = 1) {
  return {
    cls: {
      scenarioId:         () => id,
      scenarioName:       () => `Label ${id}`,
      getParamSchema:     () => [],
      buildDefaultConfig: () => null,
      instantiate:        jest.fn((_p, _s, _e) => ({ id, buildSim: jest.fn() })),
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
  const registry   = new ScenarioRegistry(new ScenarioStorage(), new Graph());
  registry.loadPrebuilt(prebuiltScenarios);
  const service    = new ScenarioService({}, registry);
  const controller = new ScenarioTabController({ scenarioService: service });
  const view       = new ScenarioTabView();
  const presenter  = new ScenarioTabPresenter({ controller, view, bus: {}, initScenario: () => {} });
  // BaseApp drives initial render externally now; mirror that here so tests
  // observe a populated dropdown / active scenario.
  presenter._refresh();
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
// onResetDefaults — destructive, confirmation-gated
// ═════════════════════════════════════════════════════════════════════════════

test('onResetDefaults: aborts without calling the controller when confirm is declined', () => {
  const { controller, view } = makeStack({ prebuiltScenarios: [makePrebuilt('alpha')] });
  const spy = jest.spyOn(controller, 'resetToDefaults');
  const orig = window.confirm;
  window.confirm = () => false; // user clicks Cancel
  try {
    view.onResetDefaults();
  } finally {
    window.confirm = orig;
  }
  assert.strictEqual(spy.mock.calls.length, 0, 'reset must not run when confirm is declined');
});

test('onResetDefaults: proceeds when confirm is accepted', () => {
  const { controller, view } = makeStack({ prebuiltScenarios: [makePrebuilt('alpha')] });
  const spy = jest.spyOn(controller, 'resetToDefaults');
  const orig = window.confirm;
  window.confirm = () => true; // user clicks OK
  try {
    view.onResetDefaults();
  } finally {
    window.confirm = orig;
  }
  assert.strictEqual(spy.mock.calls.length, 1, 'reset must run when confirm is accepted');
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

// ═════════════════════════════════════════════════════════════════════════════
// onDownloadJson — Design 15: serialize directly from active cfg
// ═════════════════════════════════════════════════════════════════════════════

/**
 * The download path must serialize from the active scenario record only — not
 * from the live "built scenario" or services. This guards the regression where
 * initialState saved in localStorage was clobbered by the built scenario's
 * empty initialState in the downloaded JSON.
 */
test('onDownloadJson: serialized payload reflects active cfg, not built scenario', () => {
  // Seed an active user scenario with hand-crafted persons / accounts /
  // initialState / params — the kind of data localStorage would carry.
  setStorageData({
    lastUsed: 'u:0',
    scenarios: [{
      name: 'My Saved',
      simStart: '2026-01-01',
      simEnd:   '2041-01-01',
      initialState:   { metrics: { keptThroughDownload: 42 } },
      persons:        [{ __type: 'Person', id: 'primary', birthDate: '1980-01-01' }],
      accounts:       [{ __type: 'CheckingAccount', stateKey: 'usSavingsAccount', balance: 12345 }],
      realProperties: [{ __type: 'RealProperty', stateKey: 'usHouseProperty', value: 500_000 }],
      collectibles:   [],
      events: [], handlers: [], actions: [], reducers: [],
      params:   [{ name: 'inflationRate', label: 'Inflation', type: 'Number', value: 0.025 }],
      toolsets: ['US_BANKING'],
    }],
  });
  const { view } = makeStack({ prebuiltScenarios: [makePrebuilt('alpha')] });

  // Intercept the download to inspect the payload that the view would receive.
  let downloaded = null;
  view.downloadJson = (data) => { downloaded = data; };

  document.getElementById('downloadJsonBtn').click();

  assert.ok(downloaded?.scenarios?.length === 1, 'download should produce a single scenario');
  const cfg = downloaded.scenarios[0];
  assert.deepStrictEqual(cfg.initialState, { metrics: { keptThroughDownload: 42 } },
    'initialState must round-trip through the download path');
  assert.strictEqual(cfg.name, 'My Saved');
  // Design 15: simStart/simEnd are full ISO strings end-to-end.
  assert.strictEqual(cfg.simStart, '2026-01-01T00:00:00.000Z');
  assert.strictEqual(cfg.simEnd,   '2041-01-01T00:00:00.000Z');
  assert.strictEqual(cfg.persons.length,        1);
  assert.strictEqual(cfg.accounts.length,       1);
  assert.strictEqual(cfg.realProperties.length, 1);
  assert.strictEqual(cfg.params[0].name,  'inflationRate');
  assert.strictEqual(cfg.params[0].value, 0.025);
  assert.deepStrictEqual(cfg.toolsets, ['US_BANKING']);
});

test('onDownloadJson: no-op when no active scenario is set', () => {
  const { view, registry } = makeStack({ prebuiltScenarios: [] });
  // No prebuilts and no user scenarios → no active scenario.
  assert.strictEqual(registry.getActive(), undefined);

  let downloaded = null;
  view.downloadJson = (data) => { downloaded = data; };
  document.getElementById('downloadJsonBtn').click();
  assert.strictEqual(downloaded, null, 'download should not fire when nothing is active');
});

test('onDownloadJson: empty initialState produces {} in payload', () => {
  setStorageData({
    lastUsed: 'u:0',
    scenarios: [{
      name: 'Empty State', simStart: '2026-01-01', simEnd: '2041-01-01',
      // no initialState field at all
      persons: [], accounts: [], realProperties: [], collectibles: [],
      events: [], handlers: [], actions: [], reducers: [],
      params: [], toolsets: [],
    }],
  });
  const { view } = makeStack({ prebuiltScenarios: [makePrebuilt('alpha')] });
  let downloaded = null;
  view.downloadJson = (data) => { downloaded = data; };
  document.getElementById('downloadJsonBtn').click();
  assert.deepStrictEqual(downloaded.scenarios[0].initialState, {});
});
