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
 * farm-mc-plugin.test.mjs — design 134 phase 2 step 2f, the Farm MC panel.
 *
 * The batch itself is pinned in tests/unit/farm-mc.test.mjs. Pinned here: the panel runs THAT
 * batch with the switches and spreads typed into its variable table, shows its summary row for
 * row, says when nothing is sampled, and says why it is empty on a household plan.
 */

import assert from 'node:assert/strict';
import v8 from 'node:v8';
import * as echarts from 'echarts';
import { FarmMcPlugin, farmMcRows, farmMcCsv, farmCashFan, farmNetHistogram, farmFanOption, farmHistOption }
  from '../../src/visualization/workbench/plugins/finance/farm-mc-plugin.js';
import { FarmScenario } from '../../src/scenarios/farm-scenario.js';
import { FarmMcRunner, FarmMcConfig } from '../../src/finance/farm/farm-mc.js';
import { normalizeFarm } from '../../src/finance/farm/farm-records.js';
import { FINANCE_PLUGINS, FINANCE_VIEW_TEMPLATES }
  from '../../src/visualization/workbench/plugins/finance/finance-plugin-package.js';

// jsdom has no structuredClone (the MC ctx is cloned the way a worker would receive it).
// v8's serializer is the same algorithm: unlike a JSON round trip it keeps Dates.
beforeAll(() => {
  if (typeof global.structuredClone !== 'function') {
    global.structuredClone = (obj) => v8.deserialize(v8.serialize(obj));
  }
});

const RUNTIME = { bus: { subscribe: () => () => {} } };
const KEY = 'farm.season.s2027.nitrogenMultiplier';

function mount(cfg = FarmScenario.buildDefaultConfig()) {
  const plugin = new FarmMcPlugin(RUNTIME);
  plugin.setServices({ schemaRegistry: { formatAmount: (n) => `$${Math.round(n)}` } });
  plugin.setConfig(cfg);
  plugin._parallel = false;
  const container = document.createElement('div');
  document.body.appendChild(container);
  plugin.mount(container);
  return plugin;
}
const q = (p, name) => p.el.querySelector(`[data-fmc="${name}"]`);
const fire = (el, type) => el.dispatchEvent(new Event(type, { bubbles: true }));
const quiet = async (f) => {
  const { log, warn } = console;
  console.log = () => {}; console.warn = () => {};
  try { return await f(); } finally { console.log = log; console.warn = warn; }
};

test('registered as a panel and opened by the Farm view', () => {
  assert.ok(FINANCE_PLUGINS.some(p => p.id === 'farm-mc' && p.component === FarmMcPlugin));
  assert.ok(FINANCE_VIEW_TEMPLATES.Farm.center.tabs.includes('farm-mc'));
  assert.ok(FINANCE_VIEW_TEMPLATES.Everything.center.tabs.includes('farm-mc'));
});

test('a household plan says it has no farm records', () => {
  const p = mount({ persons: [] });
  assert.match(q(p, 'placeholder').textContent, /no farm records/);
  assert.equal(q(p, 'grid').style.display, 'none');
  p.unmount();
});

test('the variable table lists the catalog, all off, and warns that nothing is sampled', async () => {
  const p = await quiet(() => mount());
  const rows = [...q(p, 'var-rows').querySelectorAll('tr[data-key]')];
  const { ctx } = await quiet(() => new FarmMcRunner({ cfgTemplate: FarmScenario.buildDefaultConfig() })._prepare());
  assert.equal(rows.length, ctx.variables.length);
  assert.ok(rows.every(tr => !tr.querySelector('input[type="checkbox"]').checked));
  assert.match(q(p, 'warn').textContent, /Nothing is sampled/);
  p.unmount();
});

