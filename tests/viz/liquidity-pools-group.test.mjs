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
 * liquidity-pools-group.test.mjs — design 114 §7.1 (S4), the Liquidity Pools group in the
 * Parameters list: a fixed order, one Structure editor for the base graph and the shapes, the two
 * switches on one line, the note about the "pool" params that size the mix, and a superseded
 * `drawdownSequence` while a pool graph is live.
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
beforeEach(setupDOM);

const GROUP = 'Liquidity Pools';
const GRAPH = { pools: [{ id: 'cash', spendOrder: 10, claims: [{ key: 'usSavingsAccount' }] }] };

/** The group's params in a deliberately scrambled list order. */
const scenarioOf = (over = {}) => ({ params: [
  { name: 'liquidityTargetSchedule', label: 'Target Schedule', type: 'LiquidityTargetSchedule', group: GROUP, value: null },
  { name: 'liquidityShapes',        label: 'Shapes',          type: 'LiquidityShapes',        group: GROUP,
    value: over.shapes ?? { later: { extends: 'base' } } },
  { name: 'poolFlowsEnabled',       label: 'Refill Flows',    type: 'Boolean',                group: GROUP, value: true },
  { name: 'liquidityGraphSchedule', label: 'Schedule',        type: 'LiquidityGraphSchedule', group: GROUP,
    value: [{ year: 2040, shape: 'later' }] },
  { name: 'liquidityGraph',         label: 'Graph',           type: 'LiquidityGraph',         group: GROUP,
    value: over.graph === undefined ? GRAPH : over.graph },
  { name: 'liquidityGraphEnabled',  label: 'Enabled',         type: 'Boolean',                group: GROUP,
    value: over.enabled ?? true },
  { name: 'poolCashYears', label: 'Cash Pool (years of spend)', type: 'Number', group: 'Behavioral', value: null },
  { name: 'drawdownSequence', label: 'Drawdown Sequence (pools)', type: 'DrawdownSequence', group: 'Spending',
    value: over.sequence ?? null },
] });

function render(scenario, groups = [GROUP]) {
  const view = new ScenarioTabView();
  for (const g of groups) view._expandedGroups.add(g);
  view._renderParamsList(scenario);
  return view;
}
const rowNames = () => [...document.querySelectorAll('#paramsList .param-row')].map(r => r.dataset.paramName);

test('S4: the group draws in a fixed order, with no row of its own for the shapes', () => {
  render(scenarioOf());
  assert.deepEqual(rowNames().filter(n => n !== 'poolCashYears' && n !== 'drawdownSequence'), [
    'liquidityGraphEnabled', 'poolFlowsEnabled', 'liquidityGraph', 'liquidityGraphSchedule',
    'liquidityTargetSchedule']);
});

test('S4: the two switches share one line', () => {
  render(scenarioOf());
  const pair = document.querySelector('#paramsList .param-row-pair');
  assert.deepEqual([...pair.children].map(r => r.dataset.paramName), ['liquidityGraphEnabled', 'poolFlowsEnabled']);
});

test('S4: the graph row is the Structure editor — Base first, then the shapes', () => {
  const scenario = scenarioOf();
  render(scenario);
  const tabs = [...document.querySelectorAll('#paramsList .pool-shape-tab')].map(t => t.textContent);
  assert.match(tabs[0], /^Base/);
  assert.match(tabs[1], /^later.*from 2040/);
  // The Base tab edits the `liquidityGraph` param itself.
  assert.deepEqual([...document.querySelectorAll('#paramsList .liquidity-graph-editor [data-id="id"]')]
    .map(i => i.value), ['cash']);
});

test('S4: a filter that matches only the shapes still draws the Structure', () => {
  const view = new ScenarioTabView();
  view._paramFilter = 'shapes';
  view._paramFilterFields = new Set(['label']);
  view._renderParamsList(scenarioOf());
  assert.deepEqual(rowNames(), ['liquidityGraph']);
  assert.ok(document.querySelector('#paramsList [data-id="shape-tab-base"]'));
});

test('S4: the note names the params that size the MIX, where the confusion happens', () => {
  render(scenarioOf());
  assert.match(document.querySelector('[data-id="pool-sizing-note"]').textContent,
    /size the allocation MIX — they are not these pools/);
});

test('S4: drawdownSequence is superseded while a pool graph is live, and says how to clear a stale one', () => {
  const scenario = scenarioOf({ sequence: [{ key: 'usSavingsAccount' }] });
  render(scenario, [GROUP, 'Spending']);
  const note = document.querySelector('[data-id="sequence-superseded"]');
  assert.match(note.textContent, /refuses the plan at load/);
  note.querySelector('[data-id="sequence-clear"]').click();
  assert.equal(scenario.params.find(p => p.name === 'drawdownSequence').value, null);
});

test('S4: with the pools switched off, drawdownSequence is an ordinary editor again', () => {
  render(scenarioOf({ enabled: false }), [GROUP, 'Spending']);
  assert.equal(document.querySelector('[data-id="sequence-superseded"]'), null);
});
