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
 * bonds-plugin.test.mjs — design 130 §4–§5.
 *
 * The rollup's arithmetic is pinned in tests/unit/bond-rollup.test.mjs. What is pinned here
 * is what the panel says about it: three levels that open on demand, a principal footer
 * that names what it covers, headers in the currency the cells are rendered in, the AU
 * exemption warning, CSV scopes, and a ladder option that tells rolling from spend-down.
 */

import assert from 'node:assert/strict';
import { BondsPlugin, bondsCsv, maturityLadderOption, BONDS_CSV_COLUMNS }
  from '../../src/visualization/workbench/plugins/finance/bonds-plugin.js';
import { rollupBonds, buildMaturityLadder } from '../../src/finance/allocation-reporting/bond-rollup.js';

const RUNTIME = { bus: { subscribe: () => () => {} } };
const ms = (y, m = 0, d = 1) => Date.UTC(y, m, d);

const bond = (o) => ({ allocation: 'BOND', rateKey: 'FIXED_INCOME_US', taxExemption: 'none',
  marketValue: 0, costBasis: 0, ...o });
const acct = (holdings, o = {}) => ({ balance: holdings.reduce((s, h) => s + h.marketValue, 0),
  country: 'US', currency: { code: 'USD' }, holdings, ...o });

const STATE = {
  people: { p1: { residencyState: 'CA' } },
  brokerage: acct([
    bond({ id: 'muni', label: 'CA muni fund', taxExemption: 'federal', issuingState: 'CA',
           marketValue: 2000, costBasis: 1800, couponRate: 0.03, duration: 6 }),
    bond({ id: 't1', label: 'UST 2032', taxExemption: 'state', marketValue: 1000, costBasis: 1000,
           faceValue: 1000, maturityDate: new Date(ms(2032, 5, 30)), couponRate: 0.04, duration: 5 }),
  ]),
  ira: acct([
    bond({ id: 't2', label: 'UST 2031', taxExemption: 'state', marketValue: 1000, costBasis: 1000,
           faceValue: 1000, maturityDate: new Date(ms(2031, 5, 30)), couponRate: 0.02, duration: 5,
           rollAtMaturity: true, rollTermYears: 3 }),
  ]),
};

const simOf = (state) => ({ state, currentDate: new Date(ms(2030)), eventExecutions: 1, bus: null });

function mountPlugin(sim, { displayCurrency = null } = {}) {
  const plugin = new BondsPlugin(RUNTIME);
  plugin.setServices({
    schemaRegistry: {
      formatAmount: (n) => `$${Math.round(n)}`,
      displayNameFor: (k) => ({ brokerage: 'Brokerage', ira: 'IRA', super: 'Super' }[k] ?? null),
      displayCurrencyCode: () => displayCurrency,
    },
  });
  plugin._sim = sim;
  const container = document.createElement('div');
  document.body.appendChild(container);
  plugin.mount(container);
  return { plugin, container };
}

const q     = (p, name) => p.el.querySelector(`[data-bond="${name}"]`);
const cells = (tr) => [...tr.querySelectorAll('td')].map(td => td.textContent.trim());
const typeRows = (p) => [...q(p, 'rows').querySelectorAll('tr.bond-type-row')];
const click = (el) => el.dispatchEvent(new Event('click', { bubbles: true }));

test('no sim, and a sim with no bonds, each say so', () => {
  const none = mountPlugin(null);
  assert.match(q(none.plugin, 'placeholder').textContent, /Run a simulation/);
  none.plugin.unmount();

  const noBonds = mountPlugin(simOf({ b: acct([{ id: 'e', allocation: 'EQUITY', marketValue: 5 }]) }));
  assert.equal(q(noBonds.plugin, 'placeholder').textContent, 'This plan holds no bonds.');
  assert.equal(q(noBonds.plugin, 'grid').style.display, 'none');
  noBonds.plugin.unmount();
});

test('type ▸ account ▸ lot, each level opening on a click', () => {
  const { plugin } = mountPlugin(simOf(STATE));
  assert.deepEqual(typeRows(plugin).map(tr => cells(tr)[0].replace(/^[▸▾]/, '')), ['Treasury', 'Muni — state-exempt']);
  assert.equal(q(plugin, 'rows').querySelectorAll('tr.bond-acct-row').length, 0);

  click(typeRows(plugin)[0]);
  const accts = [...q(plugin, 'rows').querySelectorAll('tr.bond-acct-row')];
  // Equal market value, so the stateKey breaks the tie.
  assert.deepEqual(accts.map(tr => cells(tr)[0].replace(/^[▸▾]/, '')), ['Brokerage', 'IRA']);

  click(accts.find(tr => /IRA/.test(tr.textContent)));
  const lot = q(plugin, 'rows').querySelector('tr.bond-lot-row');
  const c = cells(lot);
  assert.equal(c[0], 'UST 2031');
  assert.match(c[7], /↻/, 'a rolling rung is marked');
  assert.equal(c[5], '2.00%');
  plugin.unmount();
});

test('the footer totals principal, and says it covers dated bonds only', () => {
  const { plugin } = mountPlugin(simOf(STATE));
  const foot = q(plugin, 'foot').querySelector('tr');
  const c = cells(foot);
  assert.match(c[0], /2 types/);
  assert.equal(c[1], '$2000*', 'two dated Treasuries; the muni fund has no principal');
  assert.equal(c[2], '$4000');
  assert.ok(foot.querySelector('sup[title*="Dated bonds only"]'));
  plugin.unmount();
});

