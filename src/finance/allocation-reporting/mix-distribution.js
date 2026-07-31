/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { ASSET_CLASS, ASSET_CLASS_VALUES, LIABILITY_CLASSES } from './asset-class.js';
import { buildAllocationSeries } from './allocation-grouping.js';

/**
 * mix-distribution.js — the asset mix as a DISTRIBUTION over Monte Carlo paths
 * (design 82 §8).
 *
 * Phase 1 answers "on the central path, what shape does this plan take?". This
 * answers "**how often** does it take that shape?", which for the §9 finding is the
 * more decision-relevant of the two: "ends 90% house" is alarming, "ends ≥60% house
 * in 80% of paths" is actionable, and "in 8%" is noise.
 *
 * Two halves, deliberately split:
 *
 *   - {@link mixPoint} runs INSIDE the simulation, once per sample, and reduces a
 *     cube to ~9 numbers. It is the only part that touches state.
 *   - everything else runs LATER, over the recorded matrix. Nothing here imports a
 *     sim, so a report can re-cut thresholds and conditioning without re-running an
 *     arm — an arm is minutes, a report is milliseconds, and the report is what gets
 *     rewritten ten times.
 *
 * ─── two honest constraints on the drawing (§8.2) ────────────────────────────
 *
 * **The per-class bands are MARGINAL.** The p90 `EQUITY` band and the p90
 * `REAL_ESTATE` band come from different paths, so they do not sum to 1. They must be
 * drawn as separate bands per class and **never stacked** — a stacked rendering would
 * assert a mix that no path ever held.
 *
 * **A path with zero gross assets has no mix.** Post-ruin the share is 0/0, so those
 * path-years are excluded from every percentile and the excluded count is reported as
 * its own per-year series. Without that, "90% house" silently absorbs every ruined path.
 */

/**
 * The classes a MIX is taken over: every ASSET_CLASS except the liability ones.
 * An allocation is conventionally of GROSS assets, and a negative share is not a
 * picture of anything (see allocation-grouping.js `excludeLiabilities`).
 *
 * Every class is emitted at every sample, present or not, so the recorded matrix has a
 * fixed column order across paths, arms and runs. A ragged matrix would make column i
 * mean a different class in two files that get compared.
 */
export const MIX_CLASSES = Object.freeze(
  ASSET_CLASS_VALUES.filter(v => !LIABILITY_CLASSES.has(v)));

/**
 * The classes that cannot be sold in a week. Named here rather than inline in a
 * threshold so "illiquid" means one thing across the terminal report, the HTML page
 * and any threshold file someone writes later.
 */
export const ILLIQUID_CLASSES = Object.freeze([
  ASSET_CLASS.REAL_ESTATE, ASSET_CLASS.PRIVATE_EQUITY, ASSET_CLASS.COLLECTIBLE,
]);

/**
 * Reduce one sample's cube rows to `{ grossAssets, mix }` — the ~9 numbers an MC
 * iteration records per year (design 82 §8.1).
 *
 * Built on the SHARED pivot rather than a private sum, for the same reason the pivot
 * lives in `src/` at all: if MC computed a share its own way it could disagree with the
 * lab page and the workbench panel, and there would be no way to tell which was right.
 *
 * Returns shares of GROSS assets (liabilities excluded), always over the full
 * {@link MIX_CLASSES} vector. `grossAssets === 0` means the path holds nothing at this
 * instant; the mix is then all zeros and callers must treat it as *absent*, not as a
 * mix of nothing (see {@link mixBands}).
 *
 * @param {object[]} rows  cube rows from buildAllocationCube, ONE sample instant
 * @param {object}   [opts]
 * @param {string[]} [opts.classes=MIX_CLASSES]
 * @returns {{grossAssets: number, mix: Object<string, number>}}
 */
export function mixPoint(rows, { classes = MIX_CLASSES } = {}) {
  const built = buildAllocationSeries(rows, { by: ['assetClass'], dropEmpty: false });
  const i = built.dates.length - 1;

  const grossAssets = i >= 0 ? built.totals[i] : 0;
  const mix = {};
  for (const key of classes) {
    const value = i >= 0 ? (built.series[key]?.[i] ?? 0) : 0;
    mix[key] = grossAssets === 0 ? 0 : value / grossAssets;
  }
  return { grossAssets, mix };
}

