/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { ASSET_CLASS_VALUES, LIABILITY_CLASSES } from './asset-class.js';

/**
 * allocation-grouping.js — pivot allocation fact rows into chart-ready series.
 *
 * This is the OTHER half of "emit the tuple, group in the view". buildAllocationCube
 * produces one flat table spanning every sample date; this turns any group-by of it
 * into `{ dates, keys, series }`, which is directly what a stacked area consumes.
 *
 * It lives in src/ rather than in the lab script on purpose. The prototype page and
 * the eventual workbench plugin must not each grow their own pivot: the moment they
 * do, the two can disagree about a share and there is no way to tell which is right.
 * Same reasoning as lib/grid-report.mjs being shared between the terminal report and
 * study-report.mjs — one reduction, several presentations.
 *
 * Every requested view is a `by` argument:
 *
 *   total over time            by: ['assetClass']
 *   per country over time      by: ['domicileCountry', 'assetClass']
 *   per account over time      by: ['assetClass'], filter: r => r.stateKey === k
 *   by return series           by: ['rateKey']
 *   exposure vs domicile       by: ['exposureCountry'] / by: ['domicileCountry']
 */

/** Rendered in place of a null/absent dimension value — visible, never silently merged. */
export const NO_VALUE = '(none)';

/**
 * Canonical key order per dimension, so a legend and its colours stay put between
 * charts and between runs. A chart whose EQUITY band changes colour when a class
 * drops to zero is actively misleading; ordering by magnitude would do exactly that.
 * Dimensions absent here fall back to descending total, then alphabetical.
 */
const CANONICAL_ORDER = Object.freeze({
  assetClass: ASSET_CLASS_VALUES,
  allocation: Object.freeze(['EQUITY', 'BOND', 'CASH', 'GOLD']),
});

const _dimValue = (row, dim) => {
  const v = row?.[dim];
  return v == null || v === '' ? NO_VALUE : String(v);
};

/** Composite key for a multi-dimension group. ` · ` reads as a path in a legend. */
export const groupKey = (row, dims) => dims.map(d => _dimValue(row, d)).join(' · ');

const _dayKey = d => (d instanceof Date ? d : new Date(d)).toISOString().slice(0, 10);

/**
 * Pivot cube rows into aligned time series.
 *
 * @param {object[]} rows                       - fact rows from buildAllocationCube, any number of dates
 * @param {object}   [opts]
 * @param {string[]} [opts.by=['assetClass']]   - dimension field name(s) to group by
 * @param {string}   [opts.value='marketValue'] - numeric row field to sum
 * @param {(row: object) => boolean} [opts.filter=null] - row predicate applied first
 * @param {boolean}  [opts.excludeLiabilities=true]
 *        - drop LIABILITY rows. Default true because this is a MIX: an allocation is
 *          conventionally of gross assets, and a negative band in a stacked area is
 *          not a picture of anything. Set false for a net-worth decomposition.
 * @param {boolean}  [opts.excludeSpeculative=true]
 *        - drop rows flagged `speculative` (design 88 §6). Default true for the same
 *          reason liabilities are dropped by default and for a sharper one: a
 *          percentage-of-portfolio figure that includes a position you have DECLARED
 *          may be worthless is not an allocation statement. "42% private equity" reads
 *          as concentration risk you could rebalance away; if that 42% is a stake with
 *          no buyer, every other slice is understated by a denominator you would never
 *          have chosen. So the mix follows RECOGNITION — it ties to `computeNetWorth`,
 *          the same figure every headline uses — and the excluded amount is disclosed
 *          separately rather than becoming a slice. Set false for the total/net-worth
 *          decomposition view, which is disclosure and ties to
 *          `computeNetWorthInclSpeculative`.
 * @param {boolean}  [opts.normalize=false]
 *        - emit each date's column as shares of that column's total (the 100%
 *          stacked view — drift), rather than absolute values (growth).
 * @param {boolean}  [opts.dropEmpty=true]      - drop series that are zero at every date
 * @returns {{dates: Date[], keys: string[], series: Object<string, number[]>, totals: number[]}}
 *          `series[key][i]` aligns with `dates[i]`; missing combinations are 0, never
 *          undefined, so a consumer never has to hole-fill.
 */
