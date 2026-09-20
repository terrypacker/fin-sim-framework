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
 * dg-mpc-runs.test.mjs
 *
 * DESIGN 81 phase 8 — the decision-graph panel's two additions. The mechanism is proven in
 * `mpc-run-as-decision-point.test.mjs` (the §4.2 gate); these are the two places a user can
 * reach it, and the properties that are easy to break by accident.
 *
 * DGR-1  Picking `mpcActiveRun` fills the options from the BASE SCENARIO's bag
 * DGR-2  The options follow the base-scenario select, rather than being captured early
 * DGR-3  "+ Compare recorded runs" builds the whole decision point in one click
 * DGR-4  A scenario with no runs says so, instead of adding an empty point
 *
 * Run with: npm run test:viz
 */

import assert from 'node:assert/strict';
import { DgConfigPanel } from '../../src/visualization/decision-graph/dg-config-panel.js';

const SCHEMA = [
  { key: 'mpcActiveRun', label: 'Active MPC Run', type: 'MpcRunSelect', group: 'MPC Runs' },
  { key: 'inflationRate', label: 'Inflation Rate', type: 'Number', group: 'Economy' },
];

const runEntry = (levers, epochs) => ({
  source: { recordedAt: '2026-09-20T00:00:00.000Z', levers, epochs, solver: 'CEM/128' },
  decisions: [{ date: '2033-01-01', lever: 'SPENDING', key: 'band@55', value: 9000 }],
});

/** Two scenarios: one carrying runs, one carrying none. */
const scenarios = () => ([
  { id: 'with-runs', name: 'With runs', order: 0, params: [
    { name: 'mpcRuns', type: 'MpcRuns', value: {
      'run:a': runEntry(['SPENDING'], 44), 'run:b': runEntry(['SPENDING', 'ROTH'], 12) } },
    { name: 'mpcActiveRun', type: 'MpcRunSelect', value: null },
  ] },
  { id: 'no-runs', name: 'No runs', order: 1, params: [] },
]);

function mountPanel() {
  document.body.innerHTML = '<div id="host"></div>';
  const list = scenarios();
  const panel = new DgConfigPanel(
    document.getElementById('host'),
    { getAll: () => [], save: () => {}, delete: () => {} },
    { getAll: () => list, get: (id) => list.find(s => s.id === id) },
    SCHEMA,
  );
  // Open the create form — the decision-point rows only exist inside it.
  const newBtn = [...document.querySelectorAll('button')].find(b => /New|Add|\+/.test(b.textContent));
  newBtn?.click();
  return panel;
}

const q  = (sel) => document.querySelector(sel);
const qa = (sel) => [...document.querySelectorAll(sel)];
const button = (text) => qa('button').find(b => b.textContent.includes(text));

// ─── DGR-1 / DGR-2 ───────────────────────────────────────────────────────────

test('DGR-1: picking `mpcActiveRun` fills the options from the base scenario’s bag', () => {
  mountPanel();
  button('+ Add Decision Point').click();

  const paramSel = q('.dg-param-select');
  paramSel.value = 'mpcActiveRun';
  paramSel.dispatchEvent(new Event('change'));

  // The base plan first, then one option per recorded run, each labelled from its `source` —
  // a raw run id is not a choice anyone can make.
  const labels = qa('.dg-dp-options-section input[type="text"], .dg-dp-options-section input')
    .map(i => i.value);
  assert.ok(labels.some(l => /base plan/.test(l)), `expected a base-plan option: ${labels}`);
  assert.ok(labels.some(l => /run:a — 1 lever · CEM\/128/.test(l)), `expected a labelled run: ${labels}`);
  assert.ok(labels.some(l => /run:b — 2 levers/.test(l)), `expected the second run: ${labels}`);
});

test('DGR-2: the options follow the BASE SCENARIO select rather than being captured early', () => {
  // The base-scenario select sits above the decision points and is chosen first, so options
  // captured at construction would be the previous scenario's runs — offered under this
  // one's name, which is the worst of both.
  mountPanel();
  const baseSel = q('.dg-select');
  baseSel.value = 'no-runs';

  button('+ Add Decision Point').click();
  const paramSel = q('.dg-param-select');
  paramSel.value = 'mpcActiveRun';
  paramSel.dispatchEvent(new Event('change'));

  const labels = qa('.dg-dp-options-section input').map(i => i.value);
  assert.equal(labels.some(l => /run:a/.test(l)), false,
    `the other scenario’s runs must not be offered here: ${labels}`);
});

// ─── DGR-3 / DGR-4 ───────────────────────────────────────────────────────────

test('DGR-3: "+ Compare recorded runs" builds the whole decision point in one click', () => {
  // §4.2's claim, as an affordance: the comparison IS a decision point over one scalar param,
  // so there is nothing to build but the options.
  mountPanel();
  assert.equal(qa('.dg-dp-item').length, 0);

  button('+ Compare recorded runs').click();

  assert.equal(qa('.dg-dp-item').length, 1);
  assert.equal(q('.dg-param-select').value, 'mpcActiveRun');
  const labels = qa('.dg-dp-options-section input').map(i => i.value);
  assert.ok(labels.some(l => /base plan/.test(l)), 'the control comes with it');
  assert.ok(labels.some(l => /run:a/.test(l)) && labels.some(l => /run:b/.test(l)));
});

test('DGR-4: a scenario with no runs says so, instead of adding an empty decision point', () => {
  // An empty decision point reads as a broken editor; adding nothing silently reads as a
  // broken button. "This plan has nothing to compare" is a true and useful state.
  mountPanel();
  const baseSel = q('.dg-select');
  baseSel.value = 'no-runs';

  button('+ Compare recorded runs').click();

  assert.equal(qa('.dg-dp-item').length, 0);
  assert.match(document.body.textContent, /no recorded MPC runs/i);
});
