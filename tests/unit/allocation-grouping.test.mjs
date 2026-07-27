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
 * allocation-grouping.test.mjs — the pivot from allocation fact rows to chart series.
 *
 * The load-bearing properties are alignment (every series is as long as `dates`, with
 * real zeros rather than holes), stable key order (a legend colour must not move when
 * a class empties), and that the same rows produce the three requested views purely by
 * changing `by`.
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import { buildAllocationSeries, mixAt, groupKey, NO_VALUE }
  from '../../src/finance/allocation-reporting/allocation-grouping.js';
import { ASSET_CLASS } from '../../src/finance/allocation-reporting/asset-class.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

/** A minimal cube row. */
const R = (date, assetClass, marketValue, extra = {}) => ({
  date: new Date(date),
  assetClass,
  marketValue,
  stateKey:        extra.stateKey        ?? 'brokerage',
  domicileCountry: extra.domicileCountry ?? 'US',
  exposureCountry: extra.exposureCountry ?? 'US',
  rateKey:         extra.rateKey         ?? null,
  ...extra,
});

/** Two dates, two classes, one country — the smallest useful cube. */
const SIMPLE = [
  R('2030-12-31', ASSET_CLASS.EQUITY, 600),
  R('2030-12-31', ASSET_CLASS.BOND,   400),
  R('2031-12-31', ASSET_CLASS.EQUITY, 800),
  R('2031-12-31', ASSET_CLASS.BOND,   200),
];

// ── Shape and alignment ─────────────────────────────────────────────────────

test('buildAllocationSeries: tolerates empty input', () => {
  for (const input of [null, undefined, []]) {
    assert.deepEqual(buildAllocationSeries(input), { dates: [], keys: [], series: {}, totals: [] });
  }
});

test('buildAllocationSeries: pivots to aligned series with column totals', () => {
  const { dates, keys, series, totals } = buildAllocationSeries(SIMPLE);

  assert.equal(dates.length, 2);
  assert.deepEqual(keys, [ASSET_CLASS.EQUITY, ASSET_CLASS.BOND]);
  assert.deepEqual(series[ASSET_CLASS.EQUITY], [600, 800]);
  assert.deepEqual(series[ASSET_CLASS.BOND],   [400, 200]);
  assert.deepEqual(totals, [1000, 1000]);
});

test('buildAllocationSeries: a key absent at a date is 0, never a hole', () => {
  // A consumer that has to distinguish undefined from 0 will get it wrong somewhere;
  // gaps in a stacked area are drawn as chasms.
  const rows = [
    R('2030-12-31', ASSET_CLASS.EQUITY, 600),
    R('2031-12-31', ASSET_CLASS.EQUITY, 500),
    R('2031-12-31', ASSET_CLASS.GOLD,   100),
  ];
  const { series } = buildAllocationSeries(rows);

  assert.deepEqual(series[ASSET_CLASS.GOLD], [0, 100]);
  for (const key of Object.keys(series)) {
    assert.equal(series[key].length, 2);
    assert.ok(series[key].every(Number.isFinite));
  }
});

test('buildAllocationSeries: sorts dates chronologically regardless of row order', () => {
  const shuffled = [SIMPLE[2], SIMPLE[1], SIMPLE[3], SIMPLE[0]];
  const { dates, series } = buildAllocationSeries(shuffled);

  assert.ok(dates[0] < dates[1]);
  assert.deepEqual(series[ASSET_CLASS.EQUITY], [600, 800]);
});

test('buildAllocationSeries: collapses several rows at one date into one point', () => {
  // The cube emits one row per (account, allocation, rateKey); the total view must
  // fold every account's EQUITY into a single band.
  const rows = [
    R('2030-12-31', ASSET_CLASS.EQUITY, 100, { stateKey: 'brokerage' }),
    R('2030-12-31', ASSET_CLASS.EQUITY, 250, { stateKey: 'roth' }),
    R('2030-12-31', ASSET_CLASS.EQUITY,  50, { stateKey: 'superFund' }),
  ];
  const { dates, series } = buildAllocationSeries(rows);

  assert.equal(dates.length, 1);
  assert.deepEqual(series[ASSET_CLASS.EQUITY], [400]);
});

// ── Stable ordering ─────────────────────────────────────────────────────────

test('buildAllocationSeries: assetClass keeps its canonical order, not magnitude order', () => {
  // Ordering by size would reshuffle the legend the moment BOND overtakes EQUITY,
  // silently swapping two colours mid-report.
  const rows = [
    R('2030-12-31', ASSET_CLASS.BOND,   900),
    R('2030-12-31', ASSET_CLASS.EQUITY, 100),
    R('2030-12-31', ASSET_CLASS.CASH,   500),
  ];
  const { keys } = buildAllocationSeries(rows);
  assert.deepEqual(keys, [ASSET_CLASS.EQUITY, ASSET_CLASS.BOND, ASSET_CLASS.CASH]);
});

test('buildAllocationSeries: a non-canonical dimension orders by total, then alphabetically', () => {
  const rows = [
    R('2030-12-31', ASSET_CLASS.EQUITY, 100, { stateKey: 'zed' }),
    R('2030-12-31', ASSET_CLASS.EQUITY, 900, { stateKey: 'mid' }),
    R('2030-12-31', ASSET_CLASS.EQUITY, 100, { stateKey: 'abe' }),
  ];
  const { keys } = buildAllocationSeries(rows, { by: ['stateKey'] });
  assert.deepEqual(keys, ['mid', 'abe', 'zed']);
});