export function buildAllocationSeries(rows, opts = {}) {
  const {
    by                 = ['assetClass'],
    value              = 'marketValue',
    filter             = null,
    excludeLiabilities = true,
    excludeSpeculative = true,
    normalize          = false,
    dropEmpty          = true,
  } = opts;

  const dims = Array.isArray(by) ? by : [by];
  const empty = { dates: [], keys: [], series: {}, totals: [] };
  if (!Array.isArray(rows) || rows.length === 0) return empty;

  // date → key → sum. A Map keyed on the ISO day collapses the several rows a single
  // sample date produces, and keeps the dates in first-seen order until the sort.
  const byDate  = new Map();
  const keyTotals = new Map();

  for (const row of rows) {
    if (row?.date == null) continue;
    if (excludeLiabilities && LIABILITY_CLASSES.has(row.assetClass)) continue;
    // Design 88 §6 — `=== true` so a row whose flag never made it this far is
    // included, which is the pre-88 behaviour, rather than silently dropped.
    if (excludeSpeculative && row.speculative === true) continue;
    if (filter && !filter(row)) continue;

    const amount = Number(row[value]);
    if (!Number.isFinite(amount)) continue;

    const day = _dayKey(row.date);
    let column = byDate.get(day);
    if (!column) {
      column = { date: new Date(row.date), sums: new Map() };
      byDate.set(day, column);
    }
    const key = groupKey(row, dims);
    column.sums.set(key, (column.sums.get(key) ?? 0) + amount);
    keyTotals.set(key, (keyTotals.get(key) ?? 0) + amount);
  }

  if (byDate.size === 0) return empty;

  const columns = [...byDate.values()].sort((a, b) => a.date - b.date);
  const dates   = columns.map(c => c.date);

  let keys = [...keyTotals.keys()];
  if (dropEmpty) keys = keys.filter(k => keyTotals.get(k) !== 0);
  keys = _orderKeys(keys, dims, keyTotals);

  const series = {};
  for (const key of keys) series[key] = new Array(columns.length).fill(0);
  const totals = new Array(columns.length).fill(0);

  columns.forEach((column, i) => {
    for (const key of keys) {
      const v = column.sums.get(key) ?? 0;
      series[key][i] = v;
      totals[i] += v;
    }
  });

  if (normalize) {
    columns.forEach((_, i) => {
      const denominator = totals[i];
      for (const key of keys) {
        // A zero column is a real state (everything sold, or before the plan funds).
        // Emitting 0 rather than NaN keeps the band flat instead of punching a hole
        // in the chart at exactly the moment worth looking at.
        series[key][i] = denominator === 0 ? 0 : series[key][i] / denominator;
      }
    });
  }

  return { dates, keys, series, totals };
}

/**
 * Stable key order: the canonical list for a single known dimension, else descending
 * total with an alphabetical tiebreak so equal-valued keys cannot swap between runs.
 * @private
 */
function _orderKeys(keys, dims, keyTotals) {
  const canonical = dims.length === 1 ? CANONICAL_ORDER[dims[0]] : null;
  if (canonical) {
    const rank = new Map(canonical.map((v, i) => [v, i]));
    return [...keys].sort((a, b) =>
      (rank.get(a) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b) ?? Number.MAX_SAFE_INTEGER) ||
      a.localeCompare(b));
  }
  return [...keys].sort((a, b) =>
    (keyTotals.get(b) ?? 0) - (keyTotals.get(a) ?? 0) || a.localeCompare(b));
}

/**
 * The mix at one date as `{ key: share }`, shares summing to 1.
 * The scalar readout beside a chart ("you are 62% equity today"), and the shape a
 * realized-vs-target comparison needs.
 *
 * @param {object[]} rows  - cube rows; pass a single date's worth, or `at` to pick one
 * @param {object}   [opts] - as buildAllocationSeries, plus:
 * @param {Date|string} [opts.at] - restrict to this sample date; default = the latest
 * @returns {Object<string, number>}
 */
export function mixAt(rows, opts = {}) {
  const { at = null, ...rest } = opts;
  const built = buildAllocationSeries(rows, { ...rest, normalize: true });
  if (built.dates.length === 0) return {};

  let index = built.dates.length - 1;
  if (at != null) {
    const want = _dayKey(at);
    const found = built.dates.findIndex(d => _dayKey(d) === want);
    if (found === -1) return {};
    index = found;
  }
  const out = {};
  for (const key of built.keys) out[key] = built.series[key][index];
  return out;
}
