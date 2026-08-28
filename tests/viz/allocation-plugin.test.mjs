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
 * allocation-plugin.test.mjs — design 82 §6.
 *
 * Two things are worth pinning about this panel, and neither is "does it draw".
 *
 * 1. **It states the tie-out before the chart is read.** Every share on the panel rests
 *    on Σ cube rows === computeNetWorth (§3): a denominator missing an asset misstates
 *    EVERY slice, not just the missing one. So a broken tie-out must produce a loud
 *    "do not quote this", not a quietly wrong chart. That is the whole reason the
 *    provenance strip exists, and it is invisible to any test that only checks the
 *    happy path.
 *
 * 2. **Each view pivots the same fact table.** The views are GROUP-BYs over one cube
 *    (§2), so what is tested is that switching a view changes the grouping — not that
 *    a chart library was called.
 *
 * ECharts needs a canvas jsdom does not provide, so the panel's capability probe
 * (`_canvasAvailable`) reports none and `_drawChart` no-ops; everything else — provenance,
 * the legend/mix strip, the pivot options, the CSV — renders and is what these exercise.
 */

import assert from 'node:assert/strict';
import { AllocationPlugin, ALLOCATION_CSV_COLUMNS } from '../../src/visualization/workbench/plugins/finance/allocation-plugin.js';
import { buildAllocationSeries } from '../../src/finance/allocation-reporting/allocation-grouping.js';

const RUNTIME = { bus: { subscribe: () => () => {} } };

// jsdom has no 2D canvas, and its unimplemented `getContext` logs a full stack through
// the virtual console. Returning null says the same thing to the panel's capability
// probe without burying the test output in it.
HTMLCanvasElement.prototype.getContext = () => null;

/** One cube row, with only the fields the pivot and the panel actually read. */
function row(over = {}) {
  return {
    date: new Date(Date.UTC(2030, 11, 31)),
    stateKey: 'usStockAccount', name: 'US Brokerage', source: 'holding',
    kind: 'account', role: 'brokerage', type: 'us-stock',
    domicileCountry: 'US', exposureCountry: 'US', currency: 'USD',
    assetClass: 'EQUITY', allocation: 'EQUITY', rateKey: 'EQUITY_US',
    holdingCount: 1, marketValueLocal: 100, marketValue: 100,
    costBasisLocal: 80, costBasis: 80, inferred: false,
    ...over,
  };
}

/** A sampler record for one year, with its tie-out already computed. */
function sample(year, rows, over = {}) {
  const at = new Date(Date.UTC(year, 11, 31));
  const stamped = rows.map(r => ({ ...r, date: at }));
  const cubeTotal = stamped.reduce((s, r) => s + r.marketValue, 0);
  return {
    at, year, rows: stamped,
    cubeTotal, netWorth: cubeTotal, delta: 0, inferred: 0, reconciled: 0,
    ...over,
  };
}

/** The share the legend strip reports for one category. */
function shareOf(plugin, key) {
  return plugin.el.querySelector(`[data-alloc-key="${key}"] strong`).textContent;
}

/**
 * Drive the class scope through the shared MapFilterMultiSelect the way a reader does:
 * focus the input to open it, then click the rows. Its list is fetched asynchronously
 * over two rAFs, so opening is awaited rather than assumed.
 */
async function openClassSelect(plugin) {
  const host = plugin.el.querySelector('[data-alloc="class"]');
  host.querySelector('.multi-select-input').dispatchEvent(new Event('focus'));
  const ms = plugin._classSelect;
  await new Promise(r => setTimeout(r, 0));
  await ms._fetchPage(true);
  ms._renderVisible();
  return ms;
}

async function classOptions(plugin) {
  const ms = await openClassSelect(plugin);
  return [...ms._list.querySelectorAll('.multi-select-item')].map(el => el.dataset.id);
}

/**
 * Toggle the scope until exactly `wanted` is selected. The list is re-queried after every
 * click: each toggle redraws it, so a captured element is detached by the next iteration.
 */
