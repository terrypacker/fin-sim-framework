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
 * spending-grouping.js — pivot spending cube rows into chart-ready series.
 *
 * The flow analogue of `allocation-grouping.js`, and it lives in `src/` for the same
 * non-negotiable reason (design 89 §11, design 82 §5): the lab page and the eventual
 * workbench panel must not each grow their own pivot. The moment they do, the two can
 * disagree about a share and there is no way to tell which is right. The page ships
 * precomputed series; it does not ship the reduction that made them.
 *
 * ─── the two things this does that the allocation pivot does not ─────────────
 *
 * **Periods, not sample dates.** A stock is sampled at an instant; a flow is summed over
 * an interval. So rows bucket into calendar years and the output is `years`, not `dates`
 * — which is also why the page draws bars: a stacked area asserts a continuity between
 * year-ends that a flow does not have, and invites reading a band's slope as meaningful
 * when only its height is (§9 a).
 *
 * **Two tiers, drawn separately, never summed into one stack.** §8's tier 2 is not
 * spending, and stacking it with tier 1 would restate the very overstatement this design
 * exists to remove. `bySpendingTier` returns the two strips already separated, so a page
 * cannot accidentally add them (OQ3 rejected below-axis — it reads as negative spending —
 * and rejected a toggle, because hiding the audit removes the point of §7 a).
 *
 * The value axis is a parameter, not a second function: `value: 'amountReal'` is the
 * default because §9(b) makes real terms mandatory rather than optional here.
 */

import { REPORT_CATEGORY, CATEGORY_TIER, SPEND_TIER } from './spending-classification.js';

/**
 * Canonical band order, so a legend and its colours stay put between charts, between
 * views and between runs. Ordering by magnitude would let a band change colour when a
 * category drops to zero — actively misleading on a chart whose whole job is comparison
 * across years.
 *
 * Within tier 1 the order is "what the household chose" before "what was levied":
 * living, housing, discretionary, then the taxes, then interest. That is the order the
 * question is usually asked in.
 */
export const CATEGORY_ORDER = Object.freeze([
  REPORT_CATEGORY.LIVING,
  REPORT_CATEGORY.HOUSING_RUNNING,
  REPORT_CATEGORY.HOUSING_REPAIR,
  REPORT_CATEGORY.DISCRETIONARY,
  REPORT_CATEGORY.TAX_US_FEDERAL,
  REPORT_CATEGORY.TAX_US_STATE,
  REPORT_CATEGORY.TAX_AU,
  REPORT_CATEGORY.INTEREST,

  REPORT_CATEGORY.INTERNAL,
  REPORT_CATEGORY.DEBT_PRINCIPAL,
  REPORT_CATEGORY.ASSET_PURCHASE,
  REPORT_CATEGORY.ASSET_IMPROVEMENT,
  REPORT_CATEGORY.REVALUATION,
  REPORT_CATEGORY.UNCLASSIFIED,
]);

/** Rendered in place of a null/absent dimension value — visible, never silently merged. */
export const NO_VALUE = '(none)';

const _dimValue = (row, dim) => {
  const v = row?.[dim];
  return v == null || v === '' ? NO_VALUE : String(v);
};

/** Composite key for a multi-dimension group. ` · ` reads as a path in a legend. */
export const groupKey = (row, dims) => dims.map(d => _dimValue(row, d)).join(' · ');

/**
 * Pivot cube rows into aligned per-year series.
 *
 * @param {object[]} rows                        cube rows from `buildSpendingCube`
 * @param {object}   [opts]
 * @param {string[]} [opts.by=['category']]      dimension field name(s) to group by
 * @param {string}   [opts.value='amountReal']   numeric row field to sum. Real by default
 *                                               (§9 b) — nominal is the toggle, never the default.
 * @param {(row: object) => boolean} [opts.filter=null]  row predicate applied first
 * @param {boolean}  [opts.normalize=false]      emit each year as shares of its own total
 *                                               (the share view, which is unitless and so
 *                                               immune to the real/nominal question entirely)
 * @param {boolean}  [opts.dropEmpty=true]       drop series that are zero in every year
 * @param {number[]} [opts.years=null]           force this year axis (so two strips of one
 *                                               chart share an x-axis even when one has a
 *                                               year the other does not)
 * @returns {{years: number[], keys: string[], series: Object<string, number[]>, totals: number[]}}
 *          `series[key][i]` aligns with `years[i]`; a missing combination is 0, never
 *          undefined, so a consumer never has to hole-fill.
 */
