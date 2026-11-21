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
import v8 from 'node:v8';
import * as echarts from 'echarts';
import { FieldPnlPlugin, fieldPnlGroups, fieldPnlLines, fieldPnlCsv, FIELD_PNL_CSV_COLUMNS,
  breakevenChartData, breakevenChartSet, breakevenCaption, breakevenChartOption,
  grainChartData, grainChartSet, grainCaption, grainChartOption, GRAIN_BANDS,
  grainValueData, grainValueSet, grainValueCaption, grainValueOption, GRAIN_VALUE_BANDS }
  from '../../src/visualization/workbench/plugins/finance/field-pnl-plugin.js';
import { sumPlanRows } from '../../src/finance/farm/farm-reports.js';
import { FarmScenario } from '../../src/scenarios/farm-scenario.js';
import { runFarm, planFarm } from '../../src/finance/farm/farm-run.js';
import { farmGrainMoves, farmGrainSales } from '../../src/finance/farm/farm-reports.js';
import { priceOn } from '../../src/finance/farm/farm-records.js';
import { compileFarmEvents } from '../../src/finance/farm/farm-postings.js';
import { FINANCE_PLUGINS, FINANCE_VIEW_TEMPLATES }
  from '../../src/visualization/workbench/plugins/finance/finance-plugin-package.js';

const RUNTIME = { bus: { subscribe: () => () => {} } };

let RUN;
beforeAll(() => {
  // jsdom has no structuredClone, which the chart's planned-season run uses. v8's serializer
  // is the same algorithm (it keeps Dates, unlike a JSON round trip).
  if (typeof global.structuredClone !== 'function') {
    global.structuredClone = (obj) => v8.deserialize(v8.serialize(obj));
  }
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
const COLORS = { price: '#000000', red: '#ff0000', green: '#00ff00', amber: '#ffaa00', dim: '#999999',
  border: '#333333', borderHi: '#444444', text: '#eeeeee', muted: '#666666', panel: '#111111' };
const quiet = (f) => { const { log } = console; console.log = () => {}; try { return f(); } finally { console.log = log; } };
const close = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-6, `${msg}: ${a} vs ${b}`);

test('registered as a panel and opened by the Farm view', () => {
  assert.ok(FINANCE_PLUGINS.some(p => p.id === 'field-pnl' && p.component === FieldPnlPlugin));
  assert.deepEqual(FINANCE_VIEW_TEMPLATES.Farm.center.tabs, ['field-pnl', 'farm-mc', 'farm-mc-results', 'timeline']);
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
  assert.equal(foot[6], `$${Math.round(RUN.jobCost.farm.net)}`, 'net');
  assert.equal(foot[5], `$${Math.round(RUN.jobCost.farm.totalCost)}`, 'cost');
  assert.equal(foot[4], `$${Math.round(RUN.jobCost.farm.revenue.total)}`, 'revenue');
  assert.equal(foot[3], '—', 'the farm grows two crops: no bushel total');
  assert.match(q(p, 'asof').textContent, /season complete/);

  click(groups[0]);
  const plans = [...q(p, 'rows').querySelectorAll('tr.fpl-plan-row')];
  assert.ok(plans.length > 0);
  click(plans[0]);
  assert.ok(q(p, 'rows').querySelectorAll('tr.fpl-line-row').length > 0);
  p.unmount();
});

test('Bushels: each field\'s harvest, a one-crop group\'s sum, none for a mixed group; in the CSV too', () => {
  const p = mount();
  // A click re-renders the rows, so each group is looked up afresh.
  for (const g of fieldPnlGroups(RUN.jobCost, 'operator')) click(q(p, 'rows').querySelector(`tr[data-key="g:${g.key}"]`));
  const rows = [...q(p, 'rows').querySelectorAll('tr.fpl-plan-row')];
  assert.equal(rows.length, RUN.jobCost.plans.length);
  const fmt = (n) => n.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 });
  for (const tr of rows) {
    const plan = RUN.jobCost.plans.find(x => x.jobId === tr.dataset.key.slice(2));
    assert.equal(cells(tr)[3], fmt(plan.harvestedBushels), plan.jobId);
  }
  for (const g of fieldPnlGroups(RUN.jobCost, 'operator')) {
    const tr = q(p, 'rows').querySelector(`tr[data-key="g:${g.key}"]`);
    const crops = new Set(g.plans.map(x => x.crop));
    assert.equal(cells(tr)[3], crops.size === 1 ? fmt(g.plans.reduce((s, x) => s + x.harvestedBushels, 0)) : '—', g.key);
  }
  p.unmount();
  const csv = fieldPnlCsv(RUN.jobCost, RUN.farm).split('\n');
  const col = FIELD_PNL_CSV_COLUMNS.indexOf('bushels');
  const plan = RUN.jobCost.plans[0];
  const line = csv.find(l => l.startsWith(`FIELD,`) && l.split(',')[2] === plan.jobId).split(',');
  close(Number(line[col]), plan.harvestedBushels, 'CSV bushels');
  assert.ok(csv.slice(1).every(l => l.split(',').length === FIELD_PNL_CSV_COLUMNS.length), 'every CSV row is as wide as the header');
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
  assert.equal(after[15], `$${Math.round(actual.machineryCost)}`);
  assert.equal(after[6], `$${Math.round(actual.net)}`);
  assert.deepEqual([after[3], after[4], after[13], after[14]], [before[3], before[4], before[13], before[14]], 'bushels, revenue, direct, overhead');
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
    assert.equal(n, 16, `every row spans the 16 columns (${tr.className})`);
    assert.equal(tr.querySelectorAll('.fpl-split').length, 3, `three split cells (${tr.className})`);
  }
  const box = q(p, 'split');
  box.checked = true;
  box.dispatchEvent(new Event('change'));
  assert.ok(!grid.classList.contains('fpl-split-off'));
  p.unmount();
});