async function pickClasses(plugin, wanted) {
  const ms = await openClassSelect(plugin);
  const want = new Set(wanted);
  const ids = [...ms._list.querySelectorAll('.multi-select-item')].map(el => el.dataset.id);
  for (const id of ids) {
    if (plugin._assetClasses.has(id) === want.has(id)) continue;
    ms._list.querySelector(`.multi-select-item[data-id="${id}"]`).click();
  }
}

function mountPlugin(samples) {
  const plugin = new AllocationPlugin(RUNTIME);
  plugin.setServices({ schemaRegistry: { formatAmount: (n) => `$${Math.round(n)}` } });
  plugin._sim = { samples, currentDate: new Date(Date.UTC(2030, 11, 31)), bus: null };
  const container = document.createElement('div');
  document.body.appendChild(container);
  plugin.mount(container);
  return { plugin, container };
}

const TWO_YEARS = [
  sample(2029, [row({ marketValue: 60 }), row({ stateKey: 'auHouseProperty', name: 'AU House', kind: 'real-property', assetClass: 'REAL_ESTATE', allocation: null, rateKey: null, role: null, type: null, domicileCountry: 'AU', exposureCountry: 'AU', marketValue: 40 })]),
  sample(2030, [row({ marketValue: 20 }), row({ stateKey: 'auHouseProperty', name: 'AU House', kind: 'real-property', assetClass: 'REAL_ESTATE', allocation: null, rateKey: null, role: null, type: null, domicileCountry: 'AU', exposureCountry: 'AU', marketValue: 80 })]),
];

test('with no samples the panel says so instead of drawing an empty chart', () => {
  const { plugin } = mountPlugin([]);
  const placeholder = plugin.el.querySelector('[data-alloc="placeholder"]');
  assert.equal(placeholder.style.display, '');
  assert.match(placeholder.textContent, /Step or run the simulation/);
  assert.equal(plugin.el.querySelector('[data-alloc="provenance"]').innerHTML, '');
  plugin.unmount();
});

test('a tie-out failure is stated loudly and warns off quoting the shares', () => {
  const broken = [
    sample(2029, [row()]),
    // The cube total no longer decomposes net worth — a class is missing.
    sample(2030, [row()], { netWorth: 100_000, delta: -99_900 }),
  ];
  const { plugin } = mountPlugin(broken);

  const prov = plugin.el.querySelector('[data-alloc="provenance"]');
  assert.ok(prov.className.includes('alloc-provenance--bad'), 'must carry the alarm class');
  assert.match(prov.textContent, /Does not tie out/);
  assert.match(prov.textContent, /2030/, 'names the year so it can be found');
  assert.match(prov.textContent, /Do not quote/);
  plugin.unmount();
});

test('a clean run reports the tie-out, and flags a sample that is not a year-end', () => {
  const withHorizon = [
    sample(2029, [row()]),
    // The terminal flush at a mid-year simEnd (design 82 §5.2).
    { ...sample(2030, [row()]), at: new Date(Date.UTC(2030, 5, 30)) },
  ];
  const { plugin } = mountPlugin(withHorizon);
  const prov = plugin.el.querySelector('[data-alloc="provenance"]');

  assert.ok(!prov.className.includes('--bad'));
  assert.match(prov.textContent, /ties to net worth/);
  assert.match(prov.textContent, /2030-06-30 is a partial year, not a year-end/);
  plugin.unmount();
});

test('the mix strip doubles as the legend: chart order, shares from the latest sample', () => {
  const { plugin } = mountPlugin(TWO_YEARS);
  const items = [...plugin.el.querySelectorAll('.alloc-mix-item')].map(el => el.textContent.trim());

  // Canonical asset-class order (the order of the bands), NOT sorted by size — a legend
  // that runs in a different order than the chart is harder to read than one that does.
  assert.match(items[0], /EQUITY\s+20\.0%/);
  assert.match(items[1], /REAL_ESTATE\s+80\.0%/);
  // Shares are of the LATEST sample (2030 is 80/20 house-heavy), not of the whole table.
  assert.equal(plugin.el.querySelector('.alloc-mix-label').textContent, '2030');
  plugin.unmount();
});

