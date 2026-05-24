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
 * scenario-tab-view.test.mjs
 *
 * Tests for ScenarioTabView: DOM rendering, form population, and event
 * callback wiring.
 *
 * Run with: npm run test:viz
 */

import assert from 'node:assert/strict';
import { jest }            from '@jest/globals';
import { ScenarioTabView } from '../../src/visualization/scenario/scenario-tab-view.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

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

/** Build scenario objects as the registry would produce them */
function prebuiltEntry(id, order = 1) {
  return { id: 'p:' + id, label: 'Label ' + id, order, prebuilt: true, simStart: '2026-01-01', simEnd: '2041-01-01' };
}

function userEntry(index, name = 'My Scenario') {
  return { id: 'u:' + index, name, order: 100, prebuilt: false, simStart: '2026-01-01', simEnd: '2041-01-01', params: [], initialState: {} };
}

beforeEach(() => { setupDOM(); });

// ═════════════════════════════════════════════════════════════════════════════
// _refreshScenarioSelect — structure
// ═════════════════════════════════════════════════════════════════════════════

test('_refreshScenarioSelect: prebuilt optgroup has p: prefixed option values', () => {
  const view = new ScenarioTabView();
  const scenarios = [prebuiltEntry('alpha', 1), prebuiltEntry('beta', 2)];
  view._refreshScenarioSelect(scenarios, scenarios[0]);

  const sel    = document.getElementById('scenarioSelect');
  const groups = sel.querySelectorAll('optgroup');
  assert.ok(groups.length >= 1);
  assert.strictEqual(groups[0].label, 'Pre-built Scenarios');

  const opts = groups[0].querySelectorAll('option');
  assert.strictEqual(opts[0].value, 'p:alpha');
  assert.strictEqual(opts[1].value, 'p:beta');
});

test('_refreshScenarioSelect: saved optgroup shows u: option values and names', () => {
  const view = new ScenarioTabView();
  const scenarios = [prebuiltEntry('alpha'), userEntry(0, 'My Scenario')];
  view._refreshScenarioSelect(scenarios, scenarios[0]);

  const sel    = document.getElementById('scenarioSelect');
  const groups = sel.querySelectorAll('optgroup');
  assert.strictEqual(groups.length, 2);
  assert.strictEqual(groups[1].label, 'Saved Scenarios');

  const opts = groups[1].querySelectorAll('option');
  assert.strictEqual(opts[0].value, 'u:0');
  assert.strictEqual(opts[0].textContent, 'My Scenario');
});

test('_refreshScenarioSelect: no saved optgroup when there are no user scenarios', () => {
  const view = new ScenarioTabView();
  const scenarios = [prebuiltEntry('alpha')];
  view._refreshScenarioSelect(scenarios, scenarios[0]);

  const sel    = document.getElementById('scenarioSelect');
  const groups = sel.querySelectorAll('optgroup');
  assert.strictEqual(groups.length, 1);
});

test('_refreshScenarioSelect: pre-selects the active scenario', () => {
  const view = new ScenarioTabView();
  const scenarios = [prebuiltEntry('alpha', 1), prebuiltEntry('beta', 2)];
  view._refreshScenarioSelect(scenarios, scenarios[1]);
  assert.strictEqual(document.getElementById('scenarioSelect').value, 'p:beta');
});

// ═════════════════════════════════════════════════════════════════════════════
// _populateScenarioForm
// ═════════════════════════════════════════════════════════════════════════════

test('_populateScenarioForm: fills name, dates, and initialState for user scenario', () => {
  const view = new ScenarioTabView();
  view._populateScenarioForm({
    name: 'My Save', simStart: '2028-06-01', simEnd: '2043-06-01',
    initialState: { metrics: { amount: 42 } }, params: [],
  });
  assert.strictEqual(document.getElementById('scenarioName').value,  'My Save');
  assert.strictEqual(document.getElementById('simStartInput').value, '2028-06-01');
  assert.strictEqual(document.getElementById('simEndInput').value,   '2043-06-01');
});

test('_populateScenarioForm: uses label as name for prebuilt (no name property)', () => {
  const view = new ScenarioTabView();
  view._populateScenarioForm({ label: 'Alpha Scenario', simStart: '2027-01-01', simEnd: '2042-01-01', prebuilt: true, params: [] });
  assert.strictEqual(document.getElementById('scenarioName').value, 'Alpha Scenario');
});

test('_populateScenarioForm: initialStateJson defaults to {"metrics":{}}', () => {
  const view = new ScenarioTabView();
  view._populateScenarioForm({ name: 'S', simStart: '2026-01-01', simEnd: '2041-01-01', params: [] });
  const raw = document.getElementById('initialStateJson').value;
  assert.deepStrictEqual(JSON.parse(raw), { metrics: {} });
});

// ═════════════════════════════════════════════════════════════════════════════
// Event callbacks
// ═════════════════════════════════════════════════════════════════════════════

test('deleteScenarioBtn click fires onDelete', () => {
  const view = new ScenarioTabView();
  const onDelete = jest.fn();
  view.onDelete = onDelete;
  document.getElementById('deleteScenarioBtn').click();
  expect(onDelete).toHaveBeenCalled();
});

test('newScenarioBtn click fires onNew', () => {
  const view = new ScenarioTabView();
  const onNew = jest.fn();
  view.onNew = onNew;
  document.getElementById('newScenarioBtn').click();
  expect(onNew).toHaveBeenCalled();
});

test('loadScenarioBtn click fires onRebuild', () => {
  const view = new ScenarioTabView();
  const onRebuild = jest.fn();
  view.onRebuild = onRebuild;
  document.getElementById('loadScenarioBtn').click();
  expect(onRebuild).toHaveBeenCalled();
});

test('saveScenarioBtn click fires onSave', () => {
  const view = new ScenarioTabView();
  const onSave = jest.fn();
  view.onSave = onSave;
  document.getElementById('saveScenarioBtn').click();
  expect(onSave).toHaveBeenCalled();
});

test('scenarioSelect change event fires onOpen with selected value', () => {
  const view = new ScenarioTabView();
  const onOpen = jest.fn();
  view.onOpen = onOpen;
  const scenarios = [prebuiltEntry('alpha', 1), prebuiltEntry('beta', 2)];
  view._refreshScenarioSelect(scenarios, scenarios[0]);
  const sel = document.getElementById('scenarioSelect');
  sel.value = 'p:beta';
  sel.dispatchEvent(new Event('change'));
  expect(onOpen).toHaveBeenCalledWith('p:beta');
});

test('updateSelectOption: updates the text of the currently selected option', () => {
  const view = new ScenarioTabView();
  const scenarios = [prebuiltEntry('alpha')];
  view._refreshScenarioSelect(scenarios, scenarios[0]);
  view.updateSelectOption('Renamed');
  const sel = document.getElementById('scenarioSelect');
  assert.strictEqual(sel.options[sel.selectedIndex].textContent, 'Renamed');
});
