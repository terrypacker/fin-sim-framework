/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

// watchlist-plugin.test.mjs — design 101 W3: the Watchlist panel, driven through the
// real controller/facade and the workbench bus, as the app wires it.

import assert from 'node:assert/strict';
import { WatchlistPlugin }     from '../../src/visualization/workbench/plugins/finance/watchlist-plugin.js';
import { WorkbenchRuntime, WB_EVENTS } from '../../src/visualization/workbench/workbench-runtime.js';
import { WatchlistController } from '../../src/visualization/watchlist/watchlist-controller.js';
import { StateSchemaRegistry } from '../../src/finance/services/state-schema-registry.js';
import { EventBus }            from '../../src/simulation-framework/event-bus.js';
import { EXECUTION_KINDS, EXECUTION_PHASES } from '../../src/simulation-framework/bus-messages.js';

beforeEach(() => {
  document.body.innerHTML = '';
  global.requestAnimationFrame = cb => setTimeout(cb, 0);
});

const tick = () => new Promise(r => setTimeout(r, 0));

function rig({ cfg, state } = {}) {
  const runtime = new WorkbenchRuntime();
  const reg = new StateSchemaRegistry();
  reg.registerAccount('usStockAccount', { currency: { code: 'USD' }, type: 'brokerage', name: 'Brokerage', country: 'US' });
  const chart = { charted: [], meta: [], syncActivePaths(p) { this.charted = [...p]; }, applySeriesMeta(e) { this.meta = e; } };
  const store = { get: p => (p === 'metrics.netWorth' ? [{ value: 1 }, { value: 2 }, { value: 3 }] : null) };
  const ctl = new WatchlistController({
    cfg: cfg ?? { activeWatchlistId: 'w1', watchlists: [{ id: 'w1', name: 'Overview', entries: [
      { path: 'metrics.netWorth', charted: true },
      { path: 'usStockAccount.holdings[id=h9].marketValue', charted: false },
      { path: 'effectiveGrowthRates.EQUITY_US', charted: true },
    ] }] },
    chart, fieldStore: store, bus: runtime.bus,
  });
  runtime.watchlist = ctl.facade();
  ctl.start();

  const sim = { state: state ?? { metrics: { netWorth: 3_214_000 }, effectiveGrowthRates: { EQUITY_US: 0.0715 },
                                  usStockAccount: { holdings: [] } },
                bus: new EventBus() };
  const plugin = new WatchlistPlugin(runtime);
  plugin.setServices({ schemaRegistry: reg });
  const host = document.createElement('div');
  document.body.appendChild(host);
  plugin.mount(host);
  runtime.bus.publish({ type: WB_EVENTS.SCENARIO_READY, scenario: { sim } });
  return { runtime, ctl, chart, plugin, sim, host };
}

const rows   = host => [...host.querySelectorAll('.wl-row')];
const labels = host => rows(host).map(r => r.querySelector('.lsp-metric-label').textContent);
const rowFor = (host, path) => rows(host).find(r => r.querySelector('.lsp-metric-label').title === path);

// ── Rendering ───────────────────────────────────────────────────────────────

test('renders the active list: picker, a row per entry, context labels, compact values', () => {
  const { host } = rig();
  const sel = host.querySelector('[data-wl="list"]');
  assert.deepStrictEqual([...sel.options].map(o => o.textContent), ['Overview (3)']);
  assert.deepStrictEqual(labels(host),
    ['Net Worth', 'US Brokerage · h9 · Market Value', 'Effective Growth Rates · EQUITY US']);
  const val = p => rowFor(host, p).querySelector('.lsp-metric-value').textContent;
  assert.strictEqual(val('metrics.netWorth'), '$3.21M');
  assert.strictEqual(val('effectiveGrowthRates.EQUITY_US'), '7.15%');
  assert.deepStrictEqual(rows(host).map(r => r.querySelector('input.lsp-chart-toggle').checked), [true, false, true]);
});

