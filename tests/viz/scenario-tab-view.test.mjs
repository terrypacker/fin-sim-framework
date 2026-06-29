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

test('_renderParamsList: ExpenseBandList renders a 2-column band editor, not a text input', () => {
  const view = new ScenarioTabView();
  const scenario = { params: [{ name: 'spendingExpenseBands', type: 'ExpenseBandList',
    value: [{ startAge: 65, monthlyAmount: 7000 }, { startAge: 75, monthlyAmount: 6000 }] }] };
  view._renderParamsList(scenario);
  const editor = document.querySelector('#paramsList .age-band-list-editor');
  assert.ok(editor, 'expected a band editor, not a raw text input');
  assert.deepStrictEqual(
    [...editor.querySelectorAll('.age-band-col-label')].map(e => e.textContent),
    ['Start Age', 'Monthly Amount']);
  assert.strictEqual(editor.querySelectorAll('input[type="number"]').length, 4, 'two fields × two bands');
  const broken = [...document.querySelectorAll('#paramsList input')].some(i => String(i.value).includes('[object Object]'));
  assert.strictEqual(broken, false, 'no [object Object] text input');
});

test('_renderParamsList: editing an ExpenseBandList amount updates param.value', () => {
  const view = new ScenarioTabView();
  const scenario = { params: [{ name: 'spendingExpenseBands', type: 'ExpenseBandList',
    value: [{ startAge: 65, monthlyAmount: 7000 }] }] };
  view._renderParamsList(scenario);
  const amountInput = [...document.querySelectorAll('#paramsList .age-band-input')].find(i => i.value === '7000');
  assert.ok(amountInput);
  amountInput.value = '9000';
  amountInput.dispatchEvent(new Event('change'));
  assert.strictEqual(scenario.params[0].value[0].monthlyAmount, 9000);
});

test('_renderParamsList: RothScheduleList renders a 2-column year/target editor, not a text input', () => {
  const view = new ScenarioTabView();
  const scenario = { params: [{ name: 'rothConversionSchedule', type: 'RothScheduleList',
    value: [{ year: 2027, incomeTarget: 106595 }, { year: 2028, incomeTarget: 108996 }] }] };
  view._renderParamsList(scenario);
  const editor = document.querySelector('#paramsList .age-band-list-editor');
  assert.ok(editor, 'expected a schedule editor, not a raw text input');
  assert.deepStrictEqual(
    [...editor.querySelectorAll('.age-band-col-label')].map(e => e.textContent),
    ['Year', 'Income Target (real $)']);
  assert.strictEqual(editor.querySelectorAll('input[type="number"]').length, 4, 'two fields × two years');
  const broken = [...document.querySelectorAll('#paramsList input')].some(i => String(i.value).includes('[object Object]'));
  assert.strictEqual(broken, false, 'no [object Object] text input');
});

test('_renderParamsList: editing a RothScheduleList target updates param.value', () => {
  const view = new ScenarioTabView();
  const scenario = { params: [{ name: 'rothConversionSchedule', type: 'RothScheduleList',
    value: [{ year: 2027, incomeTarget: 106595 }] }] };
  view._renderParamsList(scenario);
  const targetInput = [...document.querySelectorAll('#paramsList .age-band-input')].find(i => i.value === '106595');
  assert.ok(targetInput);
  targetInput.value = '120000';
  targetInput.dispatchEvent(new Event('change'));
  assert.strictEqual(scenario.params[0].value[0].incomeTarget, 120000);
});

test('_renderParamsList: RothScheduleList coerces a stale string value to an empty list', () => {
  const view = new ScenarioTabView();
  const scenario = { params: [{ name: 'rothConversionSchedule', type: 'RothScheduleList',
    value: '[object Object],[object Object]' }] };
  view._renderParamsList(scenario);
  const editor = document.querySelector('#paramsList .age-band-list-editor');
  assert.ok(editor, 'expected a schedule editor');
  assert.deepStrictEqual(scenario.params[0].value, [], 'stale string coerced to []');
  const broken = [...document.querySelectorAll('#paramsList input')].some(i => String(i.value).includes('[object Object]'));
  assert.strictEqual(broken, false);
});