test('a fund-only group shows no principal, and a TIPS coupon is labelled real', () => {
  const state = { people: { p1: { residencyState: 'CA' } }, b: acct([
    bond({ id: 'tips', inflationLinked: true, taxExemption: 'state', marketValue: 1000, faceValue: 1000,
           maturityDate: new Date(ms(2035)), couponRate: 0.015 }),
    bond({ id: 'fund', marketValue: 500, couponRate: 0.05 }),
  ]) };
  const { plugin } = mountPlugin(simOf(state));
  const [tips, taxable] = typeRows(plugin).map(cells);
  assert.equal(tips[5], '1.50% real');
  assert.equal(taxable[1], '—');
  plugin.unmount();
});

test('the money headers name the display currency', () => {
  const aud = mountPlugin(simOf(STATE), { displayCurrency: 'AUD' });
  assert.equal(q(aud.plugin, 'cur-a').textContent, 'AUD');
  assert.equal(q(aud.plugin, 'cur-b').textContent, 'AUD');
  aud.plugin.unmount();
});

test('an AU-market lot with a US exemption raises the warning (§8 Q1)', () => {
  const state = { super: acct([bond({ id: 'au', label: 'AU govt', rateKey: 'FIXED_INCOME_AU',
    taxExemption: 'state', marketValue: 500 })], { country: 'AU', currency: { code: 'AUD' } }) };
  const { plugin } = mountPlugin(simOf(state));
  const warn = q(plugin, 'warn');
  assert.equal(warn.style.display, '');
  assert.match(warn.textContent, /1 AU-market bond lot carries a US tax exemption/);
  assert.match(warn.textContent, /Super — 1 lot, taxExemption 'state'/);
  assert.equal(warn.querySelector('details').open, false, 'collapsed until asked for');
  plugin.unmount();

  const clean = mountPlugin(simOf(STATE));
  assert.equal(q(clean.plugin, 'warn').style.display, 'none');
  clean.plugin.unmount();
});

test('a laddered account\'s warnings fold to one line, and everything scrolls together', () => {
  // The bug: nine rung warnings + the chart squeezed the table to 0px because only the
  // table scrolled. Now one line per (account, exemption), inside the one scroll body.
  const rungs = Array.from({ length: 9 }, (_, i) => bond({ id: `r${i}`, label: `Ladder ${i + 1}/9`,
    rateKey: 'FIXED_INCOME_AU', taxExemption: 'state', marketValue: 100, faceValue: 100,
    maturityDate: new Date(ms(2031 + i)) }));
  const { plugin } = mountPlugin(simOf({ super: acct(rungs, { country: 'AU', currency: { code: 'AUD' } }) }));
  const warn = q(plugin, 'warn');
  assert.match(warn.querySelector('summary').textContent, /9 AU-market bond lots carry/);
  assert.equal(warn.querySelectorAll('li').length, 1);
  assert.match(warn.textContent, /9 lots/);
  const body = q(plugin, 'body');
  assert.ok(body.contains(warn) && body.contains(q(plugin, 'chart-wrap')) && body.contains(q(plugin, 'grid')));

  // A reader who opened the details keeps them open across sim steps.
  warn.querySelector('details').open = true;
  plugin._dataSig = null;
  plugin._render();
  assert.equal(warn.querySelector('details').open, true);
  plugin.unmount();
});

test('the undated funds are a caption, not a bar', () => {
  const { plugin } = mountPlugin(simOf(STATE));
  assert.match(q(plugin, 'caption').textContent, /undated \(funds\): \$2000/);
  const toggle = q(plugin, 'show-chart');
  toggle.checked = false;
  toggle.dispatchEvent(new Event('change'));
  assert.equal(q(plugin, 'chart-wrap').style.display, 'none');
  plugin.unmount();
});

test('CSV: TYPE, ACCOUNT and LOT scopes', () => {
  const csv  = bondsCsv(rollupBonds(STATE, { date: new Date(ms(2030)) }));
  const rows = csv.split('\n').map(l => l.split(','));
  assert.deepEqual(rows[0], [...BONDS_CSV_COLUMNS]);
  const scopes = rows.slice(1).map(r => r[0]);
  assert.deepEqual(scopes, ['TYPE', 'ACCOUNT', 'LOT', 'ACCOUNT', 'LOT', 'TYPE', 'ACCOUNT', 'LOT']);
  const t2 = rows.find(r => r[4] === 't2');
  assert.equal(t2[6], '2031-06-30');
  assert.equal(t2[7], 'true');
});

test('ladder option: one stack, rolling principal hatched, a clicked year dims the rest', () => {
  const ladder = buildMaturityLadder(rollupBonds(STATE, { date: new Date(ms(2030)) }).lots,
    { date: new Date(ms(2030)) });
  const opt = maturityLadderOption(ladder, { highlightYear: 2031 });
  assert.deepEqual(opt.xAxis.data, ['2030', '2031', '2032']);
  assert.ok(opt.series.every(s => s.stack === 'principal' && s.type === 'bar'));
  const rolling = opt.series.find(s => /\(rolls\)/.test(s.name));
  assert.ok(rolling.itemStyle.decal, 'rolling principal carries the hatch');
  assert.ok(opt.series.filter(s => !/\(rolls\)/.test(s.name)).every(s => !s.itemStyle.decal));
  const ira = opt.series.find(s => s.name === 'ira (rolls)');
  assert.equal(ira.data[1].itemStyle, undefined, 'the clicked year stays full strength');
  assert.equal(ira.data[0].itemStyle.opacity, 0.35);
});