test('programs show as their own lines: ARC on line 4a, an indemnity on line 6a (design 134 §15.4)', () => {
  // The demo farm's ARC pays in a planned season; a drought adds insurance.
  const cfg = FarmScenario.buildDefaultConfig();
  cfg.farm.seasons[0].yieldShock = -0.5;
  cfg.farm.seasons[0].irrigatedYieldShock = -0.3;
  const run = runFarm(cfg);
  const lines = run.jobCost.plans.flatMap(p => fieldPnlLines(p));
  const arc = lines.filter(l => l.category === 'PROGRAM_PAYMENT');
  const ins = lines.filter(l => l.category === 'CROP_INSURANCE_PROCEEDS');
  assert.ok(arc.length > 0 && arc.every(l => l.line === '4a' && l.kind === 'revenue'));
  assert.ok(ins.length > 0 && ins.every(l => l.line === '6a' && l.kind === 'revenue'));
  assert.ok(!lines.some(l => l.category === 'OTHER'), 'nothing left in a lump');
  for (const p of run.jobCost.plans) {
    const rev = fieldPnlLines(p).filter(l => l.kind === 'revenue').reduce((s, l) => s + l.amount, 0);
    assert.ok(Math.abs(rev - p.revenue.total) < 1e-6, `${p.jobId} revenue lines sum to revenue`);
  }
});

// ─── The breakeven chart ─────────────────────────────────────────────────────────

test('chart data: the farm\'s corn breakeven is the report\'s corn row; a field is its own row', () => {
  const { farm, jobCost } = RUN;
  const corn = jobCost.byCrop.find(r => r.crop === 'CORN');
  const d = breakevenChartData(farm, jobCost, { kind: 'farm' }, 'CORN', `${farm.season.cropYear}-06-01`);
  close(d.breakevenUnpricedPrice, corn.breakevenUnpricedPrice, 'farm corn BE');
  assert.deepEqual([...d.crops].sort(), ['CORN', 'SOYBEANS']);
  assert.ok(d.nowInWindow && d.priceNow > 0);
  // Every contract drawn is this season's (last year's carry-in contracts are not).
  assert.ok(d.contracts.length > 0);
  assert.ok(farm.contracts.some(c => c.cropYear !== farm.season.cropYear), 'the demo farm has a carry-in contract');
  assert.equal(d.contracts.length, farm.contracts.filter(c => c.crop === 'CORN' && c.cropYear === farm.season.cropYear).length);

  const plan = jobCost.plans.find(r => r.planId && r.crop === 'SOYBEANS');
  const f = breakevenChartData(farm, jobCost, { kind: 'plan', id: plan.jobId }, null, null);
  assert.equal(f.crop, 'SOYBEANS');
  assert.deepEqual(f.crops, ['SOYBEANS']);
  close(f.breakevenUnpricedPrice, plan.breakevenUnpricedPrice, 'field BE');
  assert.equal(f.priceNow, null);
});

