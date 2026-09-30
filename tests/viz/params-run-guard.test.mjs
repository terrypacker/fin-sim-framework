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
 * params-run-guard.test.mjs — design 81 D11 at EDIT time.
 *
 * A recorded MPC run whose lever an edit then disables refuses to compile. Found only at the
 * next Rebuild, that lands on the load-error page — a copied pools scenario with pools switched
 * off did exactly this. The Parameters panel now says so when the edit is made, from the same
 * `collectRunPlayability` verdict the compiler throws on, and offers `mpcRunEnabled: false`.
 */

import assert from 'node:assert/strict';
import { ScenarioTabView } from '../../src/visualization/scenario/scenario-tab-view.js';

function setupDOM() {
  document.body.innerHTML = `
    <select  id="scenarioSelect"></select>
    <input   id="scenarioName" />
    <input   id="simStartInput" />
    <input   id="simEndInput" />
    <div     id="paramsRunGuard" hidden></div>
    <div     id="paramsList"></div>
    <button  id="addParamBtn"></button>
  `;
}
beforeEach(setupDOM);

/** A run that decided a 2030 Roth conversion, on a base with conversions `enabled`. */
const scenarioOf = ({ enabled = true, runOn = true } = {}) => ({ params: [
  { name: 'rothConversionEnabled', label: 'Roth Conversions', type: 'Boolean', value: enabled },
  { name: 'mpcRuns', label: 'MPC Runs', type: 'Json', hidden: true, value: { 'run:r': {
    source: { recordedAt: '2026-09-20', levers: ['ROTH'], epochs: 1 },
    decisions: [{ date: '2030-01-01T00:00:00.000Z', lever: 'ROTH', key: '2030', value: 50000 }],
  } } },
  { name: 'mpcActiveRun',  label: 'Active MPC Run',  type: 'String',  hidden: true, value: 'run:r' },
  { name: 'mpcRunEnabled', label: 'MPC Run Enabled', type: 'Boolean', hidden: true, value: runOn },
] });

const guard = () => document.getElementById('paramsRunGuard');
const tick  = () => new Promise(r => setTimeout(r, 0));

function render(scenario) {
  const view = new ScenarioTabView();
  view._renderParamsList(scenario);
  return view;
}

test('a playable run shows no warning', () => {
  render(scenarioOf());
  assert.equal(guard().hidden, true);
});

test('an unplayable run names the run, the lever and how to satisfy it', () => {
  render(scenarioOf({ enabled: false }));
  assert.equal(guard().hidden, false);
  assert.match(guard().textContent, /run:r/);
  assert.match(guard().textContent, /ROTH — Enable Roth conversions/);
});

test('the edit that disables the mechanic raises the warning at once — no Rebuild', async () => {
  render(scenarioOf());
  const select = document.querySelector('#paramsList .param-row[data-param-name="rothConversionEnabled"] select');
  select.value = 'false';
  select.dispatchEvent(new Event('change', { bubbles: true }));
  await tick();
  assert.equal(guard().hidden, false);
});

test('Turn off the recorded run sets mpcRunEnabled false, keeps the selection, clears the warning', () => {
  const scenario = scenarioOf({ enabled: false });
  render(scenario);
  guard().querySelector('[data-id="run-guard-off"]').click();

  const val = (n) => scenario.params.find(p => p.name === n)?.value;
  assert.equal(val('mpcRunEnabled'), false);
  assert.equal(val('mpcActiveRun'), 'run:r');
  assert.equal(guard().hidden, true);
});

test('a run already switched off is not warned about', () => {
  render(scenarioOf({ enabled: false, runOn: false }));
  assert.equal(guard().hidden, true);
});