export function buildSpendingSeries(rows, opts = {}) {
  const {
    by        = ['category'],
    value     = 'amountReal',
    filter    = null,
    normalize = false,
    dropEmpty = true,
    years     = null,
  } = opts;

  const dims  = Array.isArray(by) ? by : [by];
  const empty = { years: [], keys: [], series: {}, totals: [] };
  if (!Array.isArray(rows) || rows.length === 0) return empty;

  const byYear    = new Map();   // year → Map(key → sum)
  const keyTotals = new Map();

  for (const row of rows) {
    if (row?.year == null) continue;
    if (filter && !filter(row)) continue;
    const amount = Number(row[value]);
    if (!Number.isFinite(amount)) continue;

    const year = Number(row.year);
    if (!byYear.has(year)) byYear.set(year, new Map());
    const key = groupKey(row, dims);
    byYear.get(year).set(key, (byYear.get(year).get(key) ?? 0) + amount);
    keyTotals.set(key, (keyTotals.get(key) ?? 0) + amount);
  }

  if (byYear.size === 0 && !years?.length) return empty;

  // A forced axis wins, and gaps in it render as a zero year rather than a missing bar.
  // A year in which nothing was spent is a real and interesting state; skipping it would
  // silently compress the x-axis and make two adjacent bars look consecutive.
  const axis = years?.length
    ? [...years]
    : _fillYearGaps([...byYear.keys()].sort((a, b) => a - b));

  let keys = [...keyTotals.keys()];
  if (dropEmpty) keys = keys.filter(k => keyTotals.get(k) !== 0);
  keys = _orderKeys(keys, dims, keyTotals);

  const series = {};
  for (const key of keys) series[key] = new Array(axis.length).fill(0);
  const totals = new Array(axis.length).fill(0);

  axis.forEach((year, i) => {
    const column = byYear.get(year);
    for (const key of keys) {
      const v = column?.get(key) ?? 0;
      series[key][i] = v;
      totals[i] += v;
    }
  });

  if (normalize) {
    axis.forEach((_, i) => {
      const denominator = totals[i];
      // A zero year is a real state. Emitting 0 rather than NaN keeps the band flat
      // instead of punching a hole in the chart at exactly the year worth looking at.
      for (const key of keys) series[key][i] = denominator === 0 ? 0 : series[key][i] / denominator;
    });
  }

  return { years: axis, keys, series, totals };
}

/**
 * The two strips of the chart, on one shared year axis.
 *
 * Returned as a pair rather than one grouped result because they are two different
 * claims: the first is what the plan cost, the second is what it merely moved. A caller
 * that stacks them has restated the 99% overstatement §3 measured.
 *
 * @param {object[]} rows
 * @param {object}   [opts]  as `buildSpendingSeries`, minus `filter` and `years`
 * @returns {{years: number[], spending: object, notSpending: object}}
 */
export function bySpendingTier(rows, opts = {}) {
  const { by = ['category'], ...rest } = opts;
  // One axis, derived from ALL rows, so the two strips line up even in a year where one
  // tier is empty — the case where a misaligned axis is both most likely and most wrong.
  const axis = _fillYearGaps([...new Set(rows.map(r => Number(r.year)).filter(Number.isFinite))]
    .sort((a, b) => a - b));

  const strip = tier => buildSpendingSeries(rows, {
    ...rest, by, years: axis, filter: r => r.tier === tier,
  });
  return { years: axis, spending: strip(SPEND_TIER.SPENDING), notSpending: strip(SPEND_TIER.NOT_SPENDING) };
}