/**
 * Fold per-path yearly samples into the compact matrix an arm file carries.
 *
 * **Why a matrix and not the samples.** The alternative — keeping each path's records
 * as objects — writes the class NAME once per class per year per path (~144k repeated
 * strings at n=400), for a file several times the size that says nothing more. A fixed
 * `classes` header plus positional rows says the same thing once.
 *
 * **Why per-path at all**, rather than pre-reduced bands: §8.2 requires thresholds to
 * be movable without a re-run and the mix to be conditionable on failure. Both need the
 * individual paths at report time, and an arm costs minutes while a report costs
 * milliseconds.
 *
 * Shares are rounded to `dp` places (4 ⇒ 0.01 of a percentage point, far finer than
 * anything quotable) purely to keep the file honest about its own precision and small.
 *
 * @param {Array<{seed: number, failed: boolean, series: Array<{year: number, grossAssetsUsd: number, mix: object}>}>} paths
 * @param {object}   [opts]
 * @param {string[]} [opts.classes=MIX_CLASSES]
 * @param {number}   [opts.dp=4]
 * @returns {MixSeries|null} null when no path carried a mix — the report then says the
 *          arm was run without `--mix`, rather than drawing an empty chart.
 */
export function buildMixSeries(paths, { classes = MIX_CLASSES, dp = 4 } = {}) {
  const list = (paths ?? []).filter(p => Array.isArray(p?.series) && p.series.length > 0);
  if (list.length === 0) return null;

  const years = [...new Set(list.flatMap(p => p.series.map(s => s.year)))]
    .filter(Number.isFinite).sort((a, b) => a - b);
  if (years.length === 0) return null;

  const round = 10 ** dp;
  const index = new Map(years.map((y, i) => [y, i]));
  const cols  = [...classes];

  const out = list.map(path => {
    // A year absent from a path is left at gross 0 — i.e. ABSENT, the same treatment a
    // post-ruin year gets. Silently carrying the previous year forward would invent a
    // mix, which is the one thing a distribution must not do.
    const gross  = new Array(years.length).fill(0);
    const shares = years.map(() => new Array(cols.length).fill(0));
    for (const sample of path.series) {
      const y = index.get(sample.year);
      if (y === undefined) continue;
      gross[y] = Math.round(sample.grossAssetsUsd ?? 0);
      for (let c = 0; c < cols.length; c++) {
        shares[y][c] = Math.round((sample.mix?.[cols[c]] ?? 0) * round) / round;
      }
    }
    return { seed: path.seed, failed: !!path.failed, gross, shares };
  });

  return { classes: cols, years, paths: out };
}

/**
 * Nearest-rank percentile, p ∈ [0,1]. Never interpolates, so every band value is a
 * share some path actually held — which matters more here than smoothness, because the
 * whole point of the chart is to describe mixes that occurred.
 * @private
 */
function _percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const i = Math.floor(p * (sorted.length - 1));
  return sorted[Math.min(sorted.length - 1, Math.max(0, i))];
}

/**
 * The recorded matrix, in the shape written into an arm file.
 *
 * @typedef {object} MixSeries
 * @property {string[]} classes  column order, one entry per class
 * @property {number[]} years    row order, one entry per calendar year
 * @property {Array<{seed: number, failed: boolean, gross: number[], shares: number[][]}>} paths
 *           `shares[y][c]` is the share of `classes[c]` at `years[y]`; `gross[y]` is
 *           that path-year's gross assets, and `gross[y] <= 0` marks the point absent.
 */

/** True when this path-year carries a meaningful mix (design 82 §8.2's 0/0 rule). */
const _present = (path, y) => Number.isFinite(path?.gross?.[y]) && path.gross[y] > 0;

/**
 * Per-year percentile bands of each class's share.
 *
 * @param {MixSeries} mixSeries
 * @param {object}   [opts]
 * @param {number[]} [opts.percentiles=[0.10, 0.50, 0.90]]
 * @param {(path: object) => boolean} [opts.filter]  path predicate — pass
 *        `p => p.failed` for §8.2's "mix conditioned on failure".
 * @returns {{years, classes, percentiles, bands, n, excluded, paths}}
 *          `bands[class][p][y]` aligns with `years[y]`; `n[y]` is how many paths
 *          contributed, `excluded[y]` how many were dropped as post-ruin.
 */