test('switching a legend chip off recomputes the shares over what is left', () => {
  // The whole point of the interaction, and the reason it is a row filter rather than an
  // ECharts legendUnSelect: hiding a band would leave it in the denominator, so the
  // survivors would stop summing to 100% and stop being shares of anything nameable.
  const three = [
    sample(2029, [row({ marketValue: 50 }), row({ stateKey: 'bondAccount', name: 'Bonds', assetClass: 'BOND', allocation: 'BOND', rateKey: 'FIXED_INCOME_US', marketValue: 30 }), row({ stateKey: 'cashAccount', name: 'Cash', assetClass: 'CASH', allocation: 'CASH', rateKey: 'SAVINGS_US', marketValue: 20 })]),
    sample(2030, [row({ marketValue: 50 }), row({ stateKey: 'bondAccount', name: 'Bonds', assetClass: 'BOND', allocation: 'BOND', rateKey: 'FIXED_INCOME_US', marketValue: 30 }), row({ stateKey: 'cashAccount', name: 'Cash', assetClass: 'CASH', allocation: 'CASH', rateKey: 'SAVINGS_US', marketValue: 20 })]),
  ];
  const { plugin } = mountPlugin(three);
  const shareOf = (key) =>
    plugin.el.querySelector(`[data-alloc-key="${key}"] strong`).textContent;

  assert.equal(shareOf('EQUITY'), '50.0%');

  plugin.el.querySelector('[data-alloc-key="CASH"]').click();
  assert.ok(plugin._hidden.has('CASH'));
  // 50 and 30 of the remaining 80 — NOT 50% and 30% of a total that still counts cash.
  assert.equal(shareOf('EQUITY'), '62.5%');
  assert.equal(shareOf('BOND'), '37.5%');
  // The switched-off category stays listed (or it could never be switched back on),
  // struck through and at zero, and the strip says the shares are of a subset.
  assert.equal(shareOf('CASH'), '0.0%');
  assert.ok(plugin.el.querySelector('[data-alloc-key="CASH"]').className.includes('alloc-mix-item--off'));
  assert.match(plugin.el.querySelector('.alloc-mix-filtered').textContent, /2 of 3/);

  plugin.el.querySelector('[data-alloc-key="CASH"]').click();
  assert.ok(!plugin._hidden.has('CASH'));
  assert.equal(shareOf('EQUITY'), '50.0%');
  assert.equal(plugin.el.querySelector('.alloc-mix-filtered'), null);
  plugin.unmount();
});

test('the legend selection is dropped when the keyspace moves under it', () => {
  // `EQUITY` in the total view, `US · EQUITY` in the country view, an account name in the
  // account view. A carried-over key filters the wrong thing, or silently nothing.
  const { plugin } = mountPlugin(TWO_YEARS);
  plugin.el.querySelector('[data-alloc-key="EQUITY"]').click();
  assert.ok(plugin._hidden.has('EQUITY'));

  const view = plugin.el.querySelector('[data-alloc="view"]');
  view.value = 'domicile';
  view.dispatchEvent(new Event('change'));
  assert.equal(plugin._hidden.size, 0);
  plugin.unmount();
});