test('Run uses the typed switches and spreads, and shows the batch\'s summary', async () => {
  const p = await quiet(() => mount());
  p._n = 6;
  const tr = q(p, 'var-rows').querySelector(`tr[data-key="${KEY}"]`);
  const box = tr.querySelector('input[type="checkbox"]'); box.checked = true; fire(box, 'change');
  assert.match(q(p, 'warn').textContent, /spread of 0/);
  const sd = tr.querySelector('input[type="number"]'); sd.value = '0.2'; fire(sd, 'change');
  assert.match(q(p, 'warn').textContent, /sensitivity run/);
  await quiet(() => p.run());

  const m = new FarmMcConfig(); m.applyOverride(KEY, { enabled: true, stdDev: 0.2 });
  const { summary } = await quiet(() => new FarmMcRunner({
    n: 6, cfgTemplate: FarmScenario.buildDefaultConfig(), mcConfig: m, parallel: false,
  }).run());
  assert.deepEqual(p._result.summary.metrics, summary.metrics, 'the panel ran the same batch');
  const first = [...q(p, 'rows').querySelectorAll('tr')][0];
  assert.match(first.textContent, /Whole farm/);
  assert.ok(first.textContent.includes(`$${Math.round(summary.metrics['farm.net.custom'].p50)}`));
  assert.match(q(p, 'status').textContent, /6 paths/);
  p.unmount();
});

test('a calibrated spread is not called typed; a sampled price with no vol of its own says it is calibrated', async () => {
  const p = await quiet(() => mount());
  const tick = (key) => {
    const box = q(p, 'var-rows').querySelector(`tr[data-key="${key}"] input[type="checkbox"]`);
    box.checked = true; fire(box, 'change');
  };
  tick('farm.season.s2027.yieldShock');
  assert.doesNotMatch(q(p, 'warn').textContent, /sensitivity run/);
  tick('farm.price.pc-harvest.shock');
  assert.match(q(p, 'warn').textContent, /Corn \(0\.18\).*calibrated volatility/);
  assert.equal(q(p, 'var-rows').querySelector('tr[data-key="farm.price.pc-harvest.shock"] input[type="number"]'), null,
    'a price shock is a unit z: no spread to type');
  p.unmount();
});

test('rows: farm, each operator with its plans, then each crop; basis picks the net', () => {
  const farm = normalizeFarm(FarmScenario.buildDefaultConfig().farm);
  const fieldOf = new Map(farm.fields.map(f => [f.id, f]));
  const scopes = ['farm', ...farm.operators.map(o => `operator.${o.id}`),
    ...farm.cropPlans.map(p => `plan.${p.id}`), ...new Set(farm.cropPlans.map(p => `crop.${p.crop}`))];
  const metrics = {};
  for (const scope of scopes) {
    metrics[`${scope}.net.custom`] = { p50: 1, lossProbability: 0 };
    metrics[`${scope}.net.actual`] = { p50: -1, lossProbability: 1 };
  }
  const op0 = farm.operators[0].id;
  metrics[`operator.${op0}.scheduleF`] = { p50: 5, lossProbability: 0.1 };
  const rows = farmMcRows({ metrics }, farm);
  const expected = ['farm'];
  for (const o of farm.operators) {
    expected.push('operator');
    for (const p of farm.cropPlans) if (fieldOf.get(p.fieldId)?.operatorId === o.id) expected.push('plan');
  }
  for (const _ of new Set(farm.cropPlans.map(p => p.crop))) expected.push('crop');
  assert.deepEqual(rows.map(r => r.level), expected);
  assert.equal(rows.find(r => r.key === `operator.${op0}`).scheduleF.p50, 5);
  assert.equal(farmMcRows({ metrics }, farm, 'actual')[0].lossProbability, 1);
});

test('the CSV carries every metric', () => {
  const csv = farmMcCsv({ metrics: { 'farm.net.custom': { n: 2, mean: 1, p10: 0, p50: 1, p90: 2, min: 0, max: 2, lossProbability: 0 } } });
  assert.equal(csv.split('\n')[1], 'farm.net.custom,2,1,0,1,2,0,2,0');
});

// ─── The charts ──────────────────────────────────────────────────────────────────