export function mixBands(mixSeries, { percentiles = [0.10, 0.50, 0.90], filter = null } = {}) {
  const years   = mixSeries?.years   ?? [];
  const classes = mixSeries?.classes ?? [];
  const paths   = (mixSeries?.paths ?? []).filter(p => (filter ? filter(p) : true));

  const bands = {};
  for (const cls of classes) {
    bands[cls] = {};
    for (const p of percentiles) bands[cls][p] = new Array(years.length).fill(null);
  }
  const n        = new Array(years.length).fill(0);
  const excluded = new Array(years.length).fill(0);

  for (let y = 0; y < years.length; y++) {
    const columns = classes.map(() => []);
    for (const path of paths) {
      if (!_present(path, y)) { excluded[y]++; continue; }
      n[y]++;
      const row = path.shares[y] ?? [];
      for (let c = 0; c < classes.length; c++) columns[c].push(row[c] ?? 0);
    }
    for (let c = 0; c < classes.length; c++) {
      const sorted = columns[c].sort((a, b) => a - b);
      for (const p of percentiles) bands[classes[c]][p][y] = _percentile(sorted, p);
    }
  }

  return { years, classes, percentiles, bands, n, excluded, paths: paths.length };
}

/**
 * A threshold worth quoting — the readouts §8.2 asks for, expressed as data so they
 * can move without re-running an arm.
 *
 * @typedef {object} MixThreshold
 * @property {string}   key        stable identifier
 * @property {string}   label      what it says in a report
 * @property {string[]} classes    class shares are SUMMED before comparing
 * @property {'>='|'<='} [op='>=']
 * @property {number}   share      the level being tested, 0..1
 * @property {'end'|'any'} [when='end']  at the last year in the window, or at any year in it
 * @property {number}   [fromOffset]  window start, years from the first sample
 * @property {number}   [toOffset]    window end,   years from the first sample (inclusive)
 * @property {number}   [fromYear]    absolute window start (wins over fromOffset)
 * @property {number}   [toYear]      absolute window end   (wins over toOffset)
 */

/**
 * The default readouts. Deliberately horizon-RELATIVE (offsets, not calendar years) so
 * the same set means the same thing on a 15-year synthetic run and a 45-year plan.
 * `--thresholds <file.json>` replaces them wholesale at report time.
 */
export const DEFAULT_MIX_THRESHOLDS = Object.freeze([
  {
    key: 'real-estate-60-end', label: 'REAL_ESTATE ≥ 60% of gross assets at the end of the plan',
    classes: [ASSET_CLASS.REAL_ESTATE], op: '>=', share: 0.60, when: 'end',
  },
  {
    key: 'illiquid-75-end', label: 'illiquid (house + company + collectibles) ≥ 75% at the end',
    classes: [...ILLIQUID_CLASSES], op: '>=', share: 0.75, when: 'end',
  },
  {
    key: 'illiquid-75-any', label: 'illiquid ≥ 75% at ANY year',
    classes: [...ILLIQUID_CLASSES], op: '>=', share: 0.75, when: 'any',
  },
  {
    key: 'equity-gone-any', label: 'EQUITY share falls to zero at any year',
    classes: [ASSET_CLASS.EQUITY], op: '<=', share: 0.001, when: 'any',
  },
  {
    key: 'equity-gone-20y', label: 'EQUITY share falls to zero within the first 20 years',
    classes: [ASSET_CLASS.EQUITY], op: '<=', share: 0.001, when: 'any', toOffset: 20,
  },
]);

/** Resolve a threshold's window to inclusive year INDICES. @private */
function _window(spec, years) {
  const last = years.length - 1;
  const clamp = i => Math.min(last, Math.max(0, i));
  const fromYear = spec.fromYear != null ? years.indexOf(spec.fromYear) : -1;
  const toYear   = spec.toYear   != null ? years.indexOf(spec.toYear)   : -1;
  const from = fromYear >= 0 ? fromYear : clamp(spec.fromOffset ?? 0);
  const to   = toYear   >= 0 ? toYear   : clamp(spec.toOffset ?? last);
  return from <= to ? [from, to] : [to, from];
}