test('a path absent at the current date is muted and says so', () => {
  const { host } = rig();
  const row = rowFor(host, 'usStockAccount.holdings[id=h9].marketValue');
  assert.ok(row.classList.contains('is-absent'));
  assert.strictEqual(row.querySelector('.lsp-metric-value').textContent, 'not in state at this date');
});

test('the sparkline comes from the captured series', () => {
  const { host } = rig();
  assert.ok(rowFor(host, 'metrics.netWorth').querySelector('.lsp-metric-spark svg'));
  assert.strictEqual(rowFor(host, 'effectiveGrowthRates.EQUITY_US').querySelector('.lsp-metric-spark svg'), null);
});

test('values follow the run: a sim-bus step refreshes them', async () => {
  const { host, sim } = rig();
  sim.state = { ...sim.state, metrics: { netWorth: 4_000_000 },
                usStockAccount: { holdings: [{ id: 'h9', marketValue: 120_000 }] } };
  sim.bus.publish({ type: `EXECUTION_${EXECUTION_PHASES.END}`, kind: EXECUTION_KINDS.EVENT, date: '2031-01-01' });
  await tick();
  assert.strictEqual(rowFor(host, 'metrics.netWorth').querySelector('.lsp-metric-value').textContent, '$4.00M');
  const lot = rowFor(host, 'usStockAccount.holdings[id=h9].marketValue');
  assert.ok(!lot.classList.contains('is-absent'), 'the lot now exists');
  assert.strictEqual(lot.querySelector('.lsp-metric-value').textContent, '$120k');
});

test('with no scenario loaded, the panel says so', () => {
  const runtime = new WorkbenchRuntime();
  const plugin = new WatchlistPlugin(runtime);
  plugin.setServices({ schemaRegistry: new StateSchemaRegistry() });
  const host = document.createElement('div');
  plugin.mount(host);
  assert.match(host.querySelector('.wl-empty').textContent, /Load a scenario/);
  assert.ok(host.querySelector('[data-wl="new"]').disabled);
});

// ── Row gestures ────────────────────────────────────────────────────────────

test('the ☑ toggles charted; the chart follows', () => {
  const { host, chart } = rig();
  const cb = rowFor(host, 'effectiveGrowthRates.EQUITY_US').querySelector('input.lsp-chart-toggle');
  cb.checked = false;
  cb.dispatchEvent(new Event('change'));
  assert.deepStrictEqual(chart.charted, ['metrics.netWorth']);
  assert.strictEqual(rowFor(host, 'effectiveGrowthRates.EQUITY_US').querySelector('input.lsp-chart-toggle').checked, false);
});

test('a row click asks for the field history; the toggle click does not', () => {
  const { host, runtime } = rig();
  const opened = [];
  runtime.bus.subscribe(WB_EVENTS.FIELD_HISTORY_OPEN, e => opened.push(e.path));
  const row = rowFor(host, 'metrics.netWorth');
  row.querySelector('input.lsp-chart-toggle').click();
  row.querySelector('.lsp-metric-label').click();
  assert.deepStrictEqual(opened, ['metrics.netWorth']);
});

test('dragging a row onto another reorders the list', () => {
  const { host, ctl } = rig();
  rows(host)[0].querySelector('.wl-handle').dispatchEvent(new Event('dragstart', { bubbles: true }));
  rows(host)[2].dispatchEvent(new Event('drop', { bubbles: true, cancelable: true }));
  assert.deepStrictEqual(ctl.model.active().entries.map(e => e.path),
    ['usStockAccount.holdings[id=h9].marketValue', 'effectiveGrowthRates.EQUITY_US', 'metrics.netWorth']);
  assert.strictEqual(labels(host)[2], 'Net Worth', 'the panel re-rendered in the new order');
});

// ── The ⋯ menu ──────────────────────────────────────────────────────────────

