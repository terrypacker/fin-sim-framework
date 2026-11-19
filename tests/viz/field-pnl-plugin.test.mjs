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
 * field-pnl-plugin.test.mjs — design 134 phase 1, the Field P&L panel.
 *
 * The report's arithmetic is pinned in tests/unit/evt-farm-job-costing.test.mjs. Pinned here:
 * the panel shows THAT report (its footer is the report's whole-farm row), each field's lines
 * sum to its columns, the machinery switch moves the net and nothing else, the empty states
 * say why, and the CSV carries every line.
 */

import assert from 'node:assert/strict';
import { FieldPnlPlugin, fieldPnlGroups, fieldPnlLines, fieldPnlCsv, FIELD_PNL_CSV_COLUMNS }
  from '../../src/visualization/workbench/plugins/finance/field-pnl-plugin.js';
import { FarmScenario } from '../../src/scenarios/farm-scenario.js';
import { runFarm } from '../../src/finance/farm/farm-run.js';
import { compileFarmEvents } from '../../src/finance/farm/farm-postings.js';
import { FINANCE_PLUGINS, FINANCE_VIEW_TEMPLATES }
  from '../../src/visualization/workbench/plugins/finance/finance-plugin-package.js';

const RUNTIME = { bus: { subscribe: () => () => {} } };

let RUN;
beforeAll(() => {
  const { log } = console; console.log = () => {};
  try { RUN = runFarm(FarmScenario.buildDefaultConfig()); } finally { console.log = log; }
});

function mount({ cfg = RUN.cfg, sim = RUN.sim } = {}) {
  const plugin = new FieldPnlPlugin(RUNTIME);
  plugin.setServices({ schemaRegistry: { formatAmount: (n) => `$${Math.round(n)}` } });
  plugin.setConfig(cfg);
  plugin._sim = sim;
  const container = document.createElement('div');
  document.body.appendChild(container);
  plugin.mount(container);
  return plugin;
}

const q = (p, name) => p.el.querySelector(`[data-fpl="${name}"]`);
const cells = (tr) => [...tr.querySelectorAll('td')].map(td => td.textContent.trim());
const click = (el) => el.dispatchEvent(new Event('click', { bubbles: true }));
const close = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-6, `${msg}: ${a} vs ${b}`);

test('registered as a panel and opened by the Farm view', () => {
  assert.ok(FINANCE_PLUGINS.some(p => p.id === 'field-pnl' && p.component === FieldPnlPlugin));
  assert.deepEqual(FINANCE_VIEW_TEMPLATES.Farm.center.tabs, ['field-pnl', 'farm-mc', 'timeline']);
  assert.ok(FINANCE_VIEW_TEMPLATES.Everything.center.tabs.includes('field-pnl'));
});

test('the empty states say why: no farm records, no run, nothing posted yet', () => {
  const noFarm = mount({ cfg: { persons: [] } });
  assert.match(q(noFarm, 'placeholder').textContent, /no farm records/);
  assert.equal(q(noFarm, 'grid').style.display, 'none');
  noFarm.unmount();

  const noSim = mount({ sim: null });
  assert.match(q(noSim, 'placeholder').textContent, /Run a simulation/);
  noSim.unmount();

  const unstepped = mount({ sim: { journal: { journal: [] }, state: {}, currentDate: new Date(RUN.cfg.simStart), bus: null } });
  assert.match(q(unstepped, 'placeholder').textContent, /Nothing posted yet/);
  unstepped.unmount();
});

test('operator ▸ field ▸ lines; the footer is the report\'s whole-farm row', () => {
  const p = mount();
  const groups = [...q(p, 'rows').querySelectorAll('tr.fpl-group-row')];
  assert.equal(groups.length, RUN.jobCost.byOperator.length);
  assert.equal(q(p, 'rows').querySelectorAll('tr.fpl-plan-row').length, 0, 'closed until clicked');

  const foot = cells(q(p, 'foot').querySelector('tr'));
  assert.equal(foot[5], `$${Math.round(RUN.jobCost.farm.net)}`, 'net');
  assert.equal(foot[4], `$${Math.round(RUN.jobCost.farm.totalCost)}`, 'cost');
  assert.equal(foot[3], `$${Math.round(RUN.jobCost.farm.revenue.total)}`, 'revenue');
  assert.match(q(p, 'asof').textContent, /season complete/);

  click(groups[0]);
  const plans = [...q(p, 'rows').querySelectorAll('tr.fpl-plan-row')];
  assert.ok(plans.length > 0);
  click(plans[0]);
  assert.ok(q(p, 'rows').querySelectorAll('tr.fpl-line-row').length > 0);
  p.unmount();
});