/**
 * Evaluate one threshold over the paths.
 *
 * A path with no present year in the window is EXCLUDED, not counted as a miss:
 * post-ruin there is no mix to compare, and folding those in would quietly answer a
 * different question ("how often is the plan both solvent and house-heavy?") under the
 * label of this one. The excluded count travels with the rate so the reader can see
 * how much of the sample it covers.
 *
 * @param {MixSeries} mixSeries
 * @param {MixThreshold} spec
 * @param {object} [opts]
 * @param {(path: object) => boolean} [opts.filter]
 * @returns {{key, label, n, hits, rate, excluded, fromYear, toYear}}
 */
export function thresholdProbability(mixSeries, spec, { filter = null } = {}) {
  const years   = mixSeries?.years   ?? [];
  const classes = mixSeries?.classes ?? [];
  const paths   = (mixSeries?.paths ?? []).filter(p => (filter ? filter(p) : true));

  const cols = (spec.classes ?? []).map(c => classes.indexOf(c)).filter(i => i >= 0);
  const [from, to] = _window(spec, years);
  const meets = (v) => (spec.op === '<=' ? v <= spec.share : v >= spec.share);
  const shareAt = (path, y) => cols.reduce((sum, c) => sum + (path.shares[y]?.[c] ?? 0), 0);

  let n = 0, hits = 0, excluded = 0;
  for (const path of paths) {
    if (spec.when === 'any') {
      let any = false, present = false;
      for (let y = from; y <= to; y++) {
        if (!_present(path, y)) continue;
        present = true;
        if (meets(shareAt(path, y))) { any = true; break; }
      }
      if (!present) { excluded++; continue; }
      n++; if (any) hits++;
    } else {
      // 'end': the LAST year in the window, and only that one. Falling back to an
      // earlier present year would silently report a different instant per path.
      if (!_present(path, to)) { excluded++; continue; }
      n++; if (meets(shareAt(path, to))) hits++;
    }
  }

  return {
    key: spec.key, label: spec.label, n, hits, excluded,
    rate: n ? hits / n : null,
    fromYear: years[from] ?? null, toYear: years[to] ?? null,
  };
}

/** {@link thresholdProbability} over a list of specs. */
export function thresholdProbabilities(mixSeries, specs = DEFAULT_MIX_THRESHOLDS, opts = {}) {
  return specs.map(spec => thresholdProbability(mixSeries, spec, opts));
}

/**
 * §8.2's third view: the mix split by whether the path failed.
 *
 * This is the number that decides which conversation to have. If the failing paths ARE
 * the house-heavy paths, the shape is the failure mechanism and design 82 §7's target
 * overlay is where to intervene. If they are not, the shape is a bequest-composition
 * question and not a solvency one at all.
 *
 * @returns {{failed, survived, nFailed, nSurvived}} two {@link mixBands} results
 */
export function mixByOutcome(mixSeries, opts = {}) {
  const paths = mixSeries?.paths ?? [];
  return {
    failed:    mixBands(mixSeries, { ...opts, filter: p => p.failed }),
    survived:  mixBands(mixSeries, { ...opts, filter: p => !p.failed }),
    nFailed:   paths.filter(p => p.failed).length,
    nSurvived: paths.filter(p => !p.failed).length,
  };
}

/**
 * The median share of each class at one year, for failed vs surviving paths — the
 * compact form of {@link mixByOutcome} a terminal table can print.
 *
 * @param {MixSeries} mixSeries
 * @param {number} [yearIndex]  defaults to the last year
 * @returns {{year, rows: Array<{key, failed, survived, gap}>}}
 */
export function outcomeGapAt(mixSeries, yearIndex = null) {
  const years = mixSeries?.years ?? [];
  const y = yearIndex == null ? years.length - 1 : yearIndex;
  const split = mixByOutcome(mixSeries, { percentiles: [0.50] });

  const rows = (mixSeries?.classes ?? []).map(key => {
    const failed   = split.failed.bands[key]?.[0.50]?.[y] ?? null;
    const survived = split.survived.bands[key]?.[0.50]?.[y] ?? null;
    return {
      key, failed, survived,
      gap: failed != null && survived != null ? failed - survived : null,
    };
  });

  return {
    year: years[y] ?? null,
    nFailed: split.failed.n[y] ?? 0,
    nSurvived: split.survived.n[y] ?? 0,
    rows,
  };
}