const openMenu = (host, path) => rowFor(host, path).querySelector('.wl-more').click();
const menuItem = (host, text) => [...host.querySelectorAll('.wl-menu-item')].find(b => b.textContent.endsWith(text));

test('menu: rename label sets it (and the chart gets it); blank restores the automatic one', () => {
  const { host, chart } = rig();
  window.prompt = () => 'NW';
  openMenu(host, 'metrics.netWorth');
  menuItem(host, 'Rename label…').click();
  assert.strictEqual(labels(host)[0], 'NW');
  assert.strictEqual(chart.meta.find(e => e.path === 'metrics.netWorth').label, 'NW');
  window.prompt = () => '';
  openMenu(host, 'metrics.netWorth');
  menuItem(host, 'Rename label…').click();
  assert.strictEqual(labels(host)[0], 'Net Worth');
});

test('menu: the axis choice is checked and persisted', () => {
  const { host, ctl, chart } = rig();
  openMenu(host, 'metrics.netWorth');
  assert.ok(menuItem(host, 'Auto').textContent.startsWith('✓'));
  menuItem(host, 'Right').click();
  assert.strictEqual(ctl.model.active().entries[0].axis, 'right');
  assert.strictEqual(chart.meta.find(e => e.path === 'metrics.netWorth').axis, 'right');
  assert.strictEqual(host.querySelector('.wl-menu'), null, 'the menu closes after a choice');
});

test('menu: move up is disabled on the first row; move down and remove work', () => {
  const { host, ctl } = rig();
  openMenu(host, 'metrics.netWorth');
  assert.ok(menuItem(host, 'Move up').disabled);
  menuItem(host, 'Move down').click();
  assert.strictEqual(ctl.model.active().entries[1].path, 'metrics.netWorth');
  openMenu(host, 'metrics.netWorth');
  menuItem(host, 'Remove from watchlist').click();
  assert.ok(!ctl.model.has('metrics.netWorth'));
  assert.strictEqual(rows(host).length, 2);
});

test('menu: a click outside closes it', () => {
  const { host } = rig();
  openMenu(host, 'metrics.netWorth');
  assert.ok(host.querySelector('.wl-menu'));
  document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  assert.strictEqual(host.querySelector('.wl-menu'), null);
});

// ── List maintenance ────────────────────────────────────────────────────────

test('toolbar: new, rename, duplicate, switch', () => {
  const { host, ctl } = rig();
  const btn = n => host.querySelector(`[data-wl="${n}"]`);
  window.prompt = () => 'Markets';
  btn('new').click();
  assert.strictEqual(ctl.model.active().name, 'Markets');
  assert.match(host.querySelector('.wl-empty').textContent, /empty/);

  window.prompt = () => 'Indices';
  btn('rename').click();
  btn('duplicate').click();
  const sel = host.querySelector('[data-wl="list"]');
  assert.deepStrictEqual([...sel.options].map(o => o.textContent), ['Overview (3)', 'Indices (0)', 'Indices copy (0)']);

  sel.value = 'w1';
  sel.dispatchEvent(new Event('change'));
  assert.strictEqual(ctl.model.activeId, 'w1');
  assert.strictEqual(rows(host).length, 3);
});

test('toolbar: delete asks first; deleting the last list leaves none and disables the list buttons', () => {
  const { host, ctl } = rig();
  const btn = n => host.querySelector(`[data-wl="${n}"]`);
  window.confirm = () => false;
  btn('delete').click();
  assert.strictEqual(ctl.model.lists.length, 1, 'declined');
  window.confirm = () => true;
  btn('delete').click();
  assert.strictEqual(ctl.model.lists.length, 0);
  assert.match(host.querySelector('.wl-empty').textContent, /No watchlists/);
  assert.ok(btn('rename').disabled && btn('delete').disabled && btn('duplicate').disabled);
  assert.ok(!btn('new').disabled);
});