test('chart data: an operator growing two crops gets ONE crop\'s breakeven (its row would be null)', () => {
  const { farm, jobCost } = RUN;
  const op = jobCost.byOperator.find(r => new Set(jobCost.plans.filter(p => p.planId && p.operatorId === r.operatorId).map(p => p.crop)).size > 1);
  assert.ok(op, 'the demo farm has a two-crop operator');
  assert.equal(op.breakevenUnpricedPrice, null);
  const d = breakevenChartData(farm, jobCost, { kind: 'operator', id: op.operatorId }, 'CORN', null);
  const want = sumPlanRows(jobCost.plans.filter(p => p.planId && p.operatorId === op.operatorId && p.crop === 'CORN'));
  close(d.breakevenUnpricedPrice, want.breakevenUnpricedPrice, 'operator corn BE');
});

test('the caption says how far today\'s price is from the breakeven; the option marks BE and now', () => {
  const { farm, jobCost } = RUN;
  const d = breakevenChartData(farm, jobCost, { kind: 'farm' }, 'CORN', `${farm.season.cropYear}-06-01`);
  const text = breakevenCaption(d);
  assert.match(text, new RegExp(`\\$${d.breakevenUnpricedPrice.toFixed(2)}/bu to break even`));
  assert.match(text, /above it|below it/);
  const colors = { price: '#000000', red: '#ff0000', green: '#00ff00', amber: '#ffaa00',
    dim: '#999999', border: '#333333', borderHi: '#444444', text: '#eeeeee', muted: '#666666', panel: '#111111' };
  const opt = breakevenChartOption(d, { colors });
  const marks = opt.series[0].markLine.data.map(m => m.name);
  const nowPoint = opt.series.find(x => x.id === 'now');
  assert.deepEqual(nowPoint.data[0], [Date.parse(`${d.now}T00:00:00Z`), d.priceNow], 'today\'s price is a labelled point');
  assert.equal(breakevenChartOption({ ...d, nowInWindow: false }, { colors }).series.some(x => x.id === 'now'), false);
  assert.ok(marks.includes('breakeven') && marks.includes('now'));
  assert.equal(opt.series[0].markArea.data[0][1].yAxis, d.breakevenUnpricedPrice);
  assert.equal(opt.visualMap, undefined, 'a visualMap breaks rendering when the line is on one side');
});

test('the panel\'s breakeven is the PLANNED season\'s: mid-run it matches the finished run, not the table', () => {
  const sim = { ...RUN.sim, currentDate: new Date(`${RUN.farm.season.cropYear}-06-01T00:00:00Z`) };
  const p = quiet(() => mount({ sim }));
  assert.equal(q(p, 'chart-wrap').style.display, '');
  // The whole farm grows two crops: one chart each, each captioned with ITS breakeven.
  const charts = () => [...q(p, 'charts').querySelectorAll('.fpl-crop-chart')].map(el => el.dataset.crop);
  assert.deepEqual([...charts()].sort(), ['CORN', 'SOYBEANS']);
  for (const crop of ['CORN', 'SOYBEANS']) {
    const row = RUN.jobCost.byCrop.find(r => r.crop === crop);
    const caption = q(p, 'charts').querySelector(`[data-fpl-caption="${crop}"]`).textContent;
    assert.ok(caption.includes(`$${row.breakevenUnpricedPrice.toFixed(2)}/bu`), `${crop}: ${caption}`);
  }
  // A field row's click points the chart at that field: one crop, one chart.
  click(q(p, 'rows').querySelector('tr[data-key^="g:"]'));
  const fieldRow = q(p, 'rows').querySelector('tr[data-key^="p:"]');
  click(fieldRow);
  const plan = RUN.jobCost.plans.find(r => `p:${r.jobId}` === fieldRow.dataset.key);
  assert.ok(q(p, 'chart-label').textContent.includes(plan.fieldName));
  assert.deepEqual(charts(), [plan.crop]);
  click(q(p, 'foot').querySelector('tr'));
  assert.match(q(p, 'chart-label').textContent, /Whole farm/);
  assert.equal(charts().length, 2);
  p.unmount();
});

