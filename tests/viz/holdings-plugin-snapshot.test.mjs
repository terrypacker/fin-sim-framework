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
 * holdings-plugin-snapshot.test.mjs — design 94 §10 item 6 / step 9.
 *
 * A position is a COUNT of an INSTRUMENT at a PRICE. Before step 9 this table printed
 * only a dollar figure, which cannot distinguish a position that doubled in price from
 * one that doubled in size — the exact distinction the unitised representation exists to
 * make (design 93 §4), invisible in the one panel whose job is showing what is held.
 *
 * Two things are worth pinning, and neither is "the columns render":
 *
 *  1. **The registry reaches the read.** `snapshotHoldings` has taken a `securities`
 *     argument since step 1 and the panel passed none, so a lot whose market lives on its
 *     security showed a blank. `src/visualization` is outside the §5.2 read gate's scan,
 *     which is precisely why this needs a test rather than a static check.
 *  2. **The unit columns are hidden, not em-dashed, for a scalar book.** Both modes are
 *     first-class (design 93 §5); a column of dashes says "missing data" about a
 *     representation that is deliberate.
 */

import assert from 'node:assert/strict';
import { HoldingsPlugin } from '../../src/visualization/workbench/plugins/finance/holdings-plugin.js';

const RUNTIME = { bus: { subscribe: () => () => {} } };

const SECURITIES = {
  'sec-emp': { id: 'sec-emp', symbol: 'EMP', name: 'Employer stock', rateKey: 'EQUITY_US' },
  // No ticker: the label falls back to the name, then the id.
  'sec-auto-EQUITY_US': { id: 'sec-auto-EQUITY_US', symbol: '', name: 'US market', rateKey: 'EQUITY_US' },
};

function mount(holdings, { securities = SECURITIES } = {}) {
  const plugin = new HoldingsPlugin(RUNTIME);
  plugin.setServices({ accountService: { getAll: () => [
    { stateKey: 'usStockAccount', name: 'US Brokerage', country: 'US', currency: { code: 'USD' } },
  ] } });
  plugin._sim = {
    state: {
      securities,
      usStockAccount: { balance: holdings.reduce((s, h) => s + h.marketValue, 0), holdings },
    },
    currentDate: new Date('2050-06-01'),
    journal: { journal: [] },
  };
  const container = document.createElement('div');
  document.body.appendChild(container);
  plugin.mount(container);
  return plugin;
}

const bodyRows = (plugin) =>
  [...plugin.el.querySelectorAll('[data-hld="snap-body"] tr')]
    .map(tr => [...tr.querySelectorAll('td')].map(td => td.textContent.trim()));

const shown = (plugin, key) => plugin.el.querySelector(`[data-hld="${key}"]`).style.display !== 'none';

test('snapshot: a unitised position shows its instrument, its count and its price', () => {
  const plugin = mount([
    { id: 'h1', label: 'Employer', allocation: 'EQUITY', securityId: 'sec-emp',
      units: 600, pricePerUnit: 12.5, marketValue: 7500, costBasis: 5000 },
  ]);

  assert.ok(shown(plugin, 'units-th'));
  assert.ok(shown(plugin, 'price-th'));
  const [row] = bodyRows(plugin);
  // label · alloc · security · units · price · MV · basis · G/L
  assert.equal(row.length, 8);
  assert.equal(row[2], 'EMP');
  assert.equal(row[3], '600');      // a clean count keeps no trailing zeros
  assert.equal(row[4], '12.50');
});

test('snapshot: a fractional count is shown to the precision it needs', () => {
  // The engine's counts are genuinely fractional — the ladder splits a dollar total
  // across rungs, a spin-off distributes a fraction of a share — so rounding to whole
  // units would print `0` for a real position.
  const plugin = mount([
    { id: 'h1', label: 'Rung', allocation: 'BOND', securityId: null,
      units: 0.4237, pricePerUnit: 101.25, marketValue: 42.9, costBasis: 42.9 },
  ]);
  assert.equal(bodyRows(plugin)[0][3], '0.4237');
});

test('snapshot: a scalar book HIDES the unit pair rather than printing dashes', () => {
  const plugin = mount([
    { id: 'h1', label: 'Cash', allocation: 'CASH', marketValue: 500, costBasis: 500 },
    { id: 'h2', label: 'Bond fund', allocation: 'BOND', marketValue: 500, costBasis: 480 },
  ]);
  assert.equal(shown(plugin, 'units-th'), false);
  assert.equal(shown(plugin, 'price-th'), false);
  // label · alloc · security · MV · basis · G/L
  assert.equal(bodyRows(plugin)[0].length, 6);
});

test('snapshot: a lot with no instrument reads as an em-dash, not as a blank cell', () => {
  const plugin = mount([
    { id: 'h1', label: 'Cash', allocation: 'CASH', marketValue: 500, costBasis: 500 },
  ]);
  assert.equal(bodyRows(plugin)[0][2], '—');
});

test('snapshot: a security with no ticker falls back to its name', () => {
  const plugin = mount([
    { id: 'h1', label: 'US sleeve', allocation: 'EQUITY', securityId: 'sec-auto-EQUITY_US',
      units: 100, pricePerUnit: 10, marketValue: 1000, costBasis: 900 },
  ]);
  assert.equal(bodyRows(plugin)[0][2], 'US market');
});

test('snapshot: the total row spans the labels and does NOT total the units', () => {
  // Summing counts of different instruments produces a number that looks like a quantity
  // and is not one — the same category error as adding a share of Acme to a share of
  // SpinCo. The colspan has to grow with the table or the totals slide under the wrong
  // columns, which is a silently wrong table rather than a broken one.
  const plugin = mount([
    { id: 'h1', label: 'A', allocation: 'EQUITY', securityId: 'sec-emp',
      units: 10, pricePerUnit: 10, marketValue: 100, costBasis: 60 },
    { id: 'h2', label: 'B', allocation: 'EQUITY', securityId: 'sec-auto-EQUITY_US',
      units: 20, pricePerUnit: 10, marketValue: 200, costBasis: 150 },
  ]);
  const foot = plugin.el.querySelector('[data-hld="snap-foot"] tr');
  const cells = [...foot.querySelectorAll('td')];
  assert.equal(cells[0].textContent.trim(), 'Total');
  assert.equal(cells[0].getAttribute('colspan'), '5');   // 8 columns − the three numeric ones
  assert.equal(cells.length, 4);
});