/**
 * The intent line (§5): per year, what tier-1 spending ASKED for versus what it got.
 *
 * Drawn over the bands rather than beside them, because the question is not "how much
 * intent was there" but "did this year get what the plan wanted". A gap only opens when
 * a debit was capped by an empty account, which is the moment the realized bands alone
 * report as an underspend rather than a failure.
 *
 * Rows with no intent (taxes, transfers — nothing caps them below the ask) contribute
 * their realized amount to BOTH series, so the line sits exactly on the stack top in a
 * solvent year rather than floating below it.
 *
 * @param {object[]} rows
 * @param {object}   [opts]
 * @param {string}   [opts.value='amountReal'] realized axis; intent uses its `…Real` twin
 * @param {number[]} [opts.years=null]
 * @returns {{years: number[], realized: number[], intent: number[], shortfall: number[]}}
 */
export function intentVsRealized(rows, opts = {}) {
  const { value = 'amountReal', years = null } = opts;
  const intentField = value === 'amountReal' ? 'intentReal' : 'intent';

  const tier1 = rows.filter(r => r.tier === SPEND_TIER.SPENDING);
  const axis  = years?.length
    ? [...years]
    : _fillYearGaps([...new Set(tier1.map(r => Number(r.year)).filter(Number.isFinite))].sort((a, b) => a - b));
  const index = new Map(axis.map((y, i) => [y, i]));

  const realized  = new Array(axis.length).fill(0);
  const intent    = new Array(axis.length).fill(0);
  for (const row of tier1) {
    const i = index.get(Number(row.year));
    if (i === undefined) continue;
    const got = Number(row[value]);
    if (!Number.isFinite(got)) continue;
    // `row[intentField] == null` FIRST, before Number(). `Number(null)` is 0 and 0 is
    // finite, so testing `Number.isFinite(Number(x))` treats "this row has no intent" as
    // "this row intended nothing" — which drew every tax row as a total shortfall and put
    // a permanent phantom gap under the line on a perfectly solvent plan.
    const raw   = row[intentField];
    const asked = raw == null ? null : Number(raw);
    realized[i] += got;
    intent[i]   += asked != null && Number.isFinite(asked) ? asked : got;
  }
  // Never negative: `realizedAmount` is `min(ask, balance)`, so intent below realized
  // would be a defect upstream rather than a surplus to draw.
  return { years: axis, realized, intent, shortfall: intent.map((v, i) => Math.max(0, v - realized[i])) };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Fill integer gaps in a sorted year list. A plan with no debits in 2041 must still draw
 * 2041 as an empty slot, or the bars either side read as consecutive years.
 * @private
 */
function _fillYearGaps(sorted) {
  if (sorted.length < 2) return sorted;
  const out = [];
  for (let y = sorted[0]; y <= sorted[sorted.length - 1]; y++) out.push(y);
  return out;
}

/**
 * Stable key order: `CATEGORY_ORDER` when grouping by category alone, else descending
 * total with an alphabetical tiebreak so equal-valued keys cannot swap between runs.
 * @private
 */
function _orderKeys(keys, dims, keyTotals) {
  if (dims.length === 1 && (dims[0] === 'category' || dims[0] === 'tier')) {
    const canonical = dims[0] === 'category'
      ? CATEGORY_ORDER
      : [SPEND_TIER.SPENDING, SPEND_TIER.NOT_SPENDING];
    const rank = new Map(canonical.map((v, i) => [v, i]));
    return [...keys].sort((a, b) =>
      (rank.get(a) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b) ?? Number.MAX_SAFE_INTEGER) ||
      a.localeCompare(b));
  }
  return [...keys].sort((a, b) =>
    (keyTotals.get(b) ?? 0) - (keyTotals.get(a) ?? 0) || a.localeCompare(b));
}

/** The tier a category belongs to — re-exported so a consumer needs one import. */
export { CATEGORY_TIER, SPEND_TIER };
