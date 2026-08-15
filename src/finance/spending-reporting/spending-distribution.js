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
 * Spending as a DISTRIBUTION — design 89 §11.1 phase 6.
 *
 * The lab page and the panel describe one path. This answers the questions a single path
 * cannot: *how often* is tax more than half of what the plan costs, what is the p90 real
 * cost, how much does the cost of the plan actually vary once returns are stochastic.
 *
 * ─── the constraint that shapes everything here ──────────────────────────────
 *
 * **A spending cube needs `stateDiff`, and `stateDiff` exists only at `telemetry: 'full'`.**
 * Measured on the reference plan: `off` 530 ms/iteration, `journal` 719 ms — but a
 * `journal`-level run produces entries with **null `stateDiff`** (`silent` skips the state
 * clone; see `simulation.js`'s own comment), so the cube computes exactly **zero**. Only
 * `full` works, at **3,963 ms** — 7.5x the MC default.
 *
 * That is why design 82 §8.1 could put allocation into MC cheaply and this cannot follow:
 * an allocation is a **stock**, readable from live state at an instant with no journal at
 * all. Spending is a **flow**; there is nothing in state at a year boundary that says what
 * the year cost. So spending-in-MC is opt-in and priced, exactly as `mix` is.
 *
 * ─── the shortcut that does not work, measured ───────────────────────────────
 *
 * `state.cumulativeTaxesPaid` and `state.cumulativeConsumption` are both available at
 * `telemetry: 'off'` and look like they answer the headline question for free. They do not,
 * and the error is large and silent:
 *
 * | | from the accumulators | correct (real) | correct (nominal) |
 * |---|---|---|---|
 * | tax as a share of spending | **74.9%** | 53.1% | 59.4% |
 *
 * Two independent defects compound. `cumulativeTaxesPaid` is **nominal** and includes the
 * AU super fund tax — withheld in-fund, never a debit from any account the household spends
 * from (design 77, §8.1) — worth \$31k on the reference plan. `cumulativeConsumption` is
 * **real** and covers `EXPENSE_DEBIT` only. Dividing one by the other adds nominal to real
 * *and* uses two different definitions of "spending". It is the same mixed-unit defect §5.2
 * found between `cumulativeDeficit` and `cumulativeConsumption`, surfacing in a new place.
 *
 * So the distribution is built from cubes, and the accumulators are not a fallback.
 */

import { spendingSummary, categoriesByValue } from './spending-cube.js';
import { intentVsRealized } from './spending-grouping.js';
import { REPORT_CATEGORY, SPEND_TIER, CATEGORY_TIER } from './spending-classification.js';

/** The tier-1 categories that are tax, in every jurisdiction the taxonomy names. */
export const TAX_CATEGORIES = Object.freeze([
  REPORT_CATEGORY.TAX_US_FEDERAL,
  REPORT_CATEGORY.TAX_US_STATE,
  REPORT_CATEGORY.TAX_AU,
]);

/**
 * Reduce one run's cube to the handful of numbers a distribution needs.
 *
 * **Deliberately small.** A cube is ~3,900 rows on a 45-year plan; keeping N of them is
 * hundreds of megabytes at MC scale and the reason an MC iteration records metrics rather
 * than state (design 78 §4.5). This is ~20 numbers, so a 1,000-path record set is trivial.
 *
 * Both units on every total, for the reason §17.3 records: a page that pairs nominal
 * spending with a real total reads as "inflation barely matters" on a plan where the
 * like-for-like ratio is 2.3x.
 *
 * @param {ReturnType<import('./spending-cube.js').buildSpendingCube>} cube
 * @returns {object|null} null for an empty cube, so a failed path is visibly absent
 */
export function summarizeSpendingForRun(cube) {
  if (!cube?.rows?.length) return null;

  const summary = spendingSummary(cube);
  const byCategoryReal    = {};
  const byCategoryNominal = {};
  for (const c of categoriesByValue(cube)) {
    byCategoryReal[c.category]    = c.amountReal;
    byCategoryNominal[c.category] = c.amount;
  }

  const taxReal    = TAX_CATEGORIES.reduce((a, k) => a + (byCategoryReal[k]    ?? 0), 0);
  const taxNominal = TAX_CATEGORIES.reduce((a, k) => a + (byCategoryNominal[k] ?? 0), 0);

  // §5's shortfall, summed over the plan: how much the household ASKED to spend and could
  // not. Zero on a solvent path, and the number that makes a p90 cost figure honest —
  // without it a path that ran dry reports as CHEAP.
  const intent = intentVsRealized(cube.rows, { value: 'amountReal' });
  const shortfallReal = intent.shortfall.reduce((a, v) => a + v, 0);

  return {
    years: intent.years.length,
    spendingReal:    summary.spendingReal,
    spendingNominal: summary.spending,
    notSpendingReal: summary.notSpendingReal,
    totalReal:       cube.totalReal,
    totalNominal:    cube.total,
    overstatement:   summary.overstatement,
    inflationFactor: summary.inflationFactor,
    taxReal, taxNominal,
    /** The headline ratio, in ONE unit. Real, because that is the page's default basis. */
    taxShare: summary.spendingReal > 0 ? taxReal / summary.spendingReal : null,
    shortfallReal,
    /** True when the plan could not fund what it intended, at any point. */
    wentShort: shortfallReal > 1,
    byCategoryReal, byCategoryNominal,
    unclassifiedReal: byCategoryReal[REPORT_CATEGORY.UNCLASSIFIED] ?? 0,
    // The action types behind that band, not just its size. An MC sweep perturbs a plan
    // into corners the reference path never reaches, so this is where §8.0's "types that
    // exist but never fire" actually show up — and an unclassified band nobody can NAME
    // is an alarm with no address. Cheap: a handful of strings, and empty on most paths.
    unclassifiedTypes: [...new Set(cube.rows
      .filter(r => r.category === REPORT_CATEGORY.UNCLASSIFIED)
      .map(r => r.actionType))].sort(),
  };
}

/**
 * Percentiles of a numeric sample, by linear interpolation between order statistics.
 *
 * Nulls and non-finite values are dropped rather than treated as zero: a path that
 * produced no cube has no spending figure, and counting it as \$0 would drag every
 * percentile toward a number no path actually experienced.
 *
 * @param {number[]} values
 * @param {number[]} [ps=[0.1, 0.5, 0.9]]
 * @returns {Object<string, number>|null} keyed `p10`, `p50`, … ; null for an empty sample
 */
export function percentiles(values, ps = [0.1, 0.5, 0.9]) {
  const sorted = (values ?? []).filter(v => Number.isFinite(v)).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const out = {};
  for (const p of ps) {
    const idx = (sorted.length - 1) * p;
    const lo  = Math.floor(idx), hi = Math.ceil(idx);
    out[`p${Math.round(p * 100)}`] = lo === hi
      ? sorted[lo]
      : sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
  }
  return out;
}

/**
 * Aggregate N per-run records into the distribution.
 *
 * @param {Array<object|null>} records  from `summarizeSpendingForRun`; nulls allowed
 * @param {object} [opts]
 * @param {number[]} [opts.ps=[0.1,0.5,0.9]]
 * @returns {object}
 */
export function aggregateSpendingRuns(records, { ps = [0.1, 0.5, 0.9] } = {}) {
  const runs = (records ?? []).filter(Boolean);
  const empty = {
    n: 0, nSkipped: (records ?? []).length, categories: [],
    spendingReal: null, spendingNominal: null, taxShare: null,
    overstatement: null, inflationFactor: null, shortfallReal: null,
    byCategoryReal: {}, wentShortRate: null,
  };
  if (runs.length === 0) return empty;

  const pick = (field) => percentiles(runs.map(r => r[field]), ps);

  const categorySet = new Set();
  for (const r of runs) for (const k of Object.keys(r.byCategoryReal)) categorySet.add(k);

  const byCategoryReal = {};
  for (const category of categorySet) {
    // Absent means the path never fired that category — a real zero for this purpose,
    // unlike a null spending figure. A repair model that fires in 30% of paths must show
    // a p10 of 0, not a p10 taken over only the paths that had repairs.
    byCategoryReal[category] = {
      ...percentiles(runs.map(r => r.byCategoryReal[category] ?? 0), ps),
      tier:  CATEGORY_TIER[category],
      /** Fraction of paths in which this category moved any money at all. */
      firedRate: runs.filter(r => (r.byCategoryReal[category] ?? 0) > 0).length / runs.length,
    };
  }

  return {
    n: runs.length,
    nSkipped: (records ?? []).length - runs.length,
    spendingReal:    pick('spendingReal'),
    spendingNominal: pick('spendingNominal'),
    totalReal:       pick('totalReal'),
    taxReal:         pick('taxReal'),
    taxShare:        pick('taxShare'),
    overstatement:   pick('overstatement'),
    inflationFactor: pick('inflationFactor'),
    shortfallReal:   pick('shortfallReal'),
    /** How often the plan could not fund what it intended — §5's question, across paths. */
    wentShortRate: runs.filter(r => r.wentShort).length / runs.length,
    /**
     * Every action type that reached `UNCLASSIFIED` on ANY path, with how many paths
     * fired it. This is the sweep's most useful by-product: it is a to-do list for the
     * allowlist, discovered by perturbation rather than by reading the codebase.
     */
    unclassifiedTypes: (() => {
      const counts = new Map();
      for (const r of runs) for (const t of (r.unclassifiedTypes ?? [])) {
        counts.set(t, (counts.get(t) ?? 0) + 1);
      }
      return [...counts].map(([actionType, paths]) => ({ actionType, paths }))
        .sort((a, b) => b.paths - a.paths);
    })(),
    categories: [...categorySet].sort((a, b) =>
      (byCategoryReal[b].p50 ?? 0) - (byCategoryReal[a].p50 ?? 0)),
    byCategoryReal,
  };
}

/**
 * "How often is X above a threshold?" — the shape of question §11.1 names for this phase.
 *
 * Returned as a fraction of paths, and `null` rather than 0 for an empty sample, so a
 * caller cannot mistake "never happens" for "nothing was measured".
 *
 * @param {Array<object|null>} records
 * @param {string} field      e.g. `'taxShare'`
 * @param {number} threshold  e.g. 0.5
 * @returns {number|null}
 */
export function exceedanceRate(records, field, threshold) {
  const values = (records ?? []).filter(Boolean)
    .map(r => r[field]).filter(v => Number.isFinite(v));
  if (values.length === 0) return null;
  return values.filter(v => v > threshold).length / values.length;
}

/**
 * The one-line verdict, for a terminal report or a page header.
 *
 * @param {ReturnType<typeof aggregateSpendingRuns>} agg
 * @returns {string}
 */
export function describeSpendingDistribution(agg) {
  if (!agg?.n) return 'no paths produced a spending cube';
  const pct = (v) => (v == null ? '—' : `${(v * 100).toFixed(0)}%`);
  const usd = (v) => (v == null ? '—' : `$${Math.round(v).toLocaleString()}`);
  return `${agg.n} paths · real cost p10 ${usd(agg.spendingReal?.p10)} · ` +
         `p50 ${usd(agg.spendingReal?.p50)} · p90 ${usd(agg.spendingReal?.p90)} · ` +
         `tax share p50 ${pct(agg.taxShare?.p50)} · went short in ${pct(agg.wentShortRate)} of paths`;
}

export { SPEND_TIER, REPORT_CATEGORY };
