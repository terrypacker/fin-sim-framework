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
 * mc-grid.js — the pure half of the lever grid (design 100 §7): constants, cell
 * indexing, the reference cell and per-cell summaries.
 *
 * Split from `mc-grid-runner.js` so the MC config panel can read the limits without
 * importing the runner, and with it the whole scenario graph.
 */

import { failureRate } from './mc-analysis.js';

export const GRID_MODES = Object.freeze({ MC: 'mc', DETERMINISTIC: 'deterministic' });

/** Values per axis. More than this does not fit a results pane as a readable table. */
export const MAX_AXIS_VALUES = 15;

/**
 * Index of `planValue` in `values`: an exact match, else the nearest number, else null.
 * An enum value that is not in the list has no nearest.
 */
export function nearestIndex(values, planValue) {
  if (planValue === undefined || planValue === null) return null;
  const exact = values.findIndex(v => v === planValue);
  if (exact >= 0) return exact;
  if (typeof planValue !== 'number') return null;
  let best = null, bestD = Infinity;
  values.forEach((v, j) => {
    if (typeof v !== 'number') return;
    const d = Math.abs(v - planValue);
    if (d < bestD) { bestD = d; best = j; }
  });
  return best;
}

/**
 * Row-major cell index from per-axis value indices. Matches `cartesianProduct`, which
 * varies the LAST axis fastest.
 */
export function cellIndexOf(axes, idx) {
  let c = 0;
  for (let a = 0; a < axes.length; a++) c = c * axes[a].values.length + idx[a];
  return c;
}

/**
 * The cell the rest are read against: the one at the plan's own values, or the nearest
 * one when the plan's value is not on an axis. `exact` says which, so the panel can say
 * so rather than let the reader assume the reference is the plan.
 */
export function referenceCellOf(axes, planValues) {
  const hits = axes.map((a, k) => nearestIndex(a.values, planValues?.[k]));
  const idx  = hits.map(h => h ?? 0);
  return {
    index: cellIndexOf(axes, idx),
    idx,
    exact: axes.every((a, k) => hits[k] != null && a.values[hits[k]] === planValues[k]),
  };
}

function finite(xs) {
  return xs.filter(x => x != null && Number.isFinite(x)).sort((a, b) => a - b);
}

/**
 * Linear-interpolated percentile, the runner's formula; null when empty. Exported so the
 * grid's ranking (`mc-grid-metrics.js`) and these summaries cannot use two formulas.
 */
export function percentile(xs, p) {
  const v = finite(xs);
  if (!v.length) return null;
  const idx = p * (v.length - 1);
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  return lo === hi ? v[lo] : v[lo] * (hi - idx) + v[hi] * (idx - lo);
}

/**
 * One cell's summary, shaped like the batch summary where the panel reads both (the
 * side-by-side table reads `p10/p50/p90` and `pathShape`), plus the pairing record.
 *
 * Medians and percentiles only, never a mean of terminal wealth (design 100 §2.2).
 *
 * @param {Array}  rows  the cell's analysis rows, in path order
 * @param {object} o
 * @param {Array}  o.sampled         the grid's sampling signature (same for every cell)
 * @param {boolean} o.mcSequenceRisk
 */
export function summarizeGridCell(rows, { sampled, mcSequenceRisk }) {
  const nw = rows.map(r => r.nw);
  return {
    n:           rows.length,
    failures:    rows.filter(r => r.failed).length,
    failureRate: failureRate(rows),
    p10: percentile(nw, 0.10),
    p50: percentile(nw, 0.50),
    p90: percentile(nw, 0.90),
    medianAfterTaxNW: percentile(rows.map(r => r.afterTaxNW), 0.50),
    pathShape: {
      medianNetWorthCagr:        percentile(rows.map(r => r.netWorthCagr), 0.50),
      p10TroughRealNetLiquidity: percentile(rows.map(r => r.troughRealNetLiq), 0.10),
    },
    pairing: { n: rows.length, seeds: rows.map(r => r.seed), sampled, mcSequenceRisk },
  };
}
