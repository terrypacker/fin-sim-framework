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
    name: 'My Save',
    simStart: new Date(Date.UTC(2028, 5, 1)),
    simEnd: new Date(Date.UTC(2043, 5, 1)),
    initialState: { metrics: { amount: 42 } }, params: [],
  });
  assert.strictEqual(document.getElementById('scenarioName').value,  'My Save');
  assert.strictEqual(document.getElementById('simStartInput').value, '2028-06-01');
  assert.strictEqual(document.getElementById('simEndInput').value,   '2043-06-01');
});

test('_populateScenarioForm: uses label as name for prebuilt (no name property)', () => {
  const view = new ScenarioTabView();
  view._populateScenarioForm({ label: 'Alpha Scenario',
    simStart: new Date(Date.UTC(2027, 0, 1)),
    simEnd: new Date(Date.UTC(2042, 0, 1)),
    prebuilt: true, params: [] });
  assert.strictEqual(document.getElementById('scenarioName').value, 'Alpha Scenario');
});

test('_populateScenarioForm: initialStateJson defaults to {"metrics":{}}', () => {
  const view = new ScenarioTabView();
  view._populateScenarioForm({ name: 'S',
    simStart: new Date(Date.UTC(2026, 0, 1)),
    simEnd: new Date(Date.UTC(2041, 0, 1)),
    params: [] });
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

// ═════════════════════════════════════════════════════════════════════════════
// _renderParamsList — typed param rendering
// ═════════════════════════════════════════════════════════════════════════════

test('_renderParamsList: renders nothing when params is empty', () => {
  const view = new ScenarioTabView();
  view._renderParamsList({ params: [] });
  assert.strictEqual(document.getElementById('paramsList').innerHTML, '');
});

test('_renderParamsList: Number param renders a text input with numeric value', () => {
  const view = new ScenarioTabView();
  const scenario = { params: [{ name: 'monthlyExpenses', type: 'Number', value: 6000 }] };
  view._renderParamsList(scenario);
  const inputs = document.querySelectorAll('#paramsList input');
  assert.ok(inputs.length >= 1);
  const valueInput = [...inputs].find(el => el.value === '6000');
  assert.ok(valueInput, 'expected an input with value 6000');
});

test('_renderParamsList: editing Number input updates param.value as a number', () => {
  const view = new ScenarioTabView();
  const scenario = { params: [{ name: 'drift', type: 'Number', value: 0.05 }] };
  view._renderParamsList(scenario);
  const valueInput = [...document.querySelectorAll('#paramsList input')].find(el => el.value === '0.05');
  assert.ok(valueInput);
  valueInput.value = '0.07';
  valueInput.dispatchEvent(new Event('input'));
  assert.strictEqual(scenario.params[0].value, 0.07);
});

test('_renderParamsList: Date param renders an <input type="date">', () => {
  const view = new ScenarioTabView();
  const scenario = { params: [{ name: 'primaryRetirementDate', type: 'Date', value: '2040-01-01' }] };
  view._renderParamsList(scenario);
  const dateInputs = document.querySelectorAll('#paramsList input[type="date"]');
  assert.strictEqual(dateInputs.length, 1);
  assert.strictEqual(dateInputs[0].value, '2040-01-01');
});

test('_renderParamsList: editing Date input stores ISO string in param.value', () => {
  const view = new ScenarioTabView();
  const scenario = { params: [{ name: 'primaryRetirementDate', type: 'Date', value: '2040-01-01' }] };
  view._renderParamsList(scenario);
  const dateInput = document.querySelector('#paramsList input[type="date"]');
  dateInput.value = '2038-06-15';
  dateInput.dispatchEvent(new Event('change'));
  assert.strictEqual(scenario.params[0].value, '2038-06-15');
});

test('_renderParamsList: Boolean param renders a select with true/false options', () => {
  const view = new ScenarioTabView();
  const scenario = { params: [{ name: 'reinvest', type: 'Boolean', value: false }] };
  view._renderParamsList(scenario);
  const rows = document.querySelectorAll('#paramsList .param-row');
  assert.strictEqual(rows.length, 1);
  // Should have two selects: type select + boolean value select
  const selects = rows[0].querySelectorAll('select');
  const boolSelect = [...selects].find(s => [...s.options].some(o => o.value === 'true'));
  assert.ok(boolSelect, 'expected a boolean value select');
  assert.strictEqual(boolSelect.value, 'false');
});

test('_renderParamsList: editing Boolean select stores boolean in param.value', () => {
  const view = new ScenarioTabView();
  const scenario = { params: [{ name: 'reinvest', type: 'Boolean', value: false }] };
  view._renderParamsList(scenario);
  const rows = document.querySelectorAll('#paramsList .param-row');
  const selects = rows[0].querySelectorAll('select');
  const boolSelect = [...selects].find(s => [...s.options].some(o => o.value === 'true'));
  boolSelect.value = 'true';
  boolSelect.dispatchEvent(new Event('change'));
  assert.strictEqual(scenario.params[0].value, true);
});

test('_renderParamsList: schema param with label shows a <label> with the label text and key as title', () => {
  const view = new ScenarioTabView();
  const scenario = { params: [{ name: 'monthlyExpenses', label: 'Monthly Expenses', type: 'Number', value: 6000 }] };
  view._renderParamsList(scenario);
  const label = document.querySelector('#paramsList .node-field label');
  assert.ok(label, 'expected a <label> inside .node-field');
  assert.strictEqual(label.textContent, 'Monthly Expenses');
  assert.strictEqual(label.title, 'monthlyExpenses');
});

test('_renderParamsList: schema param without label shows editable name input', () => {
  const view = new ScenarioTabView();
  const scenario = { params: [{ name: 'customParam', type: 'Number', value: 42 }] };
  view._renderParamsList(scenario);
  const nameInput = [...document.querySelectorAll('#paramsList input')].find(el => el.value === 'customParam');
  assert.ok(nameInput, 'expected an editable name input');
});

test('_renderParamsList: group headers appear once per group', () => {
  const view = new ScenarioTabView();
  const scenario = {
    params: [
      { name: 'a', type: 'Number', group: 'People', value: 1 },
      { name: 'b', type: 'Number', group: 'People', value: 2 },
      { name: 'c', type: 'Number', group: 'Rates',  value: 3 },
    ],
  };
  view._renderParamsList(scenario);
  const headers = document.querySelectorAll('#paramsList .param-group-header');
  assert.strictEqual(headers.length, 2);
  // Header text now includes a leading collapse caret; assert the group label.
  assert.ok(headers[0].textContent.includes('People'));
  assert.ok(headers[1].textContent.includes('Rates'));
});

test('_renderParamsList: groups are collapsed by default', () => {
  const view = new ScenarioTabView();
  const scenario = {
    params: [
      { name: 'a', type: 'Number', group: 'People', value: 1 },
      { name: 'b', type: 'Number', group: 'Rates',  value: 2 },
    ],
  };
  view._renderParamsList(scenario);
  // Headers render, but no rows until a group is expanded.
  assert.strictEqual(document.querySelectorAll('#paramsList .param-group-header').length, 2);
  assert.strictEqual(document.querySelectorAll('#paramsList .param-row').length, 0);
});

test('_renderParamsList: filter hides non-matching params and groups', () => {
  const view = new ScenarioTabView();
  const scenario = {
    params: [
      { name: 'inflationRate', label: 'Inflation', type: 'Number', group: 'Rates',  value: 1 },
      { name: 'wageGrowth',    label: 'Wage',      type: 'Number', group: 'People', value: 2 },
    ],
  };
  view._paramFilterFields = new Set(['label', 'name', 'group', 'description']);
  view._paramFilter = 'inflation';
  view._renderParamsList(scenario);
  // An active filter force-expands matching groups, so the matching row shows.
  assert.strictEqual(document.querySelectorAll('#paramsList .param-row').length, 1);
  const headers = document.querySelectorAll('#paramsList .param-group-header');
  assert.strictEqual(headers.length, 1);
  assert.ok(headers[0].textContent.includes('Rates'));
});

test('_renderParamsList: active filter force-expands collapsed groups', () => {
  const view = new ScenarioTabView();
  const scenario = {
    params: [{ name: 'inflationRate', type: 'Number', group: 'Rates', value: 1 }],
  };
  // Default-collapsed; the filter overrides it so the matching row is visible.
  view._paramFilterFields = new Set(['name']);
  view._paramFilter = 'inflation';
  view._renderParamsList(scenario);
  assert.strictEqual(document.querySelectorAll('#paramsList .param-row').length, 1);
});

test('_renderParamsList: clicking a group header expands/collapses its rows', () => {
  const view = new ScenarioTabView();
  const scenario = {
    params: [
      { name: 'a', type: 'Number', group: 'People', value: 1 },
      { name: 'b', type: 'Number', group: 'Rates',  value: 2 },
    ],
  };
  view._renderParamsList(scenario);
  // Collapsed by default — no rows.
  assert.strictEqual(document.querySelectorAll('#paramsList .param-row').length, 0);

  const peopleHeader = document.querySelector('#paramsList .param-group-header');
  peopleHeader.click();   // expand "People"
  assert.ok(view._expandedGroups.has('People'));
  assert.strictEqual(document.querySelectorAll('#paramsList .param-row').length, 1);

  document.querySelector('#paramsList .param-group-header').click();  // collapse again
  assert.ok(!view._expandedGroups.has('People'));
  assert.strictEqual(document.querySelectorAll('#paramsList .param-row').length, 0);
});

test('_paramMatchesFilter: defaults to description only', () => {
  const view = new ScenarioTabView();
  assert.deepStrictEqual([...view._paramFilterFields], ['description']);
  const param = { name: 'inflationRate', label: 'Inflation', group: 'Rates', description: 'CPI growth' };
  // Matches on description text…
  assert.ok(view._paramMatchesFilter(param, 'cpi'));
  // …but not on name/label/group while those fields are unselected.
  assert.ok(!view._paramMatchesFilter(param, 'inflation'));
  // Opting name in makes the name searchable.
  view._paramFilterFields.add('name');
  assert.ok(view._paramMatchesFilter(param, 'inflationrate'));
});

test('_renderParamsList: delete button removes param and re-renders', () => {
  const view = new ScenarioTabView();
  const scenario = {
    params: [
      { name: 'a', type: 'Number', value: 1 },
      { name: 'b', type: 'Number', value: 2 },
    ],
  };
  view._renderParamsList(scenario);
  const delBtns = document.querySelectorAll('#paramsList .btn-warn');
  assert.strictEqual(delBtns.length, 2);
  delBtns[0].click();
  assert.strictEqual(scenario.params.length, 1);
  assert.strictEqual(scenario.params[0].name, 'b');
  assert.strictEqual(document.querySelectorAll('#paramsList .param-row').length, 1);
});

// ═════════════════════════════════════════════════════════════════════════════
// _renderParamsList — linked-node label resolution
// ═════════════════════════════════════════════════════════════════════════════

test('_renderParamsList: account-linked param uses live account name in label', () => {
  const view = new ScenarioTabView();
  view.nodeLookup = (n) => n.type === 'account' && n.stateKey === 'rothAccount'
    ? { name: 'Spouse Backup Roth', kind: 'account', node: { kind: 'account', id: 'a1', name: 'Spouse Backup Roth' }, found: true }
    : null;
  const scenario = { params: [{
    name: 'rothBalance', label: 'Roth IRA Balance (USD)', type: 'Number', value: 80000,
    node: { type: 'account', stateKey: 'rothAccount', field: 'initialValue' },
  }] };
  view._renderParamsList(scenario);
  const label = document.querySelector('#paramsList .node-field label');
  assert.strictEqual(label.firstChild.textContent, 'Spouse Backup Roth — Initial Balance');
});

test('_renderParamsList: person-linked param uses live person name in label', () => {
  const view = new ScenarioTabView();
  view.nodeLookup = (n) => n.type === 'person' && n.id === 'primary'
    ? { name: 'Alex', kind: 'person', node: { kind: 'person', id: 'primary', name: 'Alex' }, found: true }
    : null;
  const scenario = { params: [{
    name: 'primaryMonthlyWage', label: 'Primary Monthly Wage (USD)', type: 'Number', value: 8000,
    node: { type: 'person', id: 'primary', field: 'monthlyWage' },
  }] };
  view._renderParamsList(scenario);
  const label = document.querySelector('#paramsList .node-field label');
  assert.strictEqual(label.firstChild.textContent, 'Alex — Monthly Wage');
});

test('_renderParamsList: unresolved linked param marks row as unlinked', () => {
  const view = new ScenarioTabView();
  view.nodeLookup = () => ({ name: 'rothAccount', kind: 'account', node: null, found: false });
  const scenario = { params: [{
    name: 'rothBalance', label: 'Roth IRA Balance (USD)', type: 'Number', value: 80000,
    node: { type: 'account', stateKey: 'rothAccount', field: 'initialValue' },
  }] };
  view._renderParamsList(scenario);
  const row = document.querySelector('#paramsList .param-row');
  assert.ok(row.classList.contains('param-row--unlinked'), 'row should be marked unlinked');
  const label = row.querySelector('label');
  assert.strictEqual(label.textContent, '(unlinked) Roth IRA Balance (USD)');
});

test('_renderParamsList: linked param renders open-node button that fires onOpenLinkedNode', () => {
  const view = new ScenarioTabView();
  view.nodeLookup = (n) => ({ name: 'Roth IRA', kind: 'account', node: { kind: 'account', id: 'a1' }, found: true });
  const onOpen = jest.fn();
  view.onOpenLinkedNode = onOpen;
  const paramNode = { type: 'account', stateKey: 'rothAccount', field: 'initialValue' };
  const scenario = { params: [{ name: 'rothBalance', label: 'Roth IRA Balance', type: 'Number', value: 0, node: paramNode }] };
  view._renderParamsList(scenario);
  const linkBtn = document.querySelector('#paramsList .param-link-btn');
  assert.ok(linkBtn, 'expected a .param-link-btn');
  linkBtn.click();
  expect(onOpen).toHaveBeenCalledWith(paramNode);
});

test('_renderParamsList: param without node declaration still uses static label', () => {
  const view = new ScenarioTabView();
  view.nodeLookup = jest.fn();
  const scenario = { params: [{ name: 'monthlyExpenses', label: 'Monthly Expenses', type: 'Number', value: 6000 }] };
  view._renderParamsList(scenario);
  const label = document.querySelector('#paramsList .node-field label');
  assert.strictEqual(label.textContent, 'Monthly Expenses');
  expect(view.nodeLookup).not.toHaveBeenCalled();
});

test('_humanizeField: known overrides and camelCase splitting', () => {
  const view = new ScenarioTabView();
  assert.strictEqual(view._humanizeField('initialValue'),   'Initial Balance');
  assert.strictEqual(view._humanizeField('minimumBalance'), 'Min Balance');
  assert.strictEqual(view._humanizeField('balance'),        'Balance');
  assert.strictEqual(view._humanizeField('monthlyWage'),    'Monthly Wage');
  assert.strictEqual(view._humanizeField('retirementDate'), 'Retirement Date');
  assert.strictEqual(view._humanizeField(''),               '');
});

test('_renderParamsList: type dropdown includes Date as an option', () => {
  const view = new ScenarioTabView();
  const scenario = { params: [{ name: 'x', type: 'Number', value: 0 }] };
  view._renderParamsList(scenario);
  const typeSelect = document.querySelector('#paramsList .param-row select');
  const options = [...typeSelect.options].map(o => o.value);
  assert.ok(options.includes('Date'), 'Date should be a type option');
  assert.ok(options.includes('Boolean'), 'Boolean should be a type option');
});