test('the class scope narrows every view — "where does this class live"', async () => {
  const at = new Date(Date.UTC(2030, 11, 31));
  const rows = [
    row({ stateKey: 'usStockAccount', name: 'US Brokerage', marketValue: 60 }),
    row({ stateKey: 'iraAccount', name: 'IRA', marketValue: 40 }),
    row({ stateKey: 'iraAccount', name: 'IRA', assetClass: 'BOND', allocation: 'BOND',
          rateKey: 'FIXED_INCOME_US', marketValue: 400 }),
    row({ stateKey: 'goldAccount', name: 'Gold', assetClass: 'GOLD', allocation: 'GOLD',
          rateKey: 'GOLD', marketValue: 10 }),
  ].map(r => ({ ...r, date: at }));
  const { plugin } = mountPlugin([sample(2029, rows), sample(2030, rows)]);

  assert.deepEqual(await classOptions(plugin), ['EQUITY', 'BOND', 'GOLD']);

  plugin._view = 'account';
  plugin._syncControls();
  await pickClasses(plugin, ['EQUITY']);

  // The IRA's 400 of bonds is out of scope, so the accounts are weighed on their EQUITY
  // alone: 60/40, not 60/440.
  assert.equal(shareOf(plugin, 'US Brokerage'), '60.0%');
  assert.equal(shareOf(plugin, 'IRA'), '40.0%');

  // More than one class at a time — the whole reason this is a multi-select. Gold is
  // held only in the third account, which is now back on the chart.
  await pickClasses(plugin, ['EQUITY', 'GOLD']);
  assert.deepEqual([...plugin._assetClasses].sort(), ['EQUITY', 'GOLD']);
  assert.equal(shareOf(plugin, 'Gold'), '9.1%');   // 10 of 110

  // Deselecting back to nothing means every class again, not an empty panel.
  await pickClasses(plugin, []);
  assert.equal(plugin._assetClasses.size, 0);
  assert.equal(shareOf(plugin, 'IRA'), '86.3%');   // 440 of 510
  plugin.unmount();
});

test('the class scope re-states itself in its own control', async () => {
  // The base component's input is a search box: the selection lives only as ticks inside
  // a dropdown that is shut. A toolbar control reading "Select..." while filtering out
  // three quarters of the book is a chart nobody can trust.
  const { plugin } = mountPlugin(TWO_YEARS);
  const input = () => plugin.el.querySelector('[data-alloc="class"] .multi-select-input');
  assert.equal(input().placeholder, 'all classes');

  await pickClasses(plugin, ['EQUITY']);
  assert.equal(input().placeholder, 'EQUITY');
  plugin.unmount();
});

test('a class that leaves the book cannot leave the panel scoped to it', async () => {
  // The last gold is sold. A scope pinned to something no longer held is a permanently
  // blank chart with no visible cause.
  const gold = row({ stateKey: 'goldAccount', name: 'Gold', assetClass: 'GOLD',
                     allocation: 'GOLD', rateKey: 'GOLD', marketValue: 10 });
  const samples = [sample(2029, [row(), gold]), sample(2030, [row(), gold])];
  const { plugin } = mountPlugin(samples);
  await pickClasses(plugin, ['GOLD']);
  assert.ok(plugin._assetClasses.has('GOLD'));

  samples[1] = sample(2030, [row()]);
  samples[0] = sample(2029, [row()]);
  plugin._render();
  assert.equal(plugin._assetClasses.size, 0, 'the scope falls back to every class');
  plugin.unmount();
});

test('the class scope hides itself in the target view', () => {
  const { plugin } = mountPlugin(TWO_YEARS);
  plugin._view = 'target';
  plugin._syncControls();
  assert.equal(plugin.el.querySelector('[data-alloc="class"]').style.display, 'none');
  plugin._view = 'account';
  plugin._syncControls();
  assert.equal(plugin.el.querySelector('[data-alloc="class"]').style.display, '');
  plugin.unmount();
});

