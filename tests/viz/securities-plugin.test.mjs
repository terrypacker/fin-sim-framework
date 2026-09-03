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
 * securities-plugin.test.mjs — design 94 step 10, the third of §10.2e's loose ends.
 *
 * The panel exists to answer one question the other two cannot: *how many shares of this
 * do I own, and where are they?* The holdings table is scoped to one account and refuses
 * to total its Units column; the allocation panel crosses accounts but charts shares over
 * time. So what is worth pinning here is the boundary of the sum and the two ways a
 * cross-account money table lies:
 *
 *  1. a unit count totals WITHIN an instrument and is absent from the footer;
 *  2. a partial count is never shown — a scalar bucket withholds the whole row's;
 *  3. the money columns name the currency they are actually rendered in, not the cube's
 *     base. A mixed-currency sum under the wrong symbol is exactly how the guardrail FX
 *     defect read.
 */

import assert from 'node:assert/strict';
import { SecuritiesPlugin } from '../../src/visualization/workbench/plugins/finance/securities-plugin.js';

const RUNTIME = { bus: { subscribe: () => () => {} } };

const SECURITIES = {
  'sec-emp': { id: 'sec-emp', symbol: 'EMP', rateKey: 'EQUITY_US' },
  'sec-auto-EQUITY_US': { id: 'sec-auto-EQUITY_US', symbol: '', name: 'US market index', rateKey: 'EQUITY_US' },
};

const lot = (o) => ({ allocation: 'EQUITY', rateKey: 'EQUITY_US', costBasis: 0, marketValue: 0, ...o });

/** Employer stock in two wrappers, plus an index sleeve — the shape §3 item 4 is about. */
function simOf(state) {
  return { state, currentDate: new Date(Date.UTC(2031, 11, 31)), eventExecutions: 3, bus: null };
}

const TWO_WRAPPERS = {
  securities: SECURITIES,
  usBrokerage: {
    balance: 40000, country: 'US', currency: { code: 'USD' },
    holdings: [
      lot({ id: 'h1', securityId: 'sec-emp', units: 300, pricePerUnit: 100, marketValue: 30000, costBasis: 12000 }),
      lot({ id: 'h2', securityId: 'sec-auto-EQUITY_US', units: 100, pricePerUnit: 100, marketValue: 10000, costBasis: 9000 }),
    ],
  },
  k401: {
    balance: 20000, country: 'US', currency: { code: 'USD' },
    holdings: [lot({ id: 'h3', securityId: 'sec-emp', units: 200, pricePerUnit: 100, marketValue: 20000, costBasis: 15000 })],
  },
};

function mountPlugin(sim, { displayCurrency = null } = {}) {
  const plugin = new SecuritiesPlugin(RUNTIME);
  plugin.setServices({
    schemaRegistry: {
      formatAmount: (n) => `$${Math.round(n)}`,
      displayNameFor: (k) => ({ usBrokerage: 'Brokerage', k401: '401(k)' }[k] ?? null),
      displayCurrencyCode: () => displayCurrency,
    },
  });
  plugin._sim = sim;
  const container = document.createElement('div');
  document.body.appendChild(container);
  plugin.mount(container);
  return { plugin, container };
}

const q     = (p, name) => p.el.querySelector(`[data-sec="${name}"]`);
const rows  = (p) => [...q(p, 'rows').querySelectorAll('tr.sec-row')];
const cells = (tr) => [...tr.querySelectorAll('td')].map(td => td.textContent.trim());

test('one instrument in two accounts: the units add, and the accounts are named', () => {
  const { plugin } = mountPlugin(simOf(TWO_WRAPPERS));
  const emp = rows(plugin).find(tr => tr.dataset.id === 'sec-emp');
  assert.ok(emp, 'the employer stock must be one row, not two');
  const c = cells(emp);
  assert.equal(c[2], '500', '300 in the brokerage + 200 in the 401(k)');
  assert.equal(c[8], '2', 'across two accounts');

  // The breakdown is the "across all accounts" half — collapsed until asked for.
  assert.equal(q(plugin, 'rows').querySelectorAll('tr.sec-detail-row').length, 0);
  emp.dispatchEvent(new Event('click', { bubbles: true }));
  const detail = [...q(plugin, 'rows').querySelectorAll('tr.sec-detail-row')].map(cells);
  assert.equal(detail.length, 2);
  assert.deepEqual(detail.map(d => d[1]), ['300', '200']);
  assert.ok(detail.some(d => /Brokerage/.test(d[0])), 'the display name, not the stateKey');
  plugin.unmount();
});