test('_renderParamsList: RothScheduleList "Add Year" appends a year and keeps order sorted', () => {
  const view = new ScenarioTabView();
  const scenario = { params: [{ name: 'rothConversionSchedule', type: 'RothScheduleList',
    value: [{ year: 2030, incomeTarget: 0 }] }] };
  view._renderParamsList(scenario);
  const addBtn = [...document.querySelectorAll('#paramsList button')].find(b => /Add Year/.test(b.textContent));
  assert.ok(addBtn);
  addBtn.dispatchEvent(new Event('click'));
  assert.strictEqual(scenario.params[0].value.length, 2);
  const years = scenario.params[0].value.map(e => e.year);
  assert.deepStrictEqual([...years].sort((a, b) => a - b), years, 'entries stay sorted by year');
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
    node: { type: 'account', stateKey: 'rothAccount', field: 'balance' },
  }] };
  view._renderParamsList(scenario);
  const label = document.querySelector('#paramsList .node-field label');
  assert.strictEqual(label.firstChild.textContent, 'Spouse Backup Roth — Balance');
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
    node: { type: 'account', stateKey: 'rothAccount', field: 'balance' },
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
  const paramNode = { type: 'account', stateKey: 'rothAccount', field: 'balance' };
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

// ═════════════════════════════════════════════════════════════════════════════
// Predefined params hide the type-select; AgeBandList + Enum editors (design/33)
// ═════════════════════════════════════════════════════════════════════════════

test('_renderParamsList: predefined (labeled) param does NOT render a type-select', () => {
  const view = new ScenarioTabView();
  const scenario = { params: [{ name: 'monthlyExpenses', label: 'Monthly Expenses', type: 'Number', value: 6000 }] };
  view._renderParamsList(scenario);
  const row = document.querySelector('#paramsList .param-row');
  // The only control here is the value input (+ delete button) — no type <select>.
  assert.strictEqual(row.querySelector('select'), null, 'labeled params should not show the type dropdown');
});

test('_renderParamsList: custom (unlabeled) param still renders the type-select', () => {
  const view = new ScenarioTabView();
  const scenario = { params: [{ name: 'customParam', type: 'Number', value: 1 }] };
  view._renderParamsList(scenario);
  const row = document.querySelector('#paramsList .param-row');
  assert.ok(row.querySelector('select'), 'custom params keep the type dropdown');
});

test('_renderParamsList: AgeBandList renders a row per band with start/multiplier/drift inputs', () => {
  const view = new ScenarioTabView();
  const bands = [
    { startAge: 0,  multiplier: 1.0, annualRealDrift: 0.0  },
    { startAge: 65, multiplier: 1.0, annualRealDrift: -0.01 },
  ];
  const scenario = { params: [{ name: 'spendingAgeBands', label: 'Spending Age Bands', type: 'AgeBandList', value: bands }] };
  view._renderParamsList(scenario);
  const editor = document.querySelector('#paramsList .age-band-list-editor');
  assert.ok(editor, 'expected an age-band-list-editor');
  const bandRows = editor.querySelectorAll('.age-band-row:not(.age-band-header)');
  assert.strictEqual(bandRows.length, 2, 'one row per band');
  assert.strictEqual(bandRows[0].querySelectorAll('input[type="number"]').length, 3, '3 numeric inputs per band');
});

test('_renderParamsList: AgeBandList clones the input value (no shared-reference mutation)', () => {
  const view = new ScenarioTabView();
  const shared = [{ startAge: 0, multiplier: 1.0, annualRealDrift: 0 }];
  const scenario = { params: [{ name: 'spendingAgeBands', label: 'Spending Age Bands', type: 'AgeBandList', value: shared }] };
  view._renderParamsList(scenario);
  assert.notStrictEqual(scenario.params[0].value, shared, 'param.value should be a fresh array');
  assert.notStrictEqual(scenario.params[0].value[0], shared[0], 'each band should be a fresh object');
});