test('each field\'s lines sum to its revenue, direct, overhead and machinery columns', () => {
  for (const basis of ['CUSTOM', 'ACTUAL']) {
    const r = basis === 'CUSTOM' ? RUN.jobCost : runFarmQuiet({ machineryBasis: 'ACTUAL' }).jobCost;
    for (const p of r.plans) {
      const lines = fieldPnlLines(p, basis);
      const sum = (k) => lines.filter(l => l.kind === k).reduce((s, l) => s + l.amount, 0);
      close(sum('revenue'), p.revenue.total, `${p.jobId} revenue`);
      close(sum('direct'), p.directCost, `${p.jobId} direct`);
      close(sum('overhead'), p.overheadCost, `${p.jobId} overhead`);
      close(sum('machinery'), p.machineryCost, `${p.jobId} machinery (${basis})`);
    }
  }
});

test('the machinery switch moves machinery and the net, not revenue or direct cost', () => {
  const p = mount();
  const before = cells(q(p, 'foot').querySelector('tr'));
  click(q(p, 'basis').querySelector('button[data-v="ACTUAL"]'));
  const after = cells(q(p, 'foot').querySelector('tr'));
  const actual = runFarmQuiet({ machineryBasis: 'ACTUAL' }).jobCost.farm;
  assert.equal(after[14], `$${Math.round(actual.machineryCost)}`);
  assert.equal(after[5], `$${Math.round(actual.net)}`);
  assert.deepEqual([after[3], after[12], after[13]], [before[3], before[12], before[13]], 'revenue, direct, overhead');
  assert.match(q(p, 'mach-head').textContent, /actual/);
  p.unmount();
});

test('by crop groups every field under its crop', () => {
  const groups = fieldPnlGroups(RUN.jobCost, 'crop');
  assert.deepEqual(groups.map(g => g.key).sort(), RUN.jobCost.byCrop.map(r => r.crop).sort());
  assert.equal(groups.flatMap(g => g.plans).length, RUN.jobCost.plans.length);
  for (const g of groups) assert.ok(g.plans.every(x => x.crop === g.key));
});

test('the season is complete at its last farm event, not at simEnd', () => {
  // The sim's clock stops at its last event, which is a farm one, short of simEnd: a
  // finished run read "to date" in the browser until this was keyed to the events.
  // (Headless stepTo parks the clock ON simEnd; the workbench's player does not.)
  const last = compileFarmEvents(RUN.farm).map(e => e.date).sort().at(-1);
  const p = mount({ sim: { ...RUN.sim, currentDate: new Date(`${last}T00:00:00Z`) } });
  assert.match(q(p, 'asof').textContent, /season complete/);
  assert.equal(q(p, 'warn').style.display, 'none');
  p.unmount();
});

test('a run stopped mid-season is labelled as the season to date', () => {
  const sim = { ...RUN.sim, currentDate: new Date(`${RUN.farm.season.cropYear}-06-01T00:00:00Z`) };
  const p = mount({ sim });
  assert.match(q(p, 'asof').textContent, /to date/);
  assert.match(q(p, 'warn').textContent, /has not finished/);
  p.unmount();
});

test('the CSV has a row per operator, field and line, and a FARM total', () => {
  const csv = fieldPnlCsv(RUN.jobCost, RUN.farm).split('\n');
  assert.equal(csv[0], FIELD_PNL_CSV_COLUMNS.join(','));
  const scope = csv.slice(1).map(l => l.split(',')[0]);
  assert.equal(scope.filter(s => s === 'FIELD').length, RUN.jobCost.plans.length);
  assert.equal(scope.filter(s => s === 'OPERATOR').length, RUN.jobCost.byOperator.length);
  assert.equal(scope.at(-1), 'FARM');
  const n = RUN.jobCost.plans.reduce((s, p) => s + fieldPnlLines(p).length, 0);
  assert.equal(scope.filter(s => s.startsWith('LINE_')).length, n);
});

function runFarmQuiet(opts) {
  const { log } = console; console.log = () => {};
  try { return runFarm(FarmScenario.buildDefaultConfig(), opts); } finally { console.log = log; }
}

test('the cost split columns are hidden until asked for, on every row kind alike', () => {
  const p = mount();
  click(p.el.querySelector('tr.fpl-group-row'));
  click(p.el.querySelector('tr.fpl-plan-row'));
  const grid = q(p, 'grid');
  assert.ok(grid.classList.contains('fpl-split-off'));
  for (const tr of grid.querySelectorAll('tr')) {
    const n = [...tr.children].reduce((s, c) => s + (c.colSpan || 1), 0);
    assert.equal(n, 15, `every row spans the 15 columns (${tr.className})`);
    assert.equal(tr.querySelectorAll('.fpl-split').length, 3, `three split cells (${tr.className})`);
  }
  const box = q(p, 'split');
  box.checked = true;
  box.dispatchEvent(new Event('change'));
  assert.ok(!grid.classList.contains('fpl-split-off'));
  p.unmount();
});
