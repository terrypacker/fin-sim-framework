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
 * mc-grid-metrics.js — what a lever-grid cell can be ranked on, and the ranking
 * (design 100 §10).
 *
 * Every value is computed from the cell's ROWS on demand, never stored on the summary:
 * a cell already keeps one row per path, a percentile over a 15 × 15 grid is instant, and
 * changing the metric is then a re-render rather than a re-run. A grid whose rows predate
 * a field reads that metric as unavailable, not as zero.
 *
 * The registry is an allowlist, as `grid-report.mjs`'s `MONEY_METRICS` is: a misspelled
 * field would otherwise render a plausible table of nulls.
 */

import { failureRate, pairedMetric, pairedRescues } from './mc-analysis.js';
import { GRID_MODES, percentile } from './mc-grid.js';

export const GRID_STATS    = Object.freeze({ P10: 'p10', P50: 'p50', P90: 'p90', WIN_RATE: 'winRate' });
export const GRID_READINGS = Object.freeze({ LEVEL: 'level', PAIRED: 'paired' });

/** The one metric that is a share of paths rather than a per-path field. */
export const FAILURE_RATE = 'failureRate';

const QUANTILE = Object.freeze({ p10: 0.10, p50: 0.50, p90: 0.90 });

const metric = (id, label, field, better, unit, { zeroOnFailure = false, caveat = null } = {}) =>
  Object.freeze({ id, label, field, better, unit, zeroOnFailure, caveat });

/**
 * The rankable criteria (design 100 §10.4). `unit` chooses the formatter: `money`, `pct`
 * (a fraction shown as a percentage) or `count`.
 *
 * `zeroOnFailure` marks a metric a failed path drives to about zero by construction (the
 * liquidity measures, `computePathShape`'s header). Its low percentiles on a cell with
 * that many failures describe the failures, not the metric (§10.3.4).
 */
export const GRID_METRICS = Object.freeze([
  metric(FAILURE_RATE, 'Failure rate', 'failed', 'lower', 'pct'),
  metric('afterTaxNW', 'After-tax net worth', 'afterTaxNW', 'higher', 'money'),
  metric('nw', 'Net worth (nominal)', 'nw', 'higher', 'money', {
    caveat: 'Nominal net worth prices a pre-tax dollar at par with a Roth dollar. '
      + 'Rank on after-tax net worth for any question about where wealth sits.',
  }),
  metric('netLiq', 'Net liquidity at the horizon', 'netLiq', 'higher', 'money', {
    zeroOnFailure: true,
    caveat: 'Spendable wealth at the end of the plan, nominal. A failed path ends at about zero.',
  }),
  metric('troughRealNetLiq', 'Net-liquidity trough (real)', 'troughRealNetLiq', 'higher', 'money', {
    zeroOnFailure: true,
    caveat: 'Spendable wealth at the deepest fall from its peak, in base-year dollars. '
      + 'A failed path troughs at about zero, so read it with the failure rate.',
  }),
  metric('minRealNetLiq', 'Net-liquidity floor (real, whole path)', 'minRealNetLiq', 'higher', 'money', {
    zeroOnFailure: true,
    caveat: 'On a plan still accumulating at the start, the whole-path floor is the opening balance, '
      + 'which no lever can change. Prefer the post-peak trough.',
  }),
  metric('troughRealDrawdown', 'Net-liquidity drawdown', 'troughRealDrawdown', 'lower', 'pct'),
  metric('netWorthCagr', 'Realized net-worth CAGR', 'netWorthCagr', 'higher', 'pct'),
  metric('worst5yrCagr', 'Worst 5-year CAGR', 'worst5yrCagr', 'higher', 'pct'),
  metric('maxDrawdown', 'Max drawdown', 'maxDrawdown', 'lower', 'pct', {
    caveat: 'A drawdown of net worth, which counts the house.',
  }),
  metric('taxPaid', 'Lifetime tax', 'taxPaid', 'lower', 'money', {
    caveat: 'Lower is not always better: a conversion pays tax now to pay less later. '
      + 'Read it with after-tax net worth.',
  }),
  metric('deficit', 'Cumulative shortfall', 'deficit', 'lower', 'money'),
  metric('deficitMonths', 'Months short', 'deficitMonths', 'lower', 'count'),
]);

const BY_ID = new Map(GRID_METRICS.map(m => [m.id, m]));

/** The registry entry for `id`; throws on an unknown id rather than rank on nothing. */
export function gridMetric(id) {
  const m = BY_ID.get(id);
  if (!m) throw new Error(`grid metric: unknown "${id}" (have: ${[...BY_ID.keys()].join(', ')})`);
  return m;
}

/**
 * A reading that is valid for this grid. Fills defaults, and drops what the mode cannot
 * do: a deterministic cell has one path, so no statistic, no survivors and no paired
 * reading (Δ against a fixed reference ranks exactly as the level). A win rate exists only
 * in the paired reading, and a stale unknown metric falls back to the mode's default.
 *
 * The defaults are what each mode showed before §10: the failure rate for MC cells and
 * after-tax net worth for deterministic ones.
 */
