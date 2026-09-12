/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

// watch-producers.test.mjs — design 101 W5: the Securities and Holdings panels put a ☆
// beside values whose state path can be watched. Driven through the real controller and
// facade on the workbench bus, as the app wires them.

import assert from 'node:assert/strict';
import { SecuritiesPlugin }    from '../../src/visualization/workbench/plugins/finance/securities-plugin.js';
import { HoldingsPlugin }      from '../../src/visualization/workbench/plugins/finance/holdings-plugin.js';
import { WorkbenchRuntime }    from '../../src/visualization/workbench/workbench-runtime.js';
import { WatchlistController } from '../../src/visualization/watchlist/watchlist-controller.js';
import { get }                 from '../../src/finance/monte-carlo/mc-param-paths.js';

beforeEach(() => { document.body.innerHTML = ''; });

const SECURITIES = {
  'sec-emp':            { id: 'sec-emp', symbol: 'EMP', rateKey: 'EQUITY_US' },
  'sec-gold':           { id: 'sec-gold', symbol: 'GLD', rateKey: 'GOLD' },
  'sec-auto-EQUITY_US': { id: 'sec-auto-EQUITY_US', symbol: '', name: 'US market index', rateKey: 'EQUITY_US' },
};

const lot = o => ({ allocation: 'EQUITY', costBasis: 0, marketValue: 0, ...o });

const STATE = {
  securities: SECURITIES,
  marketIndex:   { EQUITY_US: { price: 131.2, total: 142.7 } },
  // sec-gold tracks a market with no index level, so it has none either.
  securityIndex: { 'sec-emp': { price: 150.1, total: 160.4 }, 'sec-auto-EQUITY_US': { price: 131.2, total: 142.7 } },
  usStockAccount: {
    balance: 42000, country: 'US', currency: { code: 'USD' },
    holdings: [
      lot({ id: 'h1', label: 'Employer', securityId: 'sec-emp', units: 300, pricePerUnit: 100, marketValue: 30000, costBasis: 12000 }),
      lot({ id: 'h2', label: 'Gold', securityId: 'sec-gold', units: 10, pricePerUnit: 200, marketValue: 2000, costBasis: 1500 }),
      lot({ label: 'No id', securityId: 'sec-auto-EQUITY_US', units: 100, pricePerUnit: 100, marketValue: 10000, costBasis: 9000 }),
    ],
  },
};

function rig({ withWatchlist = true } = {}) {
  const runtime = new WorkbenchRuntime();
  const cfg = { activeWatchlistId: 'w1', watchlists: [{ id: 'w1', name: 'Markets', entries: [] }] };
  const ctl = new WatchlistController({ cfg, chart: null, bus: runtime.bus });
  if (withWatchlist) runtime.watchlist = ctl.facade();
  ctl.start();
  const sim = { state: STATE, currentDate: new Date(Date.UTC(2031, 11, 31)), eventExecutions: 3,
                journal: { journal: [] }, bus: null };
  return { runtime, ctl, cfg, sim };
}

function mount(plugin, sim, services) {
  plugin.setServices(services);
  plugin._sim = sim;
  const host = document.createElement('div');
  document.body.appendChild(host);
  plugin.mount(host);
  return plugin;
}

const mountSecurities = ({ runtime, sim }) => mount(new SecuritiesPlugin(runtime), sim, {
  schemaRegistry: { formatAmount: n => `$${Math.round(n)}`, displayNameFor: () => null, displayCurrencyCode: () => null },
});

const mountHoldings = ({ runtime, sim }) => mount(new HoldingsPlugin(runtime), sim, {
  accountService: { getAll: () => [{ stateKey: 'usStockAccount', name: 'US Brokerage', country: 'US', currency: { code: 'USD' } }] },
});

const star   = (p, path) => p.el.querySelector(`[data-watch-path="${path}"]`);
const stars  = p => [...p.el.querySelectorAll('[data-watch-path]')].map(s => s.getAttribute('data-watch-path'));
const click  = el => el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
const paths  = ctl => ctl.model.active().entries.map(e => e.path);

// ── Securities ──────────────────────────────────────────────────────────────

test('securities: a ☆ per indexed security and per indexed market, nothing for the rest', () => {
  const r = rig();
  const p = mountSecurities(r);
  assert.deepEqual(stars(p).sort(), [
    'marketIndex.EQUITY_US.price',   // on both EQUITY_US rows
    'marketIndex.EQUITY_US.price',
    'securityIndex.sec-auto-EQUITY_US.price',
    'securityIndex.sec-emp.price',
  ], 'sec-gold and the GOLD market have no index level, so nothing to point at');
  p.unmount();
});