test('a freshly loaded scenario shows its opening mix, before any step', async () => {
  // The opening state is a real, answerable question, and the run cannot answer it: the
  // first sample is only written once the clock has moved. A panel that met a loaded
  // scenario with "step the simulation" was refusing to show a picture it already had.
  const state = {
    brokerage: {
      stateKey: 'brokerage', type: 'brokerage', role: 'us-stock', country: 'US',
      currency: { code: 'USD' }, balance: 100,
      holdings: [
        { allocation: 'EQUITY', marketValue: 70, costBasis: 50, rateKey: 'EQUITY_US' },
        { allocation: 'BOND',   marketValue: 30, costBasis: 30, rateKey: 'FIXED_INCOME_US' },
      ],
    },
  };
  const sim = { samples: [], state, currentDate: new Date(Date.UTC(2026, 0, 1)),
                eventExecutions: 0, bus: null };
  const plugin = new AllocationPlugin(RUNTIME);
  plugin.setServices({ schemaRegistry: { formatAmount: (n) => `$${Math.round(n)}` } });
  plugin._sim = sim;
  const container = document.createElement('div');
  document.body.appendChild(container);
  plugin.mount(container);

  assert.equal(plugin.el.querySelector('[data-alloc="placeholder"]').style.display, 'none');
  assert.ok(plugin._isLive, 'reading live state, not sim.samples');
  assert.equal(plugin.el.querySelector('[data-alloc="asof"]').textContent, '2026 · opening state');
  assert.equal(shareOf(plugin, 'EQUITY'), '70.0%');

  // One record, so it draws as a doughnut — no time axis to put it on yet.
  const built = buildAllocationSeries(plugin._rows(), plugin._seriesOpts());
  assert.equal(built.dates.length, 1);
  assert.equal(plugin._donutOption(built).series[0].type, 'pie');

  // The opening state is not a "partial year" — that caveat belongs to a mid-year
  // horizon flush, and putting it here would caveat the one reading that needs none.
  const prov = plugin.el.querySelector('[data-alloc="provenance"]').textContent;
  assert.match(prov, /the plan before its first step/);
  assert.doesNotMatch(prov, /partial year/);

  // And the live reading is dropped the moment the run files a sample of its own.
  sim.samples = [sample(2026, [row({ marketValue: 100 })])];
  plugin._render();
  assert.equal(plugin._isLive, false);
  assert.equal(plugin._live, null);
  plugin.unmount();
});

test('one sample is a doughnut — a time series of one point is the wrong chart', () => {
  // A stacked area over a single date draws nothing at all, which is why the panel read
  // as broken for a plan's whole first year. The reader's question at that moment ("what
  // is the mix right now") is perfectly answerable; it just has no time axis in it yet.
  const at = new Date(Date.UTC(2030, 11, 31));
  const rows = [
    row({ marketValue: 70 }),
    row({ stateKey: 'bondAccount', name: 'Bonds', assetClass: 'BOND', allocation: 'BOND',
          rateKey: 'FIXED_INCOME_US', marketValue: 30 }),
  ].map(r => ({ ...r, date: at }));
  const { plugin } = mountPlugin([sample(2030, rows)]);

  const one = buildAllocationSeries(plugin._rows(), plugin._seriesOpts());
  assert.equal(one.dates.length, 1);
  const donut = plugin._donutOption(one);
  assert.equal(donut.series[0].type, 'pie');
  assert.deepEqual(donut.series[0].data.map(d => d.name), ['EQUITY', 'BOND']);
  // Canonical order, the same order the legend strip and the eventual bands run in.
  assert.equal(donut.title.text, '2030');

  // And it switches to the time series on its own the moment a second sample lands.
  const { plugin: two } = mountPlugin([sample(2029, rows), sample(2030, rows)]);
  const series = buildAllocationSeries(two._rows(), two._seriesOpts());
  assert.equal(two._option(series).series[0].type, 'line');
  plugin.unmount();
  two.unmount();
});

test('the doughnut refuses to draw a negative slice, and says how many it dropped', () => {
  // The only way to get here with one is the total view's `with debt` decomposition, and
  // a pie cannot render it. Dropping it silently would leave a mix that does not add up.
  const at = new Date(Date.UTC(2030, 11, 31));
  const rows = [
    row({ marketValue: 100 }),
    row({ stateKey: 'auHouseLoan', name: 'AU Loan', type: 'loan', assetClass: 'LIABILITY',
          allocation: null, rateKey: null, marketValue: -40 }),
  ].map(r => ({ ...r, date: at }));
  const { plugin } = mountPlugin([sample(2030, rows)]);
  plugin._withDebt = true;

  const one = buildAllocationSeries(plugin._rows(), plugin._seriesOpts());
  const donut = plugin._donutOption(one);
  assert.deepEqual(donut.series[0].data.map(d => d.name), ['EQUITY']);
  assert.match(donut.title.subtext, /1 negative slice not drawn/);
  plugin.unmount();
});