test('_renderParamsList: AgeBandList "Add Band" appends a band and keeps order sorted', () => {
  const view = new ScenarioTabView();
  const scenario = { params: [{ name: 'spendingAgeBands', label: 'Spending Age Bands', type: 'AgeBandList', value: [{ startAge: 65, multiplier: 1, annualRealDrift: -0.01 }] }] };
  view._renderParamsList(scenario);
  const addBtn = [...document.querySelectorAll('#paramsList button')].find(b => /Add Band/.test(b.textContent));
  assert.ok(addBtn, 'expected an Add Band button');
  addBtn.click();
  assert.strictEqual(scenario.params[0].value.length, 2);
  assert.ok(scenario.params[0].value[1].startAge >= scenario.params[0].value[0].startAge, 'bands stay ascending');
});

test('_renderParamsList: editing a band input writes a number back to param.value', () => {
  const view = new ScenarioTabView();
  const scenario = { params: [{ name: 'spendingAgeBands', label: 'Spending Age Bands', type: 'AgeBandList', value: [{ startAge: 65, multiplier: 1, annualRealDrift: -0.01 }] }] };
  view._renderParamsList(scenario);
  const driftInput = document.querySelectorAll('#paramsList .age-band-row:not(.age-band-header) input[type="number"]')[2];
  driftInput.value = '-0.02';
  driftInput.dispatchEvent(new Event('change'));
  assert.strictEqual(scenario.params[0].value[0].annualRealDrift, -0.02);
});

test('_renderParamsList: Enum param renders a select with its options', () => {
  const view = new ScenarioTabView();
  const scenario = { params: [{ name: 'ageBandSpendingSlice', label: 'Age-Band Spending Slice', type: 'Enum', value: 'discretionary', options: ['discretionary', 'both'] }] };
  view._renderParamsList(scenario);
  const row = document.querySelector('#paramsList .param-row');
  const valueSelect = row.querySelector('select');
  assert.ok(valueSelect, 'expected a value <select>');
  const opts = [...valueSelect.options].map(o => o.value);
  assert.deepStrictEqual(opts, ['discretionary', 'both']);
  assert.strictEqual(valueSelect.value, 'discretionary');
});

test('_renderParamsList: predefined (labeled) param renders no delete button', () => {
  const view = new ScenarioTabView();
  const scenario = { params: [{ name: 'monthlyExpenses', label: 'Monthly Expenses', type: 'Number', value: 6000 }] };
  view._renderParamsList(scenario);
  const row = document.querySelector('#paramsList .param-row');
  assert.strictEqual(row.querySelector('.btn-warn'), null, 'labeled params should not show a delete button');
});

test('_renderParamsList: AgeBandList remove button uses the centered age-band-remove class', () => {
  const view = new ScenarioTabView();
  const scenario = { params: [{ name: 'spendingAgeBands', label: 'Spending Age Bands', type: 'AgeBandList', value: [{ startAge: 65, multiplier: 1, annualRealDrift: -0.01 }] }] };
  view._renderParamsList(scenario);
  const rm = document.querySelector('#paramsList .age-band-row:not(.age-band-header) .age-band-remove');
  assert.ok(rm, 'each band row has an age-band-remove button');
  // It must NOT carry btn-sm (whose padding overflows the narrow grid column).
  assert.ok(!rm.classList.contains('btn-sm'), 'band remove button should not use btn-sm padding');
});

// ═════════════════════════════════════════════════════════════════════════════
// visibleWhen — conditional param visibility (spending/behavioral strategies)
// ═════════════════════════════════════════════════════════════════════════════

function rowLabels() {
  return [...document.querySelectorAll('#paramsList .param-row .node-field > label')]
    .map(l => l.textContent);
}

test('_renderParamsList: visibleWhen hides a row when its controller does not include the value', () => {
  const view = new ScenarioTabView();
  view._expandedGroups.add('Spending'); // expand so rows render
  const scenario = { params: [
    { name: 'spendingStrategy', label: 'Spending Strategy', type: 'EnumMulti', group: 'Spending',
      options: ['FIXED', 'AGE_BANDED'], value: ['FIXED'] },
    { name: 'spendingAgeBands', label: 'Spending Age Bands', type: 'AgeBandList', group: 'Spending',
      value: [], visibleWhen: { param: 'spendingStrategy', includes: 'AGE_BANDED' } },
  ] };
  view._renderParamsList(scenario);
  assert.ok(!rowLabels().includes('Spending Age Bands'), 'band table hidden when AGE_BANDED not selected');
});