test('securities: ☆ adds the security index to the active list, charted; ★ removes it', () => {
  const r = rig();
  const p = mountSecurities(r);
  click(star(p, 'securityIndex.sec-emp.price'));

  assert.deepEqual(paths(r.ctl), ['securityIndex.sec-emp.price']);
  assert.equal(r.ctl.model.active().entries[0].charted, true, 'like a State panel check (W-D4)');
  assert.deepEqual(r.cfg.watchlists[0].entries.map(e => e.path), ['securityIndex.sec-emp.price'], 'persisted');
  // WATCHLIST_CHANGED re-rendered the row: the star now reads as watched.
  const s = star(p, 'securityIndex.sec-emp.price');
  assert.equal(s.textContent, '★');
  assert.ok(s.classList.contains('is-watched'));
  assert.equal(p.el.querySelectorAll('tr.sec-detail-row').length, 0, 'the star did not expand the row');

  click(s);
  assert.deepEqual(paths(r.ctl), []);
  assert.equal(star(p, 'securityIndex.sec-emp.price').textContent, '☆');
  p.unmount();
});

test('securities: the market ☆ watches the market, and both of its stars follow', () => {
  const r = rig();
  const p = mountSecurities(r);
  click(star(p, 'marketIndex.EQUITY_US.price'));
  assert.deepEqual(paths(r.ctl), ['marketIndex.EQUITY_US.price']);
  const both = [...p.el.querySelectorAll('[data-watch-path="marketIndex.EQUITY_US.price"]')];
  assert.deepEqual(both.map(s => s.textContent), ['★', '★']);
  p.unmount();
});

test('securities: a change made elsewhere (State panel, Watchlist panel) repaints the stars', () => {
  const r = rig();
  const p = mountSecurities(r);
  r.runtime.watchlist.add('securityIndex.sec-emp.price', { charted: true });
  assert.equal(star(p, 'securityIndex.sec-emp.price').textContent, '★');
  r.runtime.watchlist.setActive(r.runtime.watchlist.create('Empty'));
  assert.equal(star(p, 'securityIndex.sec-emp.price').textContent, '☆', '★ means the ACTIVE list');
  p.unmount();
});

test('securities: with no watchlist facade there are no stars and the columns are unchanged', () => {
  const p = mountSecurities(rig({ withWatchlist: false }));
  assert.deepEqual(stars(p), []);
  const cells = [...p.el.querySelector('tr.sec-row').querySelectorAll('td')].map(td => td.textContent.trim());
  assert.equal(cells.length, 9);
  p.unmount();
});

// ── Holdings ────────────────────────────────────────────────────────────────

test('holdings: ☆ on market value and price, by lot id; none for a lot without one', () => {
  const r = rig();
  const p = mountHoldings(r);
  assert.deepEqual(stars(p).sort(), [
    'usStockAccount.holdings[id=h1].marketValue',
    'usStockAccount.holdings[id=h1].pricePerUnit',
    'usStockAccount.holdings[id=h2].marketValue',
    'usStockAccount.holdings[id=h2].pricePerUnit',
  ]);
  // Every star's path resolves to the value printed beside it.
  assert.equal(get(STATE, 'usStockAccount.holdings[id=h2].marketValue'), 2000);
  p.unmount();
});

test('holdings: ☆ toggles the lot field in the active list, and the column count holds', () => {
  const r = rig();
  const p = mountHoldings(r);
  const path = 'usStockAccount.holdings[id=h1].marketValue';
  click(star(p, path));
  assert.deepEqual(paths(r.ctl), [path]);
  assert.equal(star(p, path).textContent, '★');

  const row = [...p.el.querySelector('[data-hld="snap-body"] tr').querySelectorAll('td')];
  assert.equal(row.length, 8, 'the star lives inside the value cell, not in a column of its own');
  assert.match(row[5].textContent, /★/);

  click(star(p, path));
  assert.deepEqual(paths(r.ctl), []);
  p.unmount();
});

test('holdings: with every list deleted, a ☆ creates one rather than doing nothing', () => {
  const r = rig();
  const p = mountHoldings(r);
  r.runtime.watchlist.delete('w1');
  assert.equal(r.runtime.watchlist.activeId(), null);
  click(star(p, 'usStockAccount.holdings[id=h1].pricePerUnit'));
  assert.deepEqual(paths(r.ctl), ['usStockAccount.holdings[id=h1].pricePerUnit']);
  p.unmount();
});