test('a two-point series draws its marks — a hairline has no value to read off', () => {
  const { plugin } = mountPlugin([sample(2029, [row()]), sample(2030, [row()])]);
  const two = buildAllocationSeries(plugin._rows(), plugin._seriesOpts());
  assert.equal(two.dates.length, 2);
  assert.ok(plugin._option(two).series.every(sr => sr.showSymbol === true));

  const { plugin: long } = mountPlugin([
    sample(2028, [row()]), sample(2029, [row()]), sample(2030, [row()]),
  ]);
  const many = buildAllocationSeries(long._rows(), long._seriesOpts());
  assert.ok(long._option(many).series.every(sr => sr.showSymbol === false));
  plugin.unmount();
  long.unmount();
});

test('switching the view changes the grouping, not the fact table', () => {
  const { plugin } = mountPlugin(TWO_YEARS);

  // Total: grouped by asset class.
  assert.deepEqual(Object.keys(plugin._seriesOpts()), ['normalize', 'excludeLiabilities']);

  plugin._view = 'domicile';
  assert.deepEqual(plugin._seriesOpts().by, ['domicileCountry', 'assetClass']);

  plugin._view = 'rateKey';
  const rateOpts = plugin._seriesOpts();
  assert.deepEqual(rateOpts.by, ['rateKey']);
  // A house has no return series; including it would bury the diagnostic under one
  // enormous "(none)" band.
  assert.equal(rateOpts.filter({ rateKey: null }), false);
  assert.equal(rateOpts.filter({ rateKey: 'EQUITY_US' }), true);

  // design 94 step 9 — the one view that answers "what do I actually OWN", as against
  // "what market am I exposed to". Filtered like `rateKey`, and for the same reason: a
  // house, a company stake and a cash sleeve name no instrument.
  plugin._view = 'security';
  const secOpts = plugin._seriesOpts();
  assert.deepEqual(secOpts.by, ['security']);
  assert.equal(secOpts.filter({ securityId: null }), false);
  assert.equal(secOpts.filter({ securityId: 'sec-emp' }), true);

  plugin._view = 'account';
  plugin._stateKey = 'usStockAccount';
  assert.equal(plugin._seriesOpts().filter({ stateKey: 'usStockAccount' }), true);
  assert.equal(plugin._seriesOpts().filter({ stateKey: 'auHouseProperty' }), false);
  plugin.unmount();
});

test('the security view separates two instruments that share one market', () => {
  // The whole point of the column: `rateKey` puts an employer stake and an index fund in
  // one band because they track the same market, and concentration — the risk an
  // allocation view exists to show — is invisible in that band.
  const at   = new Date(Date.UTC(2030, 11, 31));
  const rows = [
    row({ securityId: 'sec-emp', security: 'EMP',  marketValue: 400 }),
    row({ securityId: 'sec-idx', security: 'VTI',  marketValue: 600 }),
    row({ stateKey: 'auHouseProperty', assetClass: 'REAL_ESTATE', rateKey: null,
          securityId: null, security: null, marketValue: 900 }),
  ].map(r => ({ ...r, date: at }));

  const { plugin } = mountPlugin([sample(2030, rows)]);
  plugin._view = 'security';
  const series = buildAllocationSeries(plugin._rows(), plugin._seriesOpts());
  assert.deepEqual(series.keys.slice().sort(), ['EMP', 'VTI']);
  // The house is filtered out rather than collapsed into a `(none)` band that would
  // dwarf both instruments.
  assert.ok(!series.keys.includes('(none)'));
  plugin.unmount();
});

