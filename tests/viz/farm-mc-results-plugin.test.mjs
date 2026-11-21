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
 * farm-mc-results-plugin.test.mjs — design 134 §17.12, the Farm MC Results panel.
 *
 * Pinned here: the panel shows the batch the Farm MC panel stored on the runtime (table,
 * charts, paths), its representative paths are real paths at their ranks, a path's drawn
 * values are ranked by distance from the batch median, Replay publishes exactly the path and
 * the price vol the batch filled, and the badge follows the store's replay.
 */

import assert from 'node:assert/strict';
import v8 from 'node:v8';
import { FarmMcResultsPlugin, farmMcPaths, farmMcRepresentatives, farmMcSortPaths, farmMcDrivers }
  from '../../src/visualization/workbench/plugins/finance/farm-mc-results-plugin.js';
import { farmMcStore } from '../../src/visualization/workbench/plugins/finance/farm-mc-store.js';
import { FarmScenario } from '../../src/scenarios/farm-scenario.js';
import { FarmMcRunner, FarmMcConfig } from '../../src/finance/farm/farm-mc.js';
import { normalizeFarm } from '../../src/finance/farm/farm-records.js';
import { FINANCE_PLUGINS, FINANCE_VIEW_TEMPLATES }
  from '../../src/visualization/workbench/plugins/finance/finance-plugin-package.js';

const RENT = 'farm.field.b-river.rentPerAcre';
const YIELD = 'farm.season.s2027.yieldShock';
const quiet = async (f) => {
  const { log, warn } = console;
  console.log = () => {}; console.warn = () => {};
  try { return await f(); } finally { console.log = log; console.warn = warn; }
};

let CFG, BATCH;
beforeAll(async () => {
  if (typeof global.structuredClone !== 'function') {
    global.structuredClone = (obj) => v8.deserialize(v8.serialize(obj));
  }
  CFG = { ...FarmScenario.buildDefaultConfig(), id: 'farm-test' };
  const mc = new FarmMcConfig();
  mc.applyOverride(RENT, { enabled: true, stdDev: 40, centerDirty: false });
  mc.applyOverride(YIELD, { enabled: true, centerDirty: false });
  const { summary, runs } = await quiet(() => new FarmMcRunner({ n: 12, cfgTemplate: CFG, mcConfig: mc, parallel: false }).run());
  BATCH = { summary, runs, farm: normalizeFarm(CFG.farm), labels: { [RENT]: 'River rent', [YIELD]: 'Farm-wide yield shock' }, scenarioId: CFG.id };
});

const runtime = () => {
  const published = [];
  return { published, bus: { subscribe: () => () => {}, publish: (m) => published.push(m) } };
};
function mount({ rt = runtime(), cfg = CFG, result = BATCH } = {}) {
  if (result) farmMcStore(rt).setResult(result);
  const plugin = new FarmMcResultsPlugin(rt);
  plugin.setServices({ schemaRegistry: { formatAmount: (n) => `$${Math.round(n)}` } });
  plugin.setConfig(cfg);
  const container = document.createElement('div');
  document.body.appendChild(container);
  plugin.mount(container);
  return { p: plugin, rt };
}
const q = (p, name) => p.el.querySelector(`[data-fmr="${name}"]`);
const click = (el) => el.dispatchEvent(new Event('click', { bubbles: true }));

test('registered as a panel and opened by the Farm view', () => {
  assert.ok(FINANCE_PLUGINS.some(p => p.id === 'farm-mc-results' && p.component === FarmMcResultsPlugin));
  assert.ok(FINANCE_VIEW_TEMPLATES.Farm.center.tabs.includes('farm-mc-results'));
  assert.ok(FINANCE_VIEW_TEMPLATES.Everything.center.tabs.includes('farm-mc-results'));
});

test('with no batch it says where to run one', () => {
  const { p } = mount({ result: null });
  assert.match(q(p, 'placeholder').textContent, /Farm MC panel/);
  assert.equal(q(p, 'grid').style.display, 'none');
  assert.equal(q(p, 'paths').style.display, 'none');
  p.unmount();
});

test('the batch\'s table, charts and paths; a batch stored later shows at once', () => {
  const { p, rt } = mount({ result: null });
  farmMcStore(rt).setResult(BATCH);
  const first = q(p, 'rows').querySelector('tr');
  assert.match(first.textContent, /Whole farm/);
  assert.ok(first.textContent.includes(`$${Math.round(BATCH.summary.metrics['farm.net.custom'].p50)}`));
  assert.equal(q(p, 'charts').style.display, '');
  assert.match(q(p, 'hist-label').textContent, /12 paths/);
  assert.match(q(p, 'status').textContent, /12 paths/);
  assert.equal(q(p, 'path-rows').querySelectorAll('tr[data-path]').length, 12);
  assert.ok(q(p, 'rep-rows').querySelectorAll('tr[data-rep]').length >= 3);
  p.unmount();
});