test('the chart option RENDERS, with the price wholly above the breakeven and wholly below it', () => {
  // jsdom never draws a canvas, so the panel skips ECharts there. ECharts' SVG renderer runs
  // headless: a visualMap colouring the line by the breakeven threw inside render when every
  // price sat on one side of it, and then drew no series at all.
  const { farm, jobCost } = RUN;
  const d = breakevenChartData(farm, jobCost, { kind: 'farm' }, 'CORN', `${farm.season.cropYear}-06-01`);
  const colors = { price: '#0000ff', red: '#ff0000', green: '#00ff00', amber: '#ffaa00', dim: '#999999',
    border: '#333333', borderHi: '#444444', text: '#eeeeee', muted: '#666666', panel: '#111111' };
  for (const be of [d.breakevenUnpricedPrice, 99]) {
    const chart = echarts.init(null, null, { renderer: 'svg', ssr: true, width: 800, height: 240 });
    try {
      chart.setOption(breakevenChartOption({ ...d, breakevenUnpricedPrice: be }, { colors }));
      const svg = chart.renderToSVGString();
      assert.ok(svg.includes('#0000ff'), 'the price line is drawn');
      assert.ok(svg.includes('#00ff00'), 'the contracts are drawn');
    } finally { chart.dispose(); }
  }
});

test('the chart set: one entry per crop, all on one date range, each with its own breakeven', () => {
  const { farm, jobCost } = RUN;
  const now = `${farm.season.cropYear}-06-01`;
  const set = breakevenChartSet(farm, jobCost, { kind: 'farm' }, now);
  assert.deepEqual(set.map(d => d.crop).sort(), ['CORN', 'SOYBEANS']);
  assert.equal(new Set(set.map(d => `${d.start}|${d.end}`)).size, 1, 'one shared date range');
  for (const d of set) {
    close(d.breakevenUnpricedPrice, jobCost.byCrop.find(r => r.crop === d.crop).breakevenUnpricedPrice, d.crop);
    assert.equal(d.prices.at(-1)[0], d.end, 'each price line runs to the shared end');
    assert.ok(d.nowInWindow);
  }
  assert.notEqual(set[0].breakevenUnpricedPrice, set[1].breakevenUnpricedPrice);
  const plan = jobCost.plans.find(r => r.planId);
  assert.equal(breakevenChartSet(farm, jobCost, { kind: 'plan', id: plan.jobId }, now).length, 1);
  assert.match(breakevenCaption(set[0], { label: 'Corn' }), /^Corn: /);
});

// ─── Where the grain is (design 134 §17.10) ───────────────────────────────────────

