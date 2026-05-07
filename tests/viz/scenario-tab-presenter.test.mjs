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
 * Tests for ScenarioTabPresenter: pre-built scenario selection, last-used
 * persistence, createScenario() factory dispatch, and dropdown structure.
 *
 * Run with: npm run test:viz
 *
 * Environment: jest + jsdom (provides localStorage and a real DOM).
 */

import assert from 'node:assert/strict';
import { jest }                 from '@jest/globals';
import { ScenarioTabPresenter } from '../../src/apps/scenario-tab-presenter.js';
import { PrebuiltScenario }     from '../../src/scenarios/prebuilt-scenario.js';
import { ScenarioStorage }      from '../../src/scenarios/scenario-storage.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makePrebuilt(id, order = 1) {
  const factory = jest.fn((_p, _i, ui) => ({ id, ui, buildSim: jest.fn(), loadDefaults: jest.fn() }));
  return new PrebuiltScenario({
    id,
    label:    `Label ${id}`,
    order,
    simStart: '2026-01-01',
    simEnd:   '2041-01-01',
    factory,
  });
}

function makeStubUI() {
  return {
    registerEventCreatedListener:   jest.fn(),
    registerHandlerCreatedListener: jest.fn(),
    registerActionCreatedListener:  jest.fn(),
    registerReducerCreatedListener: jest.fn(),
    editNode: jest.fn(),
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
}

// ─── Setup / teardown ─────────────────────────────────────────────────────────

beforeEach(() => {
  localStorage.clear();
  setupDOM();
});

// ═════════════════════════════════════════════════════════════════════════════
// Constructor — _activeValue initialisation
// ═════════════════════════════════════════════════════════════════════════════

test('constructor: no storage, no prebuilt → _activeValue is empty string', () => {
  const p = new ScenarioTabPresenter();
  assert.strictEqual(p._activeValue, '');
});

test('constructor: no storage, one prebuilt → selects first prebuilt', () => {
  const pb = makePrebuilt('alpha');
  const p  = new ScenarioTabPresenter({ prebuiltScenarios: [pb] });
  assert.strictEqual(p._activeValue, 'p:alpha');
});

test('constructor: two prebuilts, selects lowest order first', () => {
  const pb1 = makePrebuilt('second', 2);
  const pb2 = makePrebuilt('first',  1);
  const p   = new ScenarioTabPresenter({ prebuiltScenarios: [pb1, pb2] });
  assert.strictEqual(p._activeValue, 'p:first');
});

test('constructor: saved scenarios but no lastUsed → falls back to u:0', () => {
  setStorageData({ scenarios: [{ name: 'MySaved', simStart: '2026-01-01', simEnd: '2041-01-01' }] });
  const pb = makePrebuilt('alpha');
  const p  = new ScenarioTabPresenter({ prebuiltScenarios: [pb] });
  assert.strictEqual(p._activeValue, 'u:0');
});

test('constructor: lastUsed persisted as prebuilt → restores it', () => {
  setStorageData({ lastUsed: 'p:alpha', scenarios: [] });
  const pb = makePrebuilt('alpha');
  const p  = new ScenarioTabPresenter({ prebuiltScenarios: [pb] });
  assert.strictEqual(p._activeValue, 'p:alpha');
});

test('constructor: lastUsed persisted as user scenario → restores it', () => {
  setStorageData({
    lastUsed:  'u:1',
    scenarios: [
      { name: 'First', simStart: '2026-01-01', simEnd: '2041-01-01' },
      { name: 'Second', simStart: '2026-01-01', simEnd: '2041-01-01' },
    ],
  });
  const p = new ScenarioTabPresenter({ prebuiltScenarios: [makePrebuilt('alpha')] });
  assert.strictEqual(p._activeValue, 'u:1');
});

// ═════════════════════════════════════════════════════════════════════════════
// _activePrebuilt() / _activeScenario()
// ═════════════════════════════════════════════════════════════════════════════

test('_activePrebuilt: returns prebuilt when p: is selected', () => {
  const pb = makePrebuilt('alpha');
  const p  = new ScenarioTabPresenter({ prebuiltScenarios: [pb] });
  // constructor already set 'p:alpha'
  assert.strictEqual(p._activePrebuilt(), pb);
});

test('_activePrebuilt: returns null when user scenario is selected', () => {
  setStorageData({ lastUsed: 'u:0', scenarios: [{ name: 'S' }] });
  const p = new ScenarioTabPresenter({ prebuiltScenarios: [makePrebuilt('alpha')] });
  assert.strictEqual(p._activePrebuilt(), null);
});

test('_activeScenario: returns scenario when u: is selected', () => {
  const saved = { name: 'MySaved', simStart: '2026-01-01', simEnd: '2041-01-01', params: [] };
  setStorageData({ lastUsed: 'u:0', scenarios: [saved] });
  const p = new ScenarioTabPresenter();
  assert.deepStrictEqual(p._activeScenario(), saved);
});

test('_activeScenario: returns null when prebuilt is selected', () => {
  const pb = makePrebuilt('alpha');
  const p  = new ScenarioTabPresenter({ prebuiltScenarios: [pb] });
  assert.strictEqual(p._activeScenario(), null);
});

// ═════════════════════════════════════════════════════════════════════════════
// getParams() / getInitialState()
// ═════════════════════════════════════════════════════════════════════════════

test('getParams: returns {} when prebuilt is selected', () => {
  const p = new ScenarioTabPresenter({ prebuiltScenarios: [makePrebuilt('alpha')] });
  assert.deepStrictEqual(p.getParams(), {});
});

test('getInitialState: returns {} when prebuilt is selected', () => {
  const p = new ScenarioTabPresenter({ prebuiltScenarios: [makePrebuilt('alpha')] });
  assert.deepStrictEqual(p.getInitialState(), {});
});

test('getParams: returns mapped params for user scenario', () => {
  setStorageData({
    lastUsed:  'u:0',
    scenarios: [{ name: 'S', params: [{ name: 'drift', type: 'Number', value: 0.05 }] }],
  });
  const p = new ScenarioTabPresenter();
  assert.deepStrictEqual(p.getParams(), { drift: 0.05 });
});

test('getInitialState: returns initialState for user scenario', () => {
  const state = { metrics: { amount: 99 } };
  setStorageData({ lastUsed: 'u:0', scenarios: [{ name: 'S', initialState: state }] });
  const p = new ScenarioTabPresenter();
  assert.deepStrictEqual(p.getInitialState(), state);
});

// ═════════════════════════════════════════════════════════════════════════════
// createScenario()
// ═════════════════════════════════════════════════════════════════════════════

test('createScenario: calls prebuilt factory when prebuilt is selected', () => {
  const pb = makePrebuilt('alpha');
  const p  = new ScenarioTabPresenter({ prebuiltScenarios: [pb] });

  p.createScenario({}, {});
  expect(pb.factory).toHaveBeenCalledWith({}, {}, new Date(pb.simStart), new Date(pb.simEnd));
});

test('createScenario: uses matching prebuilt factory for user scenario with scenarioId', () => {
  const pbA = makePrebuilt('alpha', 1);
  const pbB = makePrebuilt('beta',  2);
  //Set start/end dates
  const expectedStartDateString = '2025-01-01';
  const expectedEndDateString = '2026-01-01';

  setStorageData({
    lastUsed:  'u:0',
    scenarios: [{ name: 'S', scenarioId: 'beta', params: [], initialState: {},
      simStart: expectedStartDateString, simEnd: expectedEndDateString }],
  });
  const p  = new ScenarioTabPresenter({ prebuiltScenarios: [pbA, pbB] });
  p.createScenario({}, {});
  expect(pbA.factory).not.toHaveBeenCalled();
  expect(pbB.factory).toHaveBeenCalledWith({}, {}, new Date(expectedStartDateString), new Date(expectedEndDateString));
});

test('createScenario: falls back to first prebuilt for user scenario without scenarioId', () => {
  const pbA = makePrebuilt('alpha', 1);
  const pbB = makePrebuilt('beta',  2);

  const expectedStartDateString = '2025-01-01';
  const expectedEndDateString = '2026-01-01';
  setStorageData({
    lastUsed:  'u:0',
    scenarios: [{ name: 'S', params: [], initialState: {},
      simStart: expectedStartDateString, simEnd: expectedEndDateString }], // no scenarioId
  });
  const p  = new ScenarioTabPresenter({ prebuiltScenarios: [pbA, pbB] });
  p.createScenario({}, {});
  expect(pbA.factory).toHaveBeenCalledWith({}, {}, new Date(expectedStartDateString), new Date(expectedEndDateString));
});

test('createScenario: uses fallbackFactory when no prebuilt scenarios are registered', () => {
  const fallback = jest.fn(() => ({ buildSim: jest.fn() }));
  const p  = new ScenarioTabPresenter();   // no prebuilts

  //Set start/end dates
  const startDateInput = document.body.querySelector('#simStartInput');
  const expectedStartDateString = '2025-01-01';
  startDateInput.value = expectedStartDateString;

  const endDateInput = document.body.querySelector('#simEndInput');
  const expectedEndDateString = '2026-01-01';
  endDateInput.value = expectedEndDateString;

  p.createScenario({}, {}, fallback);
  expect(fallback).toHaveBeenCalledWith({}, {}, new Date(expectedStartDateString), new Date(expectedEndDateString));
});

test('createScenario: throws when no factory is available at all', () => {
  const p = new ScenarioTabPresenter();   // no prebuilts, no fallback
  assert.throws(
    () => p.createScenario({}, {}),
    /no scenario factory/i
  );
});

// ═════════════════════════════════════════════════════════════════════════════
// Dropdown / _refreshScenarioSelect
// ═════════════════════════════════════════════════════════════════════════════

test('init: dropdown shows prebuilt optgroup with correct option values', () => {
  const pb1 = makePrebuilt('alpha', 1);
  const pb2 = makePrebuilt('beta',  2);
  const p   = new ScenarioTabPresenter({ prebuiltScenarios: [pb1, pb2] });
  p.init(() => {});

  const sel    = document.getElementById('scenarioSelect');
  const groups = sel.querySelectorAll('optgroup');
  assert.ok(groups.length >= 1, 'should have at least one optgroup');

  const prebuiltGroup = groups[0];
  assert.strictEqual(prebuiltGroup.label, 'Pre-built Scenarios');

  const opts = prebuiltGroup.querySelectorAll('option');
  assert.strictEqual(opts.length, 2);
  assert.strictEqual(opts[0].value, 'p:alpha');
  assert.strictEqual(opts[1].value, 'p:beta');
});

test('init: dropdown shows saved optgroup when user scenarios exist', () => {
  setStorageData({
    scenarios: [
      { name: 'My Scenario', simStart: '2026-01-01', simEnd: '2041-01-01' },
    ],
  });
  const pb = makePrebuilt('alpha');
  const p  = new ScenarioTabPresenter({ prebuiltScenarios: [pb] });
  p.init(() => {});

  const sel    = document.getElementById('scenarioSelect');
  const groups = sel.querySelectorAll('optgroup');
  assert.strictEqual(groups.length, 2);

  const savedGroup = groups[1];
  assert.strictEqual(savedGroup.label, 'Saved Scenarios');

  const opts = savedGroup.querySelectorAll('option');
  assert.strictEqual(opts.length, 1);
  assert.strictEqual(opts[0].value, 'u:0');
  assert.strictEqual(opts[0].textContent, 'My Scenario');
});

test('init: dropdown pre-selects the active value', () => {
  const pb = makePrebuilt('alpha');
  const p  = new ScenarioTabPresenter({ prebuiltScenarios: [pb] });
  p.init(() => {});

  const sel = document.getElementById('scenarioSelect');
  assert.strictEqual(sel.value, 'p:alpha');
});

// ═════════════════════════════════════════════════════════════════════════════
// Populate form
// ═════════════════════════════════════════════════════════════════════════════

test('_populateScenarioForm: shows prebuilt label and dates for prebuilt selection', () => {
  const pb = new PrebuiltScenario({
    id: 'alpha', label: 'Alpha Scenario', order: 1,
    simStart: '2027-01-01', simEnd: '2042-01-01',
    factory: jest.fn(),
  });
  const p = new ScenarioTabPresenter({ prebuiltScenarios: [pb] });
  p.init(() => {});

  assert.strictEqual(document.getElementById('scenarioName').value,  'Alpha Scenario');
  assert.strictEqual(document.getElementById('simStartInput').value, '2027-01-01');
  assert.strictEqual(document.getElementById('simEndInput').value,   '2042-01-01');
  assert.strictEqual(document.getElementById('initialStateJson').value, '{}');
});

test('_populateScenarioForm: shows saved scenario values for user selection', () => {
  const saved = {
    name:         'My Save',
    simStart:     '2028-06-01',
    simEnd:       '2043-06-01',
    initialState: { metrics: { amount: 42 } },
    params:       [],
  };
  setStorageData({ lastUsed: 'u:0', scenarios: [saved] });
  const p = new ScenarioTabPresenter({ prebuiltScenarios: [makePrebuilt('alpha')] });
  p.init(() => {});

  assert.strictEqual(document.getElementById('scenarioName').value,  'My Save');
  assert.strictEqual(document.getElementById('simStartInput').value, '2028-06-01');
  assert.strictEqual(document.getElementById('simEndInput').value,   '2043-06-01');
});

// ═════════════════════════════════════════════════════════════════════════════
// Delete scenario
// ═════════════════════════════════════════════════════════════════════════════

test('delete: removes user scenario and falls back to first prebuilt', () => {
  const saved = { name: 'ToDelete', simStart: '2026-01-01', simEnd: '2041-01-01', params: [] };
  setStorageData({ lastUsed: 'u:0', scenarios: [saved] });
  const pb = makePrebuilt('alpha');
  const p  = new ScenarioTabPresenter({ prebuiltScenarios: [pb] });
  p.init(() => {});

  document.getElementById('deleteScenarioBtn').click();

  assert.strictEqual(p._activeValue, 'p:alpha');
  assert.strictEqual(p._scenarioData.scenarios.length, 0);
});

test('delete: does nothing when a prebuilt is selected', () => {
  const pb = makePrebuilt('alpha');
  const p  = new ScenarioTabPresenter({ prebuiltScenarios: [pb] });
  p.init(() => {});

  // Prebuilt selected — clicking delete should be a no-op.
  document.getElementById('deleteScenarioBtn').click();

  assert.strictEqual(p._activeValue, 'p:alpha');
});

// ═════════════════════════════════════════════════════════════════════════════
// lastUsed persistence
// ═════════════════════════════════════════════════════════════════════════════

test('lastUsed: persisted to localStorage on dropdown change', () => {
  const pb1 = makePrebuilt('alpha', 1);
  const pb2 = makePrebuilt('beta',  2);
  const p   = new ScenarioTabPresenter({ prebuiltScenarios: [pb1, pb2] });
  p.init(() => {});

  // Simulate user picking the second prebuilt.
  const sel = document.getElementById('scenarioSelect');
  sel.value = 'p:beta';
  sel.dispatchEvent(new Event('change'));

  const stored = JSON.parse(localStorage.getItem(ScenarioStorage.STORAGE_KEY));
  assert.strictEqual(stored.lastUsed, 'p:beta');
});

test('lastUsed: restored correctly on next construction', () => {
  const pb1 = makePrebuilt('alpha', 1);
  const pb2 = makePrebuilt('beta',  2);
  const p1  = new ScenarioTabPresenter({ prebuiltScenarios: [pb1, pb2] });
  p1.init(() => {});

  const sel = document.getElementById('scenarioSelect');
  sel.value = 'p:beta';
  sel.dispatchEvent(new Event('change'));

  // New presenter instance reads from localStorage.
  const p2 = new ScenarioTabPresenter({ prebuiltScenarios: [pb1, pb2] });
  assert.strictEqual(p2._activeValue, 'p:beta');
});

// ═════════════════════════════════════════════════════════════════════════════
// New scenario button
// ═════════════════════════════════════════════════════════════════════════════

test('newScenarioBtn: creates user scenario with scenarioId of active prebuilt', () => {
  const pb = makePrebuilt('alpha');
  const p  = new ScenarioTabPresenter({ prebuiltScenarios: [pb] });
  p.init(() => {});

  document.getElementById('newScenarioBtn').click();

  assert.strictEqual(p._scenarioData.scenarios.length, 1);
  assert.strictEqual(p._scenarioData.scenarios[0].scenarioId, 'alpha');
  assert.strictEqual(p._activeValue, 'u:0');
});