test('_renderParamsList: visibleWhen shows the row when its controller includes the value', () => {
  const view = new ScenarioTabView();
  view._expandedGroups.add('Spending');
  const scenario = { params: [
    { name: 'spendingStrategy', label: 'Spending Strategy', type: 'EnumMulti', group: 'Spending',
      options: ['FIXED', 'AGE_BANDED'], value: ['FIXED', 'AGE_BANDED'] },
    { name: 'spendingAgeBands', label: 'Spending Age Bands', type: 'AgeBandList', group: 'Spending',
      value: [], visibleWhen: { param: 'spendingStrategy', includes: 'AGE_BANDED' } },
  ] };
  view._renderParamsList(scenario);
  assert.ok(rowLabels().includes('Spending Age Bands'), 'band table shown when AGE_BANDED selected');
});

test('_renderParamsList: toggling the controller checkbox reveals dependents live', () => {
  const view = new ScenarioTabView();
  view._expandedGroups.add('Spending');
  const scenario = { params: [
    { name: 'spendingStrategy', label: 'Spending Strategy', type: 'EnumMulti', group: 'Spending',
      options: ['FIXED', 'AGE_BANDED'], value: ['FIXED'] },
    { name: 'spendingAgeBands', label: 'Spending Age Bands', type: 'AgeBandList', group: 'Spending',
      value: [], visibleWhen: { param: 'spendingStrategy', includes: 'AGE_BANDED' } },
  ] };
  view._renderParamsList(scenario);
  assert.ok(!rowLabels().includes('Spending Age Bands'), 'precondition: hidden');

  // Tick the AGE_BANDED checkbox in the EnumMulti editor.
  const ageBox = [...document.querySelectorAll('#paramsList .enum-multi-option input[type="checkbox"]')]
    .find(cb => cb.value === 'AGE_BANDED');
  assert.ok(ageBox, 'AGE_BANDED checkbox should render');
  ageBox.checked = true;
  ageBox.dispatchEvent(new Event('change'));

  assert.deepStrictEqual(scenario.params[0].value, ['FIXED', 'AGE_BANDED']);
  assert.ok(rowLabels().includes('Spending Age Bands'), 'dependent appears after toggling controller');
});

test('_renderParamsList: a group with only hidden params renders no group header', () => {
  const view = new ScenarioTabView();
  // Only a hidden-by-condition param in its own group → header should not appear.
  const scenario = { params: [
    { name: 'behavioralStrategies', label: 'Behavioral Strategies', type: 'EnumMulti', group: 'Behavioral',
      options: ['PANIC_SELL'], value: [] },
    { name: 'panicFraction', label: 'Panic Sell Fraction', type: 'Number', group: 'PanicCfg',
      value: 0.3, visibleWhen: { param: 'behavioralStrategies', includes: 'PANIC_SELL' } },
  ] };
  view._renderParamsList(scenario);
  const headers = [...document.querySelectorAll('#paramsList .param-group-header')].map(h => h.textContent);
  assert.ok(!headers.some(h => h.includes('PanicCfg')), 'group with only hidden params should have no header');
});

test('_renderParamsList: equals condition matches a boolean controller', () => {
  const view = new ScenarioTabView();
  view._expandedGroups.add('G');
  const scenario = { params: [
    { name: 'advanced', label: 'Advanced', type: 'Boolean', group: 'G', value: false },
    { name: 'knob', label: 'Knob', type: 'Number', group: 'G', value: 1,
      visibleWhen: { param: 'advanced', equals: true } },
  ] };
  view._renderParamsList(scenario);
  assert.ok(!rowLabels().includes('Knob'), 'hidden when boolean controller is false');

  const boolSel = [...document.querySelectorAll('#paramsList .param-row select')]
    .find(s => [...s.options].some(o => o.value === 'true'));
  boolSel.value = 'true';
  boolSel.dispatchEvent(new Event('change'));
  assert.ok(rowLabels().includes('Knob'), 'shown after boolean controller flips true');
});