test('representatives are real paths at their ranks; worst and best are the extremes', () => {
  const paths = farmMcPaths(BATCH.runs, 'farm', 'custom');
  const reps = farmMcRepresentatives(paths);
  const nets = paths.map(x => x.net);
  const byLabel = Object.fromEntries(reps.map(r => [r.label, r.index]));
  assert.equal(nets[byLabel.Worst], Math.min(...nets));
  assert.equal(nets[byLabel.Best], Math.max(...nets));
  const sorted = [...nets].sort((a, b) => a - b);
  assert.equal(nets[byLabel.Median], sorted[Math.round(0.5 * (sorted.length - 1))]);
  assert.equal(new Set(reps.map(r => r.index)).size, reps.length, 'a path is listed once');
  assert.deepEqual(farmMcRepresentatives([{ index: 0, net: 5 }]).map(r => r.label), ['Worst']);
});

test('sorting on a column, both ways; losses only lists the losing paths', () => {
  const paths = farmMcPaths(BATCH.runs, 'farm', 'custom');
  const up = farmMcSortPaths(paths, { key: 'net', dir: 1 }).map(x => x.net);
  assert.deepEqual(up, [...up].sort((a, b) => a - b));
  const down = farmMcSortPaths(paths, { key: 'net', dir: -1 }).map(x => x.net);
  assert.deepEqual(down, [...up].reverse());

  const { p } = mount();
  const th = q(p, 'paths').querySelector('th[data-sort="net"]');
  click(th);   // already on net ascending: the click reverses it
  assert.equal(th.dataset.dir, 'desc');
  const shown = [...q(p, 'path-rows').querySelectorAll('tr[data-path]')].map(tr => BATCH.runs[Number(tr.dataset.path)].metrics['farm.net.custom']);
  assert.deepEqual(shown, down);
  const box = q(p, 'losses'); box.checked = true; box.dispatchEvent(new Event('change', { bubbles: true }));
  const losing = paths.filter(x => x.net < 0).length;
  assert.equal(q(p, 'path-rows').querySelectorAll('tr[data-path]').length, losing);
  p.unmount();
});

test('a path\'s drawn values are ranked by distance from the batch median, in its spread', () => {
  const d = farmMcDrivers(BATCH.runs, [RENT, YIELD, 'farm.not.sampled']);
  assert.deepEqual([...d.stats.keys()].sort(), [RENT, YIELD].sort(), 'only keys that vary');
  const ds = d.of(3);
  assert.ok(Math.abs(ds[0].z) >= Math.abs(ds[1].z));
  const rent = ds.find(x => x.key === RENT);
  assert.equal(rent.value, BATCH.runs[3].params[RENT]);
  assert.ok(Math.abs(rent.z - (rent.value - rent.median) / rent.sd) < 1e-12);

  const { p } = mount();
  click(q(p, 'path-rows').querySelector('tr[data-path="3"]'));
  const detail = q(p, 'path-rows').querySelector('tr[data-path="3"]').nextElementSibling;
  assert.match(detail.textContent, /River rent/);
  assert.match(detail.textContent, /Farm-wide yield shock/);
  assert.match(detail.textContent, /σ/);
  click(q(p, 'rep-rows').querySelector('tr[data-rep]'));   // a representative row expands nothing
  assert.equal(q(p, 'path-rows').querySelectorAll('tr.sec-detail-row').length, 1);
  p.unmount();
});

test('Replay publishes the path, its index and the batch\'s filled price vol', () => {
  const { p, rt } = mount();
  click(q(p, 'path-rows').querySelector('button[data-replay="5"]'));
  const msg = rt.published.at(-1);
  assert.equal(msg.type, 'workbench.farm.mc.replay');
  assert.equal(msg.index, 5);
  assert.equal(msg.run, BATCH.runs[5]);
  assert.deepEqual(msg.priceVolFilled, BATCH.summary.provenance.priceVolFilled);
  assert.match(msg.label, /^path 6/);
  p.unmount();
});

test('a batch run on another scenario cannot be replayed here, and says so', () => {
  const { p, rt } = mount({ cfg: { ...CFG, id: 'another' } });
  assert.match(q(p, 'warn').textContent, /another scenario/);
  assert.ok(q(p, 'path-rows').querySelector('button[data-replay="0"]').disabled);
  p.replay(0);
  assert.equal(rt.published.length, 0);
  p.unmount();
});

test('the badge shows the replay in force on this scenario, and Clear asks the app to put it back', () => {
  const { p, rt } = mount();
  assert.equal(q(p, 'replay').style.display, 'none');
  farmMcStore(rt).setReplay({ index: 2, seed: 3, label: 'path 3 (worst by whole farm net)', scenarioId: CFG.id });
  assert.equal(q(p, 'replay').style.display, '');
  assert.match(q(p, 'replay-text').textContent, /replaying path 3 \(worst by whole farm net\): the Field P&L/);
  click(q(p, 'replay-clear'));
  assert.deepEqual(rt.published.at(-1), { type: 'workbench.farm.mc.replay.clear' });
  farmMcStore(rt).setReplay({ index: 2, seed: 3, label: 'x', scenarioId: 'another' });
  assert.equal(q(p, 'replay').style.display, 'none', 'another scenario\'s replay is not this one\'s');
  p.unmount();
});