test('the CSV carries the security columns — the fact table is what gets re-checked', () => {
  const { plugin } = mountPlugin(TWO_YEARS);
  // The panel downloads the whole cube, not the drawn series, precisely so a number can
  // be traced back to the lot it came from. A column missing here is a number nobody can
  // chase.
  for (const c of ['securityId', 'security', 'units']) {
    assert.ok(ALLOCATION_CSV_COLUMNS.includes(c), `missing ${c}`);
  }
  plugin.unmount();
});

test('the account picker lists accounts only, and offers "all"', () => {
  const { plugin } = mountPlugin(TWO_YEARS);
  plugin._view = 'account';
  plugin._syncControls();
  plugin._render();

  const values = [...plugin.el.querySelectorAll('[data-alloc="account"] option')].map(o => o.value);
  assert.equal(values[0], '__all__');
  assert.ok(values.includes('usStockAccount'));
  // A property is not an account — it belongs to the total, not the per-account picker.
  assert.ok(!values.includes('auHouseProperty'));
  plugin.unmount();
});

test('the row cache rebuilds when the last sample is upserted, not only when one is added', () => {
  // The final sample is replaced on every stepTo (design 82 §5.1b keeps a partial year
  // current), so a signature based on count alone would freeze the most-changing point
  // on the chart.
  const samples = [sample(2029, [row()]), sample(2030, [row({ marketValue: 20 })])];
  const { plugin } = mountPlugin(samples);
  const firstSig = plugin._signature();
  assert.equal(plugin._rows().length, 2);

  samples[1] = sample(2030, [row({ marketValue: 20 }), row({ stateKey: 'iraAccount', name: 'IRA', marketValue: 5 })]);
  assert.notEqual(plugin._signature(), firstSig, 'an upsert must change the signature');
  assert.equal(plugin._rows().length, 3, 'and the rows must be rebuilt');
  plugin.unmount();
});

test('a sim built without the allocation sampler renders empty rather than throwing', () => {
  // Monte Carlo and the optimizer install their own samplers whose records carry no
  // `rows`; the panel must treat those as no data.
  const { plugin } = mountPlugin([{ date: new Date(), netWorthUsd: 1_000_000 }]);
  assert.equal(plugin._samples().length, 0);
  assert.equal(plugin.el.querySelector('[data-alloc="placeholder"]').style.display, '');
  plugin.unmount();
});

// ─── Target vs actual (design 82 §7) ──────────────────────────────────────────
//
// The overlay's one real hazard is the COMPARISON SET. A target exists only for the
// accounts the rebalancer manages, so a view that measures it against a book which also
// holds a house reports a "drift" that is really two different questions side by side.
// These pin that both sides are filtered to the targeted accounts, and that the absence
// of a target is reported as such rather than drawn as zero drift.

/** A target row as the sampler records it: weight × the account's holdings total. */
function targetRow(over = {}) {
  return {
    date: new Date(Date.UTC(2030, 11, 31)),
    stateKey: 'usStockAccount', name: 'US Brokerage', source: 'target',
    kind: 'account', role: 'brokerage', type: 'us-stock',
    domicileCountry: 'US', exposureCountry: 'US', currency: 'USD',
    assetClass: 'EQUITY', allocation: 'EQUITY', rateKey: null, holdingCount: 0,
    targetWeight: 1, band: 0.1,
    marketValueLocal: 100, marketValue: 100, costBasisLocal: null, costBasis: null,
    inferred: false, ...over,
  };
}

function targetSample(year, rows, targetRows) {
  return { ...sample(year, rows), targetRows: targetRows.map(r => ({ ...r, date: new Date(Date.UTC(year, 11, 31)) })) };
}