test('the footer totals MONEY and refuses to total units', () => {
  const { plugin } = mountPlugin(simOf(TWO_WRAPPERS));
  const foot = cells(q(plugin, 'foot').querySelector('tr'));
  assert.match(foot[0], /2 instruments/);
  assert.equal(foot[1], 'n/a', 'not a number, and not blank — blank reads as missing data');
  assert.equal(foot[3], '$60000', '30k + 20k employer + 10k index');
  plugin.unmount();
});

test('a scalar bucket withholds the whole row\'s count', () => {
  // A partial sum is an undercount presented as a count — the shape design 93 §5 spent
  // eight defects on.
  const state = {
    securities: SECURITIES,
    usBrokerage: {
      balance: 2000, country: 'US', currency: { code: 'USD' },
      holdings: [
        lot({ id: 'h1', securityId: 'sec-emp', units: 10, pricePerUnit: 100, marketValue: 1000, costBasis: 900 }),
        lot({ id: 'h2', securityId: 'sec-emp', marketValue: 1000, costBasis: 900 }),   // scalar
      ],
    },
  };
  const { plugin } = mountPlugin(simOf(state));
  const c = cells(rows(plugin)[0]);
  assert.equal(c[2], '—', 'not 10');
  assert.equal(c[3], '—', 'and therefore no per-unit value either');
  assert.equal(c[4], '$2000', 'money still adds');
  plugin.unmount();
});

test('the money headers name the currency the cells are rendered in', () => {
  const usd = mountPlugin(simOf(TWO_WRAPPERS));
  assert.equal(q(usd.plugin, 'cur-b').textContent, 'USD');
  usd.plugin.unmount();

  // `formatAmount` converts to the reader's display currency. A header hard-coded to the
  // cube's base would then label the column with a currency it is not in.
  const aud = mountPlugin(simOf(TWO_WRAPPERS), { displayCurrency: 'AUD' });
  assert.equal(q(aud.plugin, 'cur-b').textContent, 'AUD');
  aud.plugin.unmount();
});

test('hiding the market sleeves leaves only what the plan authored', () => {
  const { plugin } = mountPlugin(simOf(TWO_WRAPPERS));
  assert.equal(rows(plugin).length, 2);

  const toggle = q(plugin, 'synthetic');
  toggle.checked = false;
  toggle.dispatchEvent(new Event('change'));
  assert.deepEqual(rows(plugin).map(tr => tr.dataset.id), ['sec-emp']);
  plugin.unmount();
});

test('a plan that authors nothing says so, and says where to add one', () => {
  const state = {
    securities: { 'sec-auto-EQUITY_US': SECURITIES['sec-auto-EQUITY_US'] },
    usBrokerage: { balance: 100, country: 'US', currency: { code: 'USD' },
      holdings: [lot({ id: 'h1', securityId: 'sec-auto-EQUITY_US', units: 1, pricePerUnit: 100, marketValue: 100, costBasis: 100 })] },
  };
  const { plugin } = mountPlugin(simOf(state));
  const toggle = q(plugin, 'synthetic');
  toggle.checked = false;
  toggle.dispatchEvent(new Event('change'));

  assert.equal(q(plugin, 'grid').style.display, 'none');
  assert.match(q(plugin, 'placeholder').textContent, /authors no securities/i);
  plugin.unmount();
});

test('with no sim it says to run one rather than drawing an empty table', () => {
  const { plugin } = mountPlugin(null);
  assert.match(q(plugin, 'placeholder').textContent, /Run a simulation/);
  assert.equal(q(plugin, 'grid').style.display, 'none');
  plugin.unmount();
});

test('a house, a loan and a cash sleeve do not become a (none) row', () => {
  const state = {
    securities: SECURITIES,
    usBrokerage: { balance: 1000, country: 'US', currency: { code: 'USD' },
      holdings: [lot({ id: 'h1', securityId: 'sec-emp', units: 10, pricePerUnit: 100, marketValue: 1000, costBasis: 500 })] },
    house:    { kind: 'real-property', value: 900000, costBasis: 400000, country: 'US' },
    mortgage: { type: 'loan', balance: 500000, country: 'US' },
    cash:     { balance: 25000, country: 'US', currency: { code: 'USD' }, holdings: [] },
  };
  const { plugin } = mountPlugin(simOf(state));
  // One row, the instrument. Anything else would put the plan's largest number on a panel
  // that exists to show concentration among instruments.
  assert.deepEqual(rows(plugin).map(tr => tr.dataset.id), ['sec-emp']);
  assert.equal(cells(rows(plugin)[0])[7], '100.0%');
  plugin.unmount();
});