describe('the grain chart', () => {
  const moves = () => farmGrainMoves(RUN.sim.journal.journal);
  const bin = (p) => p.binContracted + p.binUnpriced;

  test('every bushel in is in storage, delivered or sold, on every date', () => {
    const ms = moves();
    for (const crop of ['CORN', 'SOYBEANS']) {
      const d = grainChartData(RUN.farm, ms, RUN.ledger, { kind: 'farm' }, crop, null);
      for (const p of d.points) {
        const into = ms.filter(m => m.crop === crop && m.bushels > 0 && m.date <= p.date).reduce((s, m) => s + m.bushels, 0);
        close(bin(p) + p.delivered + p.sold, into, `${crop} ${p.date}`);
        assert.ok(p.binContracted <= bin(p) + 1e-9 && p.binUnpriced >= -1e-9);
      }
      close(d.harvested + d.carriedIn, ms.filter(m => m.crop === crop && m.bushels > 0).reduce((s, m) => s + m.bushels, 0), crop);
    }
  });

  test('storage that a later contract delivery takes is contracted; the carry-in shows from its date', () => {
    const d = grainChartData(RUN.farm, moves(), RUN.ledger, { kind: 'farm' }, 'CORN', null);
    const y = RUN.farm.season.cropYear;
    // opA carried 9,000 bu of 2026 corn in on 1 Jan; 6,000 of it is owed to k-a-old on 1 Mar.
    const jan = d.points.find(p => p.date === `${y}-01-01`);
    close(bin(jan), 9000, 'the carry-in is in storage');
    close(jan.binContracted, 6000, 'the old contract is spoken for');
    assert.ok(jan.moves.some(m => m.kind === 'CARRY_IN'));
    close(d.carriedIn, 9000, 'carried in');
    const storage = RUN.ledger.filter(r => r.category === 'STORAGE' && /CORN/.test(r.jobId)).reduce((s, r) => s + r.amount, 0);
    close(d.storageCost, storage, 'the pools\' storage cost');
    assert.ok(d.storedPeak > 0 && d.lastOut > d.harvestDay);
  });

  test('a field shows its operator\'s pool of its crop and says so; a crop scope only that crop', () => {
    const ms = moves();
    const plan = RUN.farm.cropPlans.find(p => p.id === 'p-b-river');
    const set = grainChartSet(RUN.farm, ms, RUN.ledger, { kind: 'plan', id: plan.id }, null);
    assert.deepEqual(set.map(d => d.crop), [plan.crop]);
    assert.equal(set[0].pooledFrom, 'opB');
    const opB = grainChartData(RUN.farm, ms, RUN.ledger, { kind: 'operator', id: 'opB' }, plan.crop, null);
    assert.deepEqual(set[0].points.map(bin), opB.points.map(bin));
    assert.match(grainCaption(set[0], { poolOf: 'Operator B' }), /Operator B's whole pool/);
    assert.deepEqual(grainChartSet(RUN.farm, ms, RUN.ledger, { kind: 'crop', id: 'SOYBEANS' }, null).map(d => d.crop), ['SOYBEANS']);
  });

  test('the set shares one date range, and the planned season carries the moves', () => {
    const set = grainChartSet(RUN.farm, moves(), RUN.ledger, { kind: 'farm' }, null);
    assert.equal(new Set(set.map(d => `${d.start}|${d.end}`)).size, 1);
    const planned = quiet(() => planFarm(RUN.cfg));
    assert.deepEqual(planned.grain, moves());
  });

  test('the option stacks the four bands and RENDERS', () => {
    const d = grainChartData(RUN.farm, moves(), RUN.ledger, { kind: 'farm' }, 'CORN', `${RUN.farm.season.cropYear}-11-01`);
    const opt = grainChartOption(d, { colors: COLORS, title: 'Corn' });
    assert.deepEqual(opt.series.map(s => s.id), GRAIN_BANDS.map(b => b.id));
    assert.ok(opt.series.every(s => s.stack === 'grain' && s.step === 'end'));
    assert.ok(opt.series[0].markLine.data.some(m => m.name === 'harvest') && opt.series[0].markLine.data.some(m => m.name === 'now'));
    const chart = echarts.init(null, null, { renderer: 'svg', ssr: true, width: 800, height: 240 });
    try { chart.setOption(opt); assert.ok(chart.renderToSVGString().includes('<path')); } finally { chart.dispose(); }
  });

  test('the tooltip gives the bands and that day\'s moves with their prices', () => {
    const d = grainChartData(RUN.farm, moves(), RUN.ledger, { kind: 'farm' }, 'CORN', null);
    const opt = grainChartOption(d, { colors: COLORS });
    const day = d.points.find(p => p.moves.some(m => m.kind === 'DELIVER'));
    const tip = opt.tooltip.formatter([{ value: [Date.parse(`${day.date}T00:00:00Z`), 0] }]);
    for (const b of GRAIN_BANDS) assert.ok(tip.includes(b.label), b.label);
    const k = RUN.farm.contracts.find(c => c.id === day.moves.find(m => m.kind === 'DELIVER').label
      || c.name === day.moves.find(m => m.kind === 'DELIVER').label);
    assert.ok(tip.includes(`$${k.price.toFixed(2)}`), 'the contract price');
    assert.match(tip, /moves that day/);
  });

  test('the panel draws the grain section with a caption per crop', () => {
    const p = mount();
    try {
      assert.equal(q(p, 'grain-wrap').style.display, '');
      const caps = [...p.el.querySelectorAll('[data-fpl-grain-caption]')].map(e => e.textContent);
      assert.equal(caps.length, 2);
      assert.ok(caps.every(c => /harvested/.test(c)));
    } finally { p.unmount(); }
  });
});

// ─── What the grain is worth (design 134 §17.11) ──────────────────────────────────

describe('the grain value chart', () => {
  const moves = () => farmGrainMoves(RUN.sim.journal.journal);
  const sales = () => farmGrainSales(RUN.sim.journal.journal);
  const value = (scope, crop, now = null) => grainValueData(RUN.farm, moves(), sales(), RUN.ledger, RUN.jobCost, scope, crop, now);
  const ts = (iso) => Date.parse(`${iso}T00:00:00Z`);

  test('every move out opens one receivable at the amount its payment books', () => {
    const ss = sales();
    const out = moves().filter(m => m.kind === 'DELIVER' || m.kind === 'SELL');
    assert.equal(ss.filter(x => x.bushels > 0).length, out.length);
    const paid = RUN.ledger.filter(r => r.category === 'GRAIN_SALES' && r.receivableId);
    assert.ok(paid.length > 0);
    for (const r of paid) close(r.amount, ss.find(x => x.receivableId === r.receivableId).amount, r.receivableId);
    const planned = quiet(() => planFarm(RUN.cfg));
    assert.deepEqual(planned.grainSales, ss);
  });

  test('at the end of the run this season\'s grain is worth the report\'s grain revenue', () => {
    for (const crop of ['CORN', 'SOYBEANS']) {
      const d = value({ kind: 'farm' }, crop);
      const rev = RUN.jobCost.plans.filter(p => p.crop === crop).reduce((s, p) => s + p.revenue.grain, 0);
      close(d.ending.season, rev, crop);
    }
  });

  test('contracted storage is valued at its contract, the rest at that day\'s cash price, in the grain chart\'s bushels', () => {
    const d = value({ kind: 'farm' }, 'CORN');
    const g = grainChartData(RUN.farm, moves(), RUN.ledger, { kind: 'farm' }, 'CORN', null);
    for (const gp of g.points.slice(1, -1)) {
      const vp = d.points.find(p => p.date === gp.date);
      close(vp.unpricedBu, gp.binUnpriced, `unpriced bushels ${gp.date}`);
      close(vp.binUnpriced, gp.binUnpriced * priceOn(RUN.farm.prices, 'CORN', gp.date, 'realized'), `cash value ${gp.date}`);
    }
    const y = RUN.farm.season.cropYear;
    // On 1 Jan the old contract k-a-old owes 6,000 of the 9,000 bu carried in.
    const jan = d.points.find(p => p.date === `${y}-01-01`);
    const k = RUN.farm.contracts.find(c => c.id === 'k-a-old');
    close(jan.binContracted, 6000 * k.price, 'the carry-in owed to k-a-old at its price');
    assert.ok(d.carriedIn > 0);
  });

  test('the unpriced band steps on a price date with no move', () => {
    const d = value({ kind: 'farm' }, 'CORN');
    const moved = new Set(moves().map(m => m.date));
    const step = d.points.find((p, i) => i > 0 && !moved.has(p.date) && p.unpricedBu > 0
      && p.price !== d.points[i - 1].price);
    assert.ok(step, 'a cash price change re-values the stored grain');
  });

  test('a receivable is owed from its move until it is paid, then paid', () => {
    const d = value({ kind: 'farm' }, 'CORN');
    const x = sales().find(r => r.crop === 'CORN' && r.paymentDate > r.date);
    assert.ok(x, 'the default farm has a corn move paid after its date');
    const before = d.points.filter(p => p.date >= x.date && p.date < x.paymentDate);
    assert.ok(before.length && before.every(p => p.owed >= x.amount - 1e-6));
    assert.ok(d.points.find(p => p.date === x.paymentDate).paid >= x.amount - 1e-6);
    assert.ok(d.points.at(-1).owed < 1e-6, 'all paid by the end');
  });

  test('the cost line is the pool\'s plans\' cost less their other revenue; a field shows its operator\'s', () => {
    const plan = RUN.farm.cropPlans.find(p => p.id === 'p-b-river');
    const op = value({ kind: 'operator', id: 'opB' }, plan.crop);
    const rows = RUN.jobCost.plans.filter(p => p.planId && p.operatorId === 'opB' && p.crop === plan.crop);
    close(op.need, rows.reduce((s, p) => s + p.totalCost - p.revenue.other, 0), 'opB');
    const set = grainValueSet(RUN.farm, moves(), sales(), RUN.ledger, RUN.jobCost, { kind: 'plan', id: plan.id }, null);
    assert.deepEqual(set.map(v => v.crop), [plan.crop]);
    assert.equal(set[0].pooledFrom, 'opB');
    assert.equal(set[0].need, op.need);
    assert.deepEqual(set[0].points.map(p => p.total), op.points.map(p => p.total));
    assert.match(grainValueCaption(set[0], { poolOf: 'Operator B' }), /Operator B's whole pool/);
  });

  test('the caption gives the peak, the share on the cash price and when the grain covers its cost', () => {
    const d = value({ kind: 'farm' }, 'CORN');
    const cap = grainValueCaption(d, { label: 'Corn' });
    assert.match(cap, /^Corn: worth up to \$/);
    assert.match(cap, /rides on the cash price/);
    assert.match(cap, /It covers the \$[\d,]+ this season's grain must earn from/);
    assert.match(cap, /carried in from the year before/);
    const short = { ...d, coveredFrom: null, everCovered: false, need: d.ending.season + 1000 };
    assert.match(grainValueCaption(short), /never reaches .*\$1,000 short at the end/);
  });

  test('the set shares one date range; the option stacks four bands with the cost line and RENDERS', () => {
    const set = grainValueSet(RUN.farm, moves(), sales(), RUN.ledger, RUN.jobCost, { kind: 'farm' }, null);
    assert.equal(new Set(set.map(v => `${v.start}|${v.end}`)).size, 1);
    const d = value({ kind: 'farm' }, 'CORN', `${RUN.farm.season.cropYear}-11-01`);
    const opt = grainValueOption(d, { colors: COLORS, title: 'Corn' });
    assert.deepEqual(opt.series.map(s => s.id), [...GRAIN_VALUE_BANDS.map(b => b.id), 'needExtent']);
    assert.ok(opt.series.slice(0, -1).every(s => s.stack === 'value' && s.step === 'end'));
    const mk = opt.series[0].markLine.data;
    assert.ok(mk.some(m => m.name === 'must earn' && m.yAxis === d.need) && mk.some(m => m.name === 'now'));
    const chart = echarts.init(null, null, { renderer: 'svg', ssr: true, width: 800, height: 240 });
    try { chart.setOption(opt); assert.ok(chart.renderToSVGString().includes('<path')); } finally { chart.dispose(); }
  });

  test('a band that is zero all season draws no outline, in both charts', () => {
    const width = (opt, id) => opt.series.find(s => s.id === id).lineStyle.width;
    const v = value({ kind: 'farm' }, 'CORN');
    const vEmpty = { ...v, points: v.points.map(p => ({ ...p, binUnpriced: 0 })) };
    assert.equal(width(grainValueOption(vEmpty, { colors: COLORS }), 'binUnpriced'), 0);
    assert.equal(width(grainValueOption(v, { colors: COLORS }), 'binUnpriced'), 1);
    const g = grainChartData(RUN.farm, moves(), RUN.ledger, { kind: 'farm' }, 'CORN', null);
    const gEmpty = { ...g, points: g.points.map(p => ({ ...p, sold: 0 })) };
    assert.equal(width(grainChartOption(gEmpty, { colors: COLORS }), 'sold'), 0);
    assert.equal(width(grainChartOption(g, { colors: COLORS }), 'binContracted'), 1);
  });

  test('the tooltip gives each band, the cash price and the day\'s moves and payments', () => {
    const d = value({ kind: 'farm' }, 'CORN');
    const opt = grainValueOption(d, { colors: COLORS });
    const day = d.points.find(p => p.events.some(e => e.kind === 'CONTRACT' || e.kind === 'SALE') && p.unpricedBu > 0);
    const tip = opt.tooltip.formatter([{ value: [ts(day.date), 0] }]);
    for (const b of GRAIN_VALUE_BANDS) assert.ok(tip.includes(b.label), b.label);
    assert.ok(tip.includes(`at $${day.price.toFixed(2)}`), 'the cash price');
    assert.match(tip, /must earn/);
    assert.match(tip, /bu for \$/);
    const payDay = d.points.find(p => p.events.some(e => e.kind === 'PAID'));
    assert.match(opt.tooltip.formatter([{ value: [ts(payDay.date), 0] }]), /paid: /);
  });

  test('the panel draws the value section with a caption per crop', () => {
    const p = mount();
    try {
      assert.equal(q(p, 'value-wrap').style.display, '');
      assert.match(q(p, 'value-label').textContent, /what the grain is worth/);
      const caps = [...p.el.querySelectorAll('[data-fpl-value-caption]')].map(e => e.textContent);
      assert.equal(caps.length, 2);
      assert.ok(caps.every(c => /worth up to/.test(c)));
    } finally { p.unmount(); }
  });
});

// ─── Step 8b: this season's real prices and its marketing windows ───────────────

describe('the season so far (design 134 §17.5 step 8b)', () => {
  let RUN26;
  beforeAll(() => {
    const { log } = console; console.log = () => {};
    try { RUN26 = runFarm(FarmScenario.buildDefaultConfig({ cropYear: 2026 })); } finally { console.log = log; }
  });
  // A history whose answer is known: corn climbs through the year, soybeans stay flat.
  const HISTORY = { crops: {
    CORN:     { start: '2026-01', values: [2.0, 2.5, 3.0, 3.5, 4.0, 4.5] },
    SOYBEANS: { start: '2026-01', values: [3.0, 3.0, 3.0] },
  } };

  test('the windows are exactly the published months at or above the breakeven', () => {
    const { farm, jobCost } = RUN26;
    const set = breakevenChartSet(farm, jobCost, { kind: 'farm' }, '2026-06-01', { history: HISTORY });
    const corn = set.find(d => d.crop === 'CORN');
    const be = corn.breakevenUnpricedPrice;
    const want = HISTORY.crops.CORN.values.map((v, i) => [`2026-0${i + 1}`, v]).filter(([, v]) => v >= be).map(([m]) => m);
    assert.ok(want.length > 0 && want.length < 6, `the fixture straddles the breakeven ${be}`);
    assert.deepEqual(corn.windows.months, want);
    assert.equal(corn.windows.first, want[0]);
    assert.equal(corn.windows.published, 6);
    const soy = set.find(d => d.crop === 'SOYBEANS');
    assert.ok(soy.breakevenUnpricedPrice > 3, 'soybeans never reach it');
    assert.deepEqual(soy.windows.months, []);
    assert.match(breakevenCaption(soy, { label: 'Soybeans' }), /below it in all 3 published months/);
    assert.match(breakevenCaption(corn, { label: 'Corn' }), new RegExp(`in ${want.length} of 6 published months, first in`));
    assert.match(breakevenCaption(corn), /Nebraska average price received/, 'the limits are said');
    assert.doesNotMatch(breakevenCaption(corn, { limits: false }), /not a local bid/);
  });

  test('a season with no published months draws no history and says nothing about it', () => {
    const d = breakevenChartData(RUN.farm, RUN.jobCost, { kind: 'farm' }, 'CORN', null, { history: HISTORY });
    assert.deepEqual(d.history, []);
    assert.doesNotMatch(breakevenCaption(d), /Nebraska average/);
    assert.equal(breakevenChartOption(d, { colors: COLORS }).series.some(x => x.id === 'history'), false);
  });

  test('the option draws the months at mid-month with a green band per window, and renders', () => {
    const { farm, jobCost } = RUN26;
    const corn = breakevenChartSet(farm, jobCost, { kind: 'farm' }, '2026-06-01', { history: HISTORY }).find(d => d.crop === 'CORN');
    const opt = breakevenChartOption(corn, { colors: COLORS });
    const h = opt.series.find(x => x.id === 'history');
    assert.deepEqual(h.data.map(p => new Date(p[0]).toISOString().slice(0, 10)),
      HISTORY.crops.CORN.values.map((_, i) => `2026-0${i + 1}-15`));
    assert.equal(h.markArea.data.length, corn.windows.months.length);
    assert.equal(new Date(h.markArea.data[0][0].xAxis).toISOString().slice(0, 10), `${corn.windows.first}-01`);
    const chart = echarts.init(null, null, { renderer: 'svg', ssr: true, width: 800, height: 240 });
    try { chart.setOption(opt); assert.ok(chart.renderToSVGString().includes('#eeeeee')); } finally { chart.dispose(); }
  });

  test('by default the chart reads the real NASS history for the crop year', () => {
    const { farm, jobCost } = RUN26;
    const corn = breakevenChartSet(farm, jobCost, { kind: 'farm' }, null).find(d => d.crop === 'CORN');
    assert.ok(corn.history.length > 0, 'the extract on disk has 2026 months');
    assert.equal(corn.history[0][0], '2026-01');
    assert.ok(corn.history.every(([m]) => m.startsWith('2026') || m.startsWith('2027')));
  });
});