export function normalizeGridReading(reading, mode) {
  const det = mode === GRID_MODES.DETERMINISTIC;
  const r = {
    metric:        det ? 'afterTaxNW' : FAILURE_RATE,
    stat:          GRID_STATS.P50,
    reading:       GRID_READINGS.LEVEL,
    survivorsOnly: false,
    ...(reading ?? {}),
  };
  if (!BY_ID.has(r.metric)) r.metric = det ? 'afterTaxNW' : FAILURE_RATE;
  if (det) return { metric: r.metric, stat: GRID_STATS.P50, reading: GRID_READINGS.LEVEL, survivorsOnly: false };
  if (!Object.values(GRID_READINGS).includes(r.reading)) r.reading = GRID_READINGS.LEVEL;
  if (!Object.values(GRID_STATS).includes(r.stat)) r.stat = GRID_STATS.P50;
  if (r.stat === GRID_STATS.WIN_RATE && r.reading !== GRID_READINGS.PAIRED) r.stat = GRID_STATS.P50;
  r.survivorsOnly = !!r.survivorsOnly && r.metric !== FAILURE_RATE;
  return r;
}

/**
 * One cell's value on a metric.
 *
 * @param {Array}  rows  the cell's analysis rows
 * @param {object} o
 * @param {string} o.metric          a `GRID_METRICS` id
 * @param {string} [o.stat='p50']    a `GRID_STATS` value; ignored for the failure rate
 * @param {string} [o.reading='level']  `level`, or `paired` against `refRows`
 * @param {Array}  [o.refRows]       the reference cell's rows (paired only)
 * @param {boolean} [o.survivorsOnly=false]  take the statistic over surviving paths
 *        (paired: over worlds where both cells survive)
 * @returns {{ value: number|null, better: 'higher'|'lower', n: number, failureRate: number|null,
 *            degenerate: boolean, unavailable: boolean, survivors?: number,
 *            rescues?: number, reverseRescues?: number }}
 *   `better` can differ from the metric's: a win rate is always higher-is-better.
 */
export function gridCellMetric(rows, {
  metric: id, stat = GRID_STATS.P50, reading = GRID_READINGS.LEVEL, refRows = null, survivorsOnly = false,
} = {}) {
  const m = gridMetric(id);
  const paired = reading === GRID_READINGS.PAIRED;
  if (paired && !refRows) throw new Error('grid metric: a paired reading needs the reference rows');

  const out = {
    value: null, better: m.better, n: rows.length, failureRate: failureRate(rows),
    degenerate: false, unavailable: false,
  };

  if (m.id === FAILURE_RATE) {
    if (!paired) return { ...out, value: out.failureRate };
    // rescues − reverse rescues is exactly the difference in failure counts, so the paired
    // failure rate ranks as the level does (§10.3.6). What it adds is the two counts.
    const pr = pairedRescues(refRows, rows);
    return {
      ...out, n: pr.n, value: pr.n ? (pr.reverseRescues - pr.rescues) / pr.n : null,
      rescues: pr.rescues, reverseRescues: pr.reverseRescues,
    };
  }

  if (!rows.some(r => Number.isFinite(r[m.field]))) return { ...out, unavailable: true };

  if (paired) {
    let a = refRows, b = rows;
    if (survivorsOnly) {
      const failedIn = new Set([...refRows, ...rows].filter(r => r.failed).map(r => r.seed));
      a = refRows.filter(r => !failedIn.has(r.seed));
      b = rows.filter(r => !failedIn.has(r.seed));
    }
    const pm = pairedMetric(a, b, m.field);
    if (stat === GRID_STATS.WIN_RATE) {
      // pairedMetric counts a rise as a win; for a lower-is-better metric a fall is the win.
      const winRate = m.better === 'higher' ? pm.winRate : pm.lossRate;
      return { ...out, n: pm.n, better: 'higher', value: pm.n ? winRate : null };
    }
    if (!(stat in QUANTILE)) throw new Error(`grid metric: unknown statistic "${stat}"`);
    return { ...out, n: pm.n, value: pm[stat] ?? null };
  }

  const q = QUANTILE[stat];
  if (q == null) throw new Error(`grid metric: statistic "${stat}" needs the paired reading`);
  const pool   = survivorsOnly ? rows.filter(r => !r.failed) : rows;
  const values = pool.map(r => r[m.field]).filter(Number.isFinite);
  const res = { ...out, n: values.length, value: percentile(values, q) };
  if (survivorsOnly) {
    res.survivors = pool.length;
  } else if (m.zeroOnFailure && out.failureRate >= q) {
    // Failed paths sit at the bottom at about zero, so this percentile lands among them:
    // every such cell would tie near zero, and a ranking on that ranks on noise (§10.3.4).
    res.degenerate = true;
  }
  return res;
}

/**
 * Dense ranks for a grid's cell values, 1 = best, in the order given.
 *
 * Tied values share a rank. Degenerate cells rank after every valid one, ordered among
 * themselves by failure rate (they describe their failures, so that is what separates
 * them). A cell with no value, or an unavailable metric, has no rank (null).
 *
 * @param {Array} results  `gridCellMetric` results, one per cell, all on one reading
 * @returns {Array<number|null>}
 */
export function rankCells(results) {
  const better = results.find(r => r.better)?.better ?? 'higher';
  const key    = (v) => (better === 'higher' ? -v : v);
  const ranked = (r) => !r.unavailable && !r.degenerate && Number.isFinite(r.value);

  const distinct = [...new Set(results.filter(ranked).map(r => key(r.value)))].sort((a, b) => a - b);
  const degen = [...new Set(results.filter(r => r.degenerate).map(r => r.failureRate))].sort((a, b) => a - b);

  return results.map(r => {
    if (ranked(r)) return distinct.indexOf(key(r.value)) + 1;
    if (r.degenerate && !r.unavailable) return distinct.length + degen.indexOf(r.failureRate) + 1;
    return null;
  });
}