test('target view compares only the targeted accounts — the house cannot enter it', () => {
  const house = { stateKey: 'auHouseProperty', name: 'AU House', kind: 'real-property',
    assetClass: 'REAL_ESTATE', allocation: null, rateKey: null, role: null, type: null,
    domicileCountry: 'AU', exposureCountry: 'AU' };
  const samples = [
    targetSample(2030,
      [row({ marketValue: 60 }), row({ ...house, marketValue: 940 })],
      // 60/40 target over the ONE targeted account (the brokerage, $60).
      [targetRow({ marketValue: 36, targetWeight: 0.6 }),
       targetRow({ assetClass: 'BOND', allocation: 'BOND', marketValue: 24, targetWeight: 0.4 })]),
  ];
  const { plugin } = mountPlugin(samples);
  plugin._view = 'target';
  plugin._syncControls();
  plugin._render();

  const { realized, target, targeted } = plugin._targetView();
  assert.deepEqual([...targeted], ['usStockAccount']);
  // Realized is 100% equity of the TARGETED book — not 6% of a house-heavy total.
  assert.equal(realized.keys.join(), 'EQUITY');
  assert.equal(+realized.series.EQUITY[0].toFixed(3), 1);
  assert.deepEqual(target.keys, ['EQUITY', 'BOND']);
  assert.equal(+target.series.BOND[0].toFixed(3), 0.4);

  // Drift is stated against that set, and the 40-point bond gap breaches the ±10% band.
  const strip = plugin.el.querySelector('[data-alloc="mixbar"]').textContent;
  assert.match(strip, /2030 vs target/);
  assert.match(strip, /1 targeted account/);
  assert.match(strip, /band ±10\.0%/);
  // BOTH sides of the gap breach: 40 points over-weight in equity IS 40 points
  // under-weight in bonds, and flagging only one of them would hide half the story.
  const breaches = [...plugin.el.querySelectorAll('.alloc-mix-item--breach')]
    .map(e => e.textContent.trim().replace(/\s+/g, ' '));
  assert.deepEqual(breaches.map(t => t.split(' ')[0]).sort(), ['BOND', 'EQUITY']);
  assert.ok(breaches.some(t => t.includes('+40.0')), 'equity over-weight is signed +');
  assert.ok(breaches.some(t => t.includes('−40.0')), 'bond under-weight is signed −');
  plugin.unmount();
});

test('no target anywhere says so instead of drawing zero drift', () => {
  const { plugin } = mountPlugin([targetSample(2030, [row()], [])]);
  plugin._view = 'target';
  plugin._render();

  const placeholder = plugin.el.querySelector('[data-alloc="placeholder"]');
  assert.equal(placeholder.style.display, '');
  assert.match(placeholder.textContent, /No account carries a target composition/);
  assert.equal(plugin.el.querySelector('[data-alloc="mixbar"]').innerHTML, '');
  plugin.unmount();
});

test('picking an account with no target explains that, rather than showing an empty chart', () => {
  const samples = [targetSample(2030, [row(), row({ stateKey: 'iraAccount', name: 'IRA' })],
    [targetRow()])];
  const { plugin } = mountPlugin(samples);
  plugin._view = 'target';
  plugin._stateKey = 'iraAccount';
  plugin._render();

  assert.match(plugin.el.querySelector('[data-alloc="placeholder"]').textContent,
    /This account carries no target composition/);
  plugin.unmount();
});

test('a target that starts mid-run is aligned by date, never by index', () => {
  // Index-aligning tables with different date coverage slides the target sideways and
  // invents drift; a null leaves an honest gap where there was no target.
  const samples = [
    targetSample(2029, [row()], []),                 // no target yet
    targetSample(2030, [row()], [targetRow()]),
  ];
  const { plugin } = mountPlugin(samples);
  plugin._view = 'target';
  const { realized, target } = plugin._targetView();
  const aligned = plugin._alignTo(realized.dates, target);

  assert.equal(realized.dates.length, 2);
  assert.equal(aligned.EQUITY[0], null, 'no target in 2029');
  assert.equal(+aligned.EQUITY[1].toFixed(3), 1);
  plugin.unmount();
});
