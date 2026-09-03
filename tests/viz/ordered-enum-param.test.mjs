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
 * ordered-enum-param.test.mjs — design 94 step 10, closing §10.2c.
 *
 * Step 9 shipped `drawdownSecurityOrder` on the checkbox group and wrote the limitation
 * down: `EnumMulti` expresses order by CHECK ORDER, so re-ordering means unticking
 * everything after the entry you want to move, and the order the control is storing is
 * not visible anywhere. `ordered: true` routes the param to a control that shows the
 * sequence and can change it.
 *
 * What is worth pinning is what would be silent if wrong:
 *
 *  1. the ordered param does NOT get the checkbox group, and the set-valued one still does
 *     — the two parameters want different controls, and a flag that silently did nothing
 *     would leave the old control in place looking correct;
 *  2. every mutation rewrites `param.value` IN LIST ORDER, because the list is the value;
 *  3. an option the scenario no longer offers stays in the control. Dropping it would
 *     leave the panel and the saved value disagreeing, which is the failure mode nobody
 *     notices.
 */

import assert from 'node:assert/strict';
import { ScenarioTabView } from '../../src/visualization/scenario/scenario-tab-view.js';

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

function renderParam(param) {
  const view = new ScenarioTabView();
  view._expandedGroups.add(param.group);
  const scenario = { params: [param] };
  view._renderParamsList(scenario);
  return scenario;
}

const rows     = () => [...document.querySelectorAll('#paramsList .ordered-enum-row')];
const rowNames = () => rows().map(r => r.dataset.opt);
const btn      = (row, glyph) => [...row.querySelectorAll('.ordered-enum-btn')].find(b => b.textContent === glyph);
const adder    = () => document.querySelector('#paramsList [data-role="add"]');

beforeEach(setupDOM);

const orderParam = (value, options) => ({
  name: 'drawdownSecurityOrder', label: 'Drawdown Security Order', type: 'EnumMulti',
  group: 'Spending', ordered: true, options, value,
});

test('an ordered param gets the sequence control, not the checkbox group', () => {
  renderParam(orderParam(['sec-emp'], ['sec-emp', 'sec-idx']));
  assert.equal(document.querySelectorAll('#paramsList .enum-multi-option').length, 0);
  assert.equal(rows().length, 1);
});

test('a SET-valued param still gets the checkbox group', () => {
  // The flag must not quietly convert every multi-select: `behavioralStrategies` is a set
  // — which strategies run — and position means nothing in it.
  renderParam({ name: 'behavioralStrategies', label: 'Behavioral', type: 'EnumMulti',
    group: 'Spending', options: ['PANIC_SELL', 'TLH'], value: ['TLH'] });
  assert.ok(document.querySelectorAll('#paramsList .enum-multi-option').length > 0);
  assert.equal(rows().length, 0);
});

test('the control shows the stored ORDER, ranked', () => {
  renderParam(orderParam(['sec-b', 'sec-a'], ['sec-a', 'sec-b']));
  assert.deepStrictEqual(rowNames(), ['sec-b', 'sec-a'], 'stored order, not option order');
  assert.deepStrictEqual(
    rows().map(r => r.querySelector('.ordered-enum-rank').textContent), ['1', '2']);
});

test('moving an entry rewrites param.value in list order', () => {
  const scenario = renderParam(orderParam(['sec-a', 'sec-b', 'sec-c'], ['sec-a', 'sec-b', 'sec-c']));
  btn(rows()[2], '↑').click();
  assert.deepStrictEqual(scenario.params[0].value, ['sec-a', 'sec-c', 'sec-b']);
  assert.deepStrictEqual(rowNames(), ['sec-a', 'sec-c', 'sec-b'], 'the control re-renders from the value');

  btn(rows()[0], '↓').click();
  assert.deepStrictEqual(scenario.params[0].value, ['sec-c', 'sec-a', 'sec-b']);
});

test('the ends are not movable past themselves', () => {
  renderParam(orderParam(['sec-a', 'sec-b'], ['sec-a', 'sec-b']));
  assert.equal(btn(rows()[0], '↑').disabled, true);
  assert.equal(btn(rows()[1], '↓').disabled, true);
});

test('removing drops it from the value; adding APPENDS', () => {
  const scenario = renderParam(orderParam(['sec-a', 'sec-b'], ['sec-a', 'sec-b', 'sec-c']));
  btn(rows()[0], '✕').click();
  assert.deepStrictEqual(scenario.params[0].value, ['sec-b']);

  const add = adder();
  // Appends rather than guessing a position: a new entry has no place in the order until
  // the author gives it one, and picking one would be a silent editorial decision.
  add.value = 'sec-a';
  add.dispatchEvent(new Event('change'));
  assert.deepStrictEqual(scenario.params[0].value, ['sec-b', 'sec-a']);
});

test('dragging one row onto another reorders', () => {
  // Drag state lives in the editor's closure, not on `dataTransfer`, precisely so this is
  // testable — jsdom has no DataTransfer, and a reorder control nobody can test is how
  // the arrows silently stop working.
  const scenario = renderParam(orderParam(['sec-a', 'sec-b', 'sec-c'], ['sec-a', 'sec-b', 'sec-c']));
  rows()[2].dispatchEvent(new Event('dragstart', { bubbles: true }));
  rows()[0].dispatchEvent(new Event('drop', { bubbles: true, cancelable: true }));
  assert.deepStrictEqual(scenario.params[0].value, ['sec-c', 'sec-a', 'sec-b']);
});

test('an option the scenario no longer offers is KEPT and marked', () => {
  const scenario = renderParam(orderParam(['sec-gone', 'sec-a'], ['sec-a']));
  assert.deepStrictEqual(rowNames(), ['sec-gone', 'sec-a']);
  assert.ok(rows()[0].classList.contains('ordered-enum-row--missing'));
  // Untouched until the author acts: silently dropping it here would leave the panel
  // showing one order and the run using another.
  assert.deepStrictEqual(scenario.params[0].value, ['sec-gone', 'sec-a']);
});

test('a scalar value is read as one selection, not as nothing', () => {
  // A param retyped from Enum arrives on already-saved scenarios as a bare string.
  renderParam(orderParam('sec-a', ['sec-a', 'sec-b']));
  assert.deepStrictEqual(rowNames(), ['sec-a']);
});

test('an empty order says what empty MEANS', () => {
  renderParam(orderParam([], ['sec-a']));
  assert.equal(rows().length, 0);
  assert.match(document.querySelector('#paramsList .ordered-enum-empty').textContent, /no bias/i);
});
