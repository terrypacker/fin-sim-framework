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
 * sweep-row-help.test.mjs
 * The `?` and the hover on a Monte Carlo / Optimize variable row.
 *
 * The routing itself — every row lands on help that exists — is gated in
 * `tests/unit/sweep-row-help.test.mjs`. What this pins is the seam: the description
 * reaching the row the user is looking at, and the `?` opening the right page, through
 * the shared SweepVariableTable so both panels get it from one place.
 *
 * Run with: npm run test:viz
 */

import assert from 'node:assert/strict';

import { McConfigPanel }                  from '../../src/visualization/monte-carlo/mc-config-panel.js';
import { OptConfigPanel }                 from '../../src/visualization/optimization/opt-config-panel.js';
import { loadHelpIndex, _resetHelpIndex } from '../../src/visualization/help/help-index-source.js';
import { DISTRIBUTION_TYPES }             from '../../src/simulation-framework/distributions.js';
import { OPT_PARAM_TYPES }                from '../../src/finance/optimization/optimization-objectives.js';
import { buildHelpIndex }                 from '../../scripts/lib/help-index.mjs';
// For its side effect: jest's ESM linker refuses the generator's dynamic toolset imports
// unless this graph is linked statically first (see node-field-help.test.mjs).
import '../../src/visualization/workbench/plugins/finance/finance-plugin-package.js';

const N = DISTRIBUTION_TYPES.NORMAL;
// Keys NOT enabled by default, so the constructor's default rows cannot carry state over.
const MC_VARS = [
  { paramKey: 'fxVolatility', label: 'FX Volatility',   group: 'FX',       type: N, mean: 0.1, stdDev: 0.02, enabled: false },
  { paramKey: 'rothBalance',  label: 'Roth IRA Balance', group: 'Balances', type: N, mean: 1e5, stdDev: 1e4,  enabled: false },
  { paramKey: 'noSuchLever',  label: 'Mystery',          group: 'Other',    type: N, mean: 1,   stdDev: 0.1,  enabled: false },
];

let INDEX;
beforeAll(async () => { INDEX = await buildHelpIndex(); }, 120_000);

beforeEach(() => {
  _resetHelpIndex();
  loadHelpIndex(INDEX);                  // jsdom has no fetch; seed the shared cache
});

const settle = () => new Promise(r => setTimeout(r, 0));

function mountMc(opts) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const panel = new McConfigPanel(container, opts);
  panel.setVariables(MC_VARS);
  return { container, panel };
}

/** The label and the `?` beside it, for one row by its label text. */
function rowParts(container, labelSel, text) {
  const labelEl = [...container.querySelectorAll(labelSel)].find(l => l.textContent === text);
  return { labelEl, btn: labelEl?.parentElement.querySelector('.param-help-btn') ?? null };
}

test('SRH-V1: an MC row gets the full description as hover and a `?` that opens it', async () => {
  const opened = [];
  const { container, panel } = mountMc({ onOpenHelp: ref => opened.push(ref) });
  await settle();

  const { labelEl, btn } = rowParts(container, '.mc-var-label', 'FX Volatility');
  const param = INDEX.params.find(p => p.key === 'fxVolatility');
  assert.equal(labelEl.title, param.description);
  assert.ok(btn, 'the row has a `?`');
  assert.equal(btn.previousElementSibling, labelEl, 'beside the label, not inside where it would be clipped');

  const cb = labelEl.parentElement.querySelector('input[type="checkbox"]');
  btn.click();
  assert.deepEqual(opened, [{ param: 'fxVolatility' }]);
  assert.equal(cb.checked, false, 'asking for help does not toggle the lever');
  panel.destroy();
});

test('SRH-V2: a legacy row opens its successor\'s form field; an unknown one gets no `?`', async () => {
  const opened = [];
  const { container, panel } = mountMc({ onOpenHelp: ref => opened.push(ref) });
  await settle();

  rowParts(container, '.mc-var-label', 'Roth IRA Balance').btn.click();
  assert.deepEqual(opened, [{ node: 'account', field: 'balance' }]);

  const mystery = rowParts(container, '.mc-var-label', 'Mystery');
  assert.equal(mystery.btn, null, 'a `?` that opened "No parameter" would be worse than none');
  assert.equal(mystery.labelEl.title, 'Mystery', 'and it keeps the hover it was built with');
  panel.destroy();
});

test('SRH-V3: clearing the diverged flag restores the description, not the bare label', async () => {
  const { panel } = mountMc({ onOpenHelp: () => {} });
  await settle();
  const row  = panel._rowMap.get('fxVolatility');
  const desc = INDEX.params.find(p => p.key === 'fxVolatility').description;

  panel._markDiverged(row, 0.2);
  assert.notEqual(row.labelEl.title, desc);
  panel._markDiverged(row, null);
  assert.equal(row.labelEl.title, desc);
  panel.destroy();
});

test('SRH-V4: the Optimize panel gets the same, through the same table', async () => {
  const opened = [];
  const container = document.createElement('div');
  document.body.appendChild(container);
  const panel = new OptConfigPanel(container, { onOpenHelp: ref => opened.push(ref) });
  panel.setVariables([
    { paramKey: 'prop.usHouseProperty.plannedSaleDate', label: 'US House — Planned Sale Date',
      group: 'US · US House', type: OPT_PARAM_TYPES.DATE, min: '2030-01-15', max: '2040-01-15', step: 1,
      enabled: false },
  ]);
  await settle();

  const { labelEl, btn } = rowParts(container, '.opt-var-label', 'US House — Planned Sale Date');
  const field = INDEX.nodes.find(n => n.kind === 'real-property').fields
    .find(f => f.field === 'plannedSaleDate');
  assert.equal(labelEl.title, field.description);
  btn.click();
  assert.deepEqual(opened, [{ node: 'real-property', field: 'plannedSaleDate' }]);
  panel.destroy();
});

test('SRH-V5: with no index the rows are left as built — no `?`, no throw', async () => {
  _resetHelpIndex();                     // and jsdom has no fetch, so it stays absent
  const { container, panel } = mountMc({ onOpenHelp: () => {} });
  await settle();
  assert.equal(container.querySelectorAll('.param-help-btn').length, 0);
  assert.equal(rowParts(container, '.mc-var-label', 'FX Volatility').labelEl.title, 'FX Volatility');
  panel.destroy();
});

test('SRH-V6: without an onOpenHelp there is still the hover, but no `?`', async () => {
  const { container, panel } = mountMc();
  await settle();
  assert.equal(container.querySelectorAll('.param-help-btn').length, 0);
  assert.equal(rowParts(container, '.mc-var-label', 'FX Volatility').labelEl.title,
    INDEX.params.find(p => p.key === 'fxVolatility').description);
  panel.destroy();
});