test('buildAllocationSeries: dropEmpty removes all-zero series but can be kept', () => {
  const rows = [
    R('2030-12-31', ASSET_CLASS.EQUITY, 100),
    R('2030-12-31', ASSET_CLASS.GOLD,     0),
  ];
  assert.deepEqual(buildAllocationSeries(rows).keys, [ASSET_CLASS.EQUITY]);
  assert.deepEqual(buildAllocationSeries(rows, { dropEmpty: false }).keys,
    [ASSET_CLASS.EQUITY, ASSET_CLASS.GOLD]);
});

// ── The three requested views, from one table ───────────────────────────────

test('buildAllocationSeries: the three views differ only by `by` / `filter`', () => {
  const rows = [
    R('2030-12-31', ASSET_CLASS.EQUITY, 600, { stateKey: 'brokerage', domicileCountry: 'US' }),
    R('2030-12-31', ASSET_CLASS.BOND,   400, { stateKey: 'brokerage', domicileCountry: 'US' }),
    R('2030-12-31', ASSET_CLASS.EQUITY, 300, { stateKey: 'superFund', domicileCountry: 'AU' }),
  ];

  // total
  const totalView = buildAllocationSeries(rows);
  assert.deepEqual(totalView.series[ASSET_CLASS.EQUITY], [900]);

  // per country
  const countryView = buildAllocationSeries(rows, { by: ['domicileCountry', 'assetClass'] });
  assert.deepEqual(countryView.series['US · EQUITY'], [600]);
  assert.deepEqual(countryView.series['AU · EQUITY'], [300]);

  // per account
  const accountView = buildAllocationSeries(rows, { filter: r => r.stateKey === 'brokerage' });
  assert.deepEqual(accountView.series[ASSET_CLASS.EQUITY], [600]);
  assert.equal(accountView.keys.length, 2);
});

test('buildAllocationSeries: domicile and exposure give different country pictures', () => {
  // The AU sleeve inside the US wrapper — the whole reason both columns exist.
  const rows = [
    R('2030-12-31', ASSET_CLASS.EQUITY, 1000, { domicileCountry: 'US', exposureCountry: 'AU' }),
  ];
  assert.deepEqual(Object.keys(buildAllocationSeries(rows, { by: ['domicileCountry'] }).series), ['US']);
  assert.deepEqual(Object.keys(buildAllocationSeries(rows, { by: ['exposureCountry'] }).series), ['AU']);
});

test('groupKey / buildAllocationSeries: a null dimension is labelled, never merged silently', () => {
  const rows = [
    R('2030-12-31', ASSET_CLASS.GOLD, 100, { exposureCountry: null }),
    R('2030-12-31', ASSET_CLASS.EQUITY, 400, { exposureCountry: 'US' }),
  ];
  assert.equal(groupKey({ exposureCountry: null }, ['exposureCountry']), NO_VALUE);
  const { series } = buildAllocationSeries(rows, { by: ['exposureCountry'] });
  assert.deepEqual(series[NO_VALUE], [100]);
});

// ── Liabilities and normalization ───────────────────────────────────────────

test('buildAllocationSeries: liabilities are excluded from a mix by default', () => {
  const rows = [
    R('2030-12-31', ASSET_CLASS.REAL_ESTATE,  900_000),
    R('2030-12-31', ASSET_CLASS.LIABILITY,   -400_000),
  ];

  const mix = buildAllocationSeries(rows);
  assert.deepEqual(mix.keys, [ASSET_CLASS.REAL_ESTATE]);
  assert.deepEqual(mix.totals, [900_000], 'a mix is of GROSS assets');

  const net = buildAllocationSeries(rows, { excludeLiabilities: false });
  assert.deepEqual(net.totals, [500_000], 'opting in gives the net-worth decomposition');
});

test('buildAllocationSeries: normalize emits shares that sum to 1 per date', () => {
  const { series, totals } = buildAllocationSeries(SIMPLE, { normalize: true });

  assert.deepEqual(series[ASSET_CLASS.EQUITY], [0.6, 0.8]);
  assert.deepEqual(series[ASSET_CLASS.BOND],   [0.4, 0.2]);
  for (let i = 0; i < totals.length; i++) {
    const column = Object.keys(series).reduce((s, k) => s + series[k][i], 0);
    assert.ok(Math.abs(column - 1) < 1e-9);
  }
  assert.deepEqual(totals, [1000, 1000], 'totals stay ABSOLUTE so the $ figure survives');
});

test('buildAllocationSeries: a zero column normalizes to 0, not NaN', () => {
  // Everything sold, or before the plan funds — a real state, and exactly the moment
  // worth looking at. A NaN would punch a hole in the chart right there.
  const rows = [
    R('2030-12-31', ASSET_CLASS.EQUITY, 100),
    R('2031-12-31', ASSET_CLASS.EQUITY,   0),
  ];
  const { series } = buildAllocationSeries(rows, { normalize: true, dropEmpty: false });
  assert.deepEqual(series[ASSET_CLASS.EQUITY], [1, 0]);
});

// ── mixAt ───────────────────────────────────────────────────────────────────

test('mixAt: returns the latest date by default', () => {
  assert.deepEqual(mixAt(SIMPLE), { [ASSET_CLASS.EQUITY]: 0.8, [ASSET_CLASS.BOND]: 0.2 });
});

test('mixAt: `at` picks a specific sample date; an unsampled date is empty', () => {
  assert.deepEqual(mixAt(SIMPLE, { at: '2030-12-31' }),
    { [ASSET_CLASS.EQUITY]: 0.6, [ASSET_CLASS.BOND]: 0.4 });
  assert.deepEqual(mixAt(SIMPLE, { at: '2029-12-31' }), {});
  assert.deepEqual(mixAt([]), {});
});
