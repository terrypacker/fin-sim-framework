/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { computeNetWorth }            from '../derived-metrics/net-worth.js';
import { computeNetLiquidity }        from '../derived-metrics/net-liquidity.js';
import { toBaseCurrency, currencyOf } from '../fx/to-base-currency.js';
import { buildAllocationCube }        from '../allocation-reporting/allocation-cube.js';
import { mixPoint, MIX_CLASSES }      from '../allocation-reporting/mix-distribution.js';
import { residencePriceLevel }        from '../spending/expense-price-level.js';

/**
 * What an MC path RECORDS, separated from what runs it.
 *
 * Split out of `intl-retirement-mc-runner.js` so the per-iteration worker core can
 * import it without importing the runner (which owns the batch: base-param layering,
 * provenance, aggregation). Nothing here is new — every function is the runner's,
 * moved verbatim — and the runner re-exports them, so `src/index.js` and existing
 * callers are unaffected.
 */

/** @deprecated Use computeNetWorth from derived-metrics/net-worth.js */
export function computeNetWorthUsd(state) {
  return computeNetWorth(state, 'USD');
}

/**
 * Gross USD value of all real-property holdings in `state` (design 75 §6.4 C). Unlike
 * computeNetWorth this sums the *gross* `value` (not equity), FX-converted to USD, because the
 * house-appreciation PATH we want to characterize is the value series, independent of the
 * mortgage. Returns 0 when no property exists (or all sold ⇒ value 0).
 */
export function computeHouseValueUsd(state, baseCurrency = 'USD') {
  let total = 0;
  for (const val of Object.values(state)) {
    if (val == null || typeof val !== 'object') continue;
    if (val.kind !== 'real-property' || typeof val.value !== 'number') continue;
    // Shared valuation convention (design 82 §5.1a) — the house series and the net
    // worth it is compared against must price AUD the same way.
    total += toBaseCurrency(val.value, currencyOf(val, baseCurrency), baseCurrency, state);
  }
  return total;
}

/**
 * Sampler for the per-iteration time series (design 78 §4.5).
 *
 * The metrics an MC path needs are computed here, at sample time, from live state —
 * instead of deep-cloning the entire state so they can be computed later. That is
 * 1,803 full-state clones per iteration replaced by ~45 records of a few numbers, and
 * it is the whole of MC's remaining telemetry cost.
 *
 * Runs at the YEAR-BOUNDARY cadence (design 82 §4): the state after the last event
 * dated in year Y, which is the same instant the lab page and the workbench panel
 * sample, so a share means the same thing in all three. Must not retain references
 * into `state` — it returns numbers only.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.mix=false] also record the asset MIX (design 82 §8.1). Costs
 *        one cube build per sample; see §8.3 on why it is measured, not assumed cheap.
 */
/**
 * The cadence every MC `timeSeries` — and therefore every `pathShape` — is recorded
 * on (design 82 §4/§8.3). Exported so an arm artifact can STAMP it: the switch off
 * design 78's event cadence re-baselined the recorded series without changing a
 * single run outcome, so an old arm JSON and a new one look equally well-formed and
 * are silently not comparable. A stamp turns "remember not to compare across that
 * boundary" into something a reader can check — see `mc-run.mjs` / `mc-report.mjs`.
 */
export const MC_SAMPLER_CADENCE = 'year-boundary';

export function createMcSampler({ mix = false, baseCurrency = 'USD' } = {}) {
  return function sampleTimeSeriesPoint(state, date) {
    const point = {
      date:          new Date(date),
      netWorthUsd:   computeNetWorth(state, baseCurrency),
      netLiquidity:  computeNetLiquidity(state, date),
      houseValueUsd: computeHouseValueUsd(state, baseCurrency),
      // The deflator, sampled WITH the level it deflates (design 97 §18). A trough is a
      // point on a path, so the price level at that point has to travel with it — a
      // report cannot reconstruct it afterwards from a per-run average, and the whole
      // difference between "the reserve held" and "inflation ate it" lives in this
      // number. Same index `InflationAdjustReducer` inflates `state.monthlyExpenses`
      // by (the RESIDENCE country's), so real net liquidity is denominated in the same
      // basket as the spend line it has to cover. 1.0 at simStart => base-year dollars.
      priceLevel:    residencePriceLevel(state),
    };
    if (!mix) return point;

    // Built through the SHARED cube + pivot, never a private sum: design 82 §8.1's
    // whole point is that an MC share and a lab-page share are the same quantity.
    // `displayNameFor` is deliberately absent — a mix needs no account labels, and MC
    // runs on an isolated per-iteration registry with nothing named.
    const rows = buildAllocationCube(state, { date, baseCurrency });
    const { grossAssets, mix: shares } = mixPoint(rows, { classes: MIX_CLASSES });
    point.grossAssetsUsd = grossAssets;
    point.mix            = shares;
    return point;
  };
}

/**
 * Reduce the sampler's records to one data point per year.
 *
 * Under the year-boundary cadence there is already exactly one record per calendar
 * year, so this is now a re-stamp rather than a reduction: the date is normalized to
 * 1 January of the sampled year so every path's series lands on IDENTICAL timestamps.
 * The MC fan chart groups by exact timestamp (`mc-results-panel._buildFanData`), so a
 * per-path stamp — 31 December for a boundary sample, the horizon for a terminal
 * flush — would split one year into two columns of one path each.
 *
 * The label therefore names the year the state belongs to, not the instant it was read
 * at; that was already true under the event cadence and is unchanged here.
 */
export function extractYearlyTimeSeries(sim) {
  const byYear = new Map();
  for (const sample of sim.samples) {
    byYear.set(sample.date.getUTCFullYear(), sample);
  }
  return [...byYear.entries()]
    .sort(([a], [b]) => a - b)
    .map(([year, sample]) => ({
      date:          new Date(Date.UTC(year, 0, 1)),
      netWorthUsd:   sample.netWorthUsd,
      netLiquidity:  sample.netLiquidity,
      houseValueUsd: sample.houseValueUsd,
      priceLevel:    sample.priceLevel,
      ...(sample.mix ? { grossAssetsUsd: sample.grossAssetsUsd, mix: sample.mix } : {}),
    }));
}
/**
 * Standalone seeded PRNG — same algorithm as Simulation.createRNG().
 * Used to produce per-iteration reproducible samples from distributions.
 *
 * Named for MC rather than `makeSeededRng` because `optimization/solvers/
 * solver-support.js` already exports that name (the same algorithm, a different
 * consumer) and the generated `src/index.js` flattens both into one namespace: two
 * modules declaring one name means `Finance.makeSeededRng` silently changes meaning
 * with import order. This was module-private before the split and stays effectively
 * so — nothing outside the MC path should reach for it.
 */
export function makeMcSeededRng(seed) {
  let s = seed;
  return () => {
    s = Math.trunc(s + 0x6D2B79F5);
    let t = Math.imul(s ^ s >>> 15, 1 | s);
    t ^= t + Math.imul(t ^ t >>> 7, 61 | t);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