test('every path carries its monthly cash series; the fan and histogram are taken across paths', async () => {
  const cfg = FarmScenario.buildDefaultConfig();
  const mc = new FarmMcConfig();
  mc.applyOverride(KEY, { enabled: true, stdDev: 0.2, centerDirty: false });
  const { runs, summary } = await quiet(() => new FarmMcRunner({ n: 12, cfgTemplate: cfg, mcConfig: mc, parallel: false }).run());
  const farm = normalizeFarm(cfg.farm);
  for (const r of runs) {
    assert.equal(r.cashSeries.months.length, 36);
    // The farm is the sum of its operators, month by month.
    r.cashSeries.months.forEach((_, i) => {
      const ops = farm.operators.reduce((t, o) => t + r.cashSeries.series[`operator.${o.id}`][i], 0);
      assert.ok(Math.abs(ops - r.cashSeries.series.farm[i]) < 1e-6);
    });
  }
  const fan = farmCashFan(runs, 'farm');
  assert.ok(fan.months.length > 1 && fan.months.length <= 36);
  assert.equal(fan.p50[0], 0, 'the fan opens on a flat month at 0');
  fan.months.forEach((_, i) => assert.ok(fan.p10[i] <= fan.p25[i] && fan.p25[i] <= fan.p50[i]
    && fan.p50[i] <= fan.p75[i] && fan.p75[i] <= fan.p90[i]));
  const h = farmNetHistogram(runs, 'farm', 'custom');
  assert.equal(h.counts.reduce((a, b) => a + b, 0), 12);
  assert.equal(h.edges.length, h.counts.length + 1);
  assert.equal(h.lossProbability, summary.metrics['farm.net.custom'].lossProbability);
  const opt = farmFanOption(fan, { colors: { band: '#000000', red: '#ff0000', dim: '#999999', border: '#333333',
    borderHi: '#444444', text: '#eeeeee', muted: '#666666', panel: '#111111' }, money: String });
  assert.deepEqual(opt.xAxis.data, fan.months);
  assert.equal(farmCashFan([{ metrics: {} }], 'farm'), null);
  // Both options render headless (jsdom has no canvas, so the panel itself skips ECharts).
  const colors = { band: '#0000ff', red: '#ff0000', dim: '#999999',
    border: '#333333', borderHi: '#444444', text: '#eeeeee', muted: '#666666', panel: '#111111' };
  for (const o of [farmFanOption(fan, { colors, money: String }), farmHistOption(h, { colors, money: String })]) {
    const chart = echarts.init(null, null, { renderer: 'svg', ssr: true, width: 800, height: 240 });
    try { chart.setOption(o); assert.ok(chart.renderToSVGString().includes('#0000ff')); } finally { chart.dispose(); }
  }
});

test('the charts appear after a run with a scope per operator; the run bar uses the app\'s controls', async () => {
  const p = mount();
  assert.equal(q(p, 'charts').style.display, 'none');
  assert.ok(q(p, 'run').classList.contains('btn') && q(p, 'run').classList.contains('btn-primary'));
  assert.ok(q(p, 'n').classList.contains('mc-iters-input'));
  p._n = 6;
  await quiet(() => p.run());
  assert.equal(q(p, 'charts').style.display, '');
  const scopes = [...q(p, 'scope').querySelectorAll('button')].map(b => b.dataset.v);
  assert.equal(scopes[0], 'farm');
  assert.ok(scopes.length > 1);
  fire(q(p, 'scope').querySelector(`button[data-v="${scopes[1]}"]`), 'click');
  assert.ok(q(p, 'scope').querySelector(`button[data-v="${scopes[1]}"]`).classList.contains('on'));
  assert.match(q(p, 'hist-label').textContent, /6 paths/);
  p.unmount();
});

test('a band whose low end is below $0 is stacked on that low end, not on $0', () => {
  // ECharts' default stackStrategy ('samesign') stacked the band's positive height on 0 when
  // P10 was negative, so the shading stopped at the $0 line. Read what ECharts actually stacked.
  const fan = { months: ['2027-01', '2027-02'], p10: [-100, -50], p25: [-60, -20], p50: [-30, 0], p75: [10, 30], p90: [40, 80] };
  const colors = { band: '#0000ff', red: '#ff0000', dim: '#999999', border: '#333333', borderHi: '#444444',
    text: '#eeeeee', muted: '#666666', panel: '#111111' };
  const chart = echarts.init(null, null, { renderer: 'svg', ssr: true, width: 600, height: 200 });
  try {
    chart.setOption(farmFanOption(fan, { colors, money: String }));
    const top = (id) => {
      const data = chart.getModel().getSeries().find(s => s.id === id).getData();
      const dim = data.getCalculationInfo('stackResultDimension');
      return [0, 1].map(i => data.get(dim, i));
    };
    assert.deepEqual(top('outer-fill'), fan.p90, 'the outer band tops out at P90');
    assert.deepEqual(top('inner-fill'), fan.p75, 'the inner band tops out at P75');
  } finally { chart.dispose(); }
});
