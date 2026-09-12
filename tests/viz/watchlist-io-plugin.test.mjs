/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

// watchlist-io-plugin.test.mjs — design 101 W4: the Watchlist panel's ⇅ menu, driven
// through the real controller, facade and FieldSeriesStore, as the app wires them.

import assert from 'node:assert/strict';
import { WatchlistPlugin }     from '../../src/visualization/workbench/plugins/finance/watchlist-plugin.js';
import { WorkbenchRuntime, WB_EVENTS } from '../../src/visualization/workbench/workbench-runtime.js';
import { WatchlistController } from '../../src/visualization/watchlist/watchlist-controller.js';
import { FieldSeriesStore }    from '../../src/visualization/state/field-series-store.js';
import { StateSchemaRegistry } from '../../src/finance/services/state-schema-registry.js';
import { parseDefinition }     from '../../src/visualization/watchlist/watchlist-io.js';

let alerts;
beforeEach(() => {
  document.body.innerHTML = '';
  alerts = [];
  global.window.alert = msg => alerts.push(msg);
});

const D = s => new Date(`${s}T00:00:00Z`);

function rig() {
  const runtime = new WorkbenchRuntime();
  const reg = new StateSchemaRegistry();
  reg.registerAccount('usStockAccount', { currency: { code: 'USD' }, type: 'brokerage', name: 'Brokerage', country: 'US' });

  const store = new FieldSeriesStore();
  store.append('usStockAccount.balance', D('2026-01-01'), 1000);
  store.append('usStockAccount.balance', D('2027-01-01'), 1100);
  // Watched only after the run: the snapshots are all there is.
  store.simulationHistory = { snapshots: [
    { date: D('2026-01-01'), state: { marketIndex: { EQUITY_US: { price: 100 } } } },
    { date: D('2027-01-01'), state: { marketIndex: { EQUITY_US: { price: 107 } } } },
  ] };

  const cfg = {
    accounts: [{ stateKey: 'usStockAccount' }],
    activeWatchlistId: 'w1',
    watchlists: [
      { id: 'w1', name: 'Markets & more', entries: [
        { path: 'usStockAccount.balance', charted: true },
        { path: 'marketIndex.EQUITY_US.price', charted: true, label: 'US index' },
      ] },
      { id: 'w2', name: 'Other', entries: [{ path: 'metrics.netWorth', charted: true }] },
    ],
  };
  const ctl = new WatchlistController({ cfg, chart: null, fieldStore: store, bus: runtime.bus });
  runtime.watchlist = ctl.facade();
  ctl.start();

  const sim = { state: { usStockAccount: { balance: 1100 }, marketIndex: { EQUITY_US: { price: 107 } }, metrics: { netWorth: 5 } },
                bus: null };
  const plugin = new WatchlistPlugin(runtime);
  plugin.setServices({ schemaRegistry: reg });
  const downloads = [];
  plugin._download = (filename, text, mime) => downloads.push({ filename, text, mime });
  const host = document.createElement('div');
  document.body.appendChild(host);
  plugin.mount(host);
  runtime.bus.publish({ type: WB_EVENTS.SCENARIO_READY, scenario: { sim } });
  return { runtime, ctl, cfg, plugin, host, downloads };
}

const openMenu = host => { host.querySelector('[data-wl="io"]').click(); return [...host.querySelectorAll('.wl-menu-item')]; };
const pick     = (host, re) => openMenu(host).find(b => re.test(b.textContent)).click();

test('the ⇅ menu offers the three forms, with the active list named', () => {
  const { host } = rig();
  assert.deepEqual(openMenu(host).map(b => b.textContent), [
    'Export "Markets & more" (JSON)', 'Export all lists (JSON)', 'Import lists (JSON)…', 'Download series (CSV)',
  ]);
});

test('export this list: one list, its entries, a filename from its name', () => {
  const { host, downloads } = rig();
  pick(host, /^Export "/);
  assert.equal(downloads.length, 1);
  assert.match(downloads[0].filename, /^watchlist-markets-more-\d{4}-\d{2}-\d{2}\.json$/);
  const lists = parseDefinition(downloads[0].text);
  assert.deepEqual(lists.map(l => l.name), ['Markets & more']);
  assert.deepEqual(lists[0].entries.map(e => e.label), [null, 'US index']);
});

test('export all, then import into another scenario: appended, renamed, reported', () => {
  const a = rig();
  pick(a.host, /^Export all/);
  const text = a.downloads[0].text;
  assert.match(a.downloads[0].filename, /^watchlists-all-/);

  const b = rig();
  b.plugin._importText(text);
  assert.deepEqual(b.ctl.model.lists.map(l => l.name),
    ['Markets & more', 'Other', 'Markets & more (imported)', 'Other (imported)']);
  assert.equal(b.ctl.model.active().name, 'Markets & more (imported)', 'the first imported list is active');
  assert.equal(b.host.querySelector('[data-wl="list"]').selectedOptions[0].textContent, 'Markets & more (imported) (2)');
  assert.equal(b.cfg.watchlists.length, 4, 'persisted into the scenario');
  assert.match(alerts[0], /Imported 2 watchlists \(3 fields\)/);
  assert.doesNotMatch(alerts[0], /not in this scenario/, 'every path resolves here');
});

test('import keeps a path this scenario lacks, and names it', () => {
  const { host, plugin, ctl } = rig();
  plugin._importText(JSON.stringify({ watchlists: [{ name: 'Theirs', entries: ['otherAccount.balance', 'usStockAccount.balance'] }] }));
  assert.deepEqual(ctl.model.active().entries.map(e => e.path), ['otherAccount.balance', 'usStockAccount.balance']);
  assert.match(alerts[0], /1 field is not in this scenario's state/);
  assert.match(alerts[0], /• otherAccount\.balance/);
  // The panel shows it muted, as any absent path (W3).
  const muted = [...host.querySelectorAll('.wl-row.is-absent .lsp-metric-label')].map(l => l.title);
  assert.deepEqual(muted, ['otherAccount.balance']);
});

test('a bad import file changes nothing and says why', () => {
  const { plugin, ctl } = rig();
  plugin._importText('{"format":"something-else","watchlists":[]}');
  assert.equal(ctl.model.lists.length, 2);
  assert.match(alerts[0], /Could not import watchlists: .*not a watchlist export/);
});

test('series CSV: live and backfilled entries side by side, currency in the header', () => {
  const { host, downloads } = rig();
  pick(host, /^Download series/);
  assert.equal(downloads[0].mime, 'text/csv');
  assert.match(downloads[0].filename, /^watchlist-markets-more-series-/);
  const [head, ...rows] = downloads[0].text.replace(/^﻿/, '').split('\n');
  assert.equal(head, 'date,US Brokerage · Balance (USD),US index,resolution');
  assert.deepEqual(rows, ['2026-01-01,1000,100,mixed', '2027-01-01,1100,107,mixed']);
  assert.ok(downloads[0].text.startsWith('﻿'), 'BOM, so a spreadsheet reads the · as UTF-8');
});

test('with an empty active list the list exports are enabled and the CSV is not', () => {
  const { host, runtime } = rig();
  runtime.watchlist.create('Empty');
  const items = openMenu(host);
  assert.deepEqual(items.map(b => b.disabled), [false, false, false, true]);
});
