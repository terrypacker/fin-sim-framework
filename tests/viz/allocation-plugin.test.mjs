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
import { AllocationPlugin } from '../../src/visualization/workbench/plugins/finance/allocation-plugin.js';

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

test('clicking a legend chip hides that band, and clicking again restores it', () => {
  const { plugin } = mountPlugin(TWO_YEARS);
  const chip = () => plugin.el.querySelector('[data-alloc-key="EQUITY"]');

  chip().click();
  assert.ok(plugin._hidden.has('EQUITY'));
  assert.ok(chip().className.includes('alloc-mix-item--off'));

  chip().click();
  assert.ok(!plugin._hidden.has('EQUITY'));
  assert.ok(!chip().className.includes('alloc-mix-item--off'));
  plugin.unmount();
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

  plugin._view = 'account';
  plugin._stateKey = 'usStockAccount';
  assert.equal(plugin._seriesOpts().filter({ stateKey: 'usStockAccount' }), true);
  assert.equal(plugin._seriesOpts().filter({ stateKey: 'auHouseProperty' }), false);
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
