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

/**
 * Path-shape diagnostics for one MC iteration (design 74 §5.2). Computed from the
 * yearly net-worth series so it characterizes the *shape* of the path, not just its
 * endpoint — the readout sequence-of-returns risk needs. Robust to short/degenerate
 * series (returns nulls rather than NaN/Infinity).
 *
 *   - netWorthCagr    — realized geometric growth of net worth start→end ("realized
 *                       geometric mean" in §5.2). null when either endpoint ≤ 0.
 *   - worst5yrCagr    — the worst rolling 5-year annualized growth. The classic
 *                       sequence-risk window: a bad early 5 years is far more damaging
 *                       to a decumulating portfolio than the same 5 years late.
 *   - maxDrawdown     — deepest peak-to-trough decline as a fraction of the peak, [0,1].
 *   - decadeNetWorthUsd — net worth ~10 years in (min(10, last)); the aggregate step
 *                       marks whether this was below the cross-path median (§5.2's
 *                       "first decade below median" — the direct sequence-risk flag).
 *   - minRealNetLiquidity / minRealNetLiquidityYear — the lowest point on the path,
 *                       in SPENDABLE, BASE-YEAR terms (design 97 §18). This is the
 *                       metric a liquidity reserve exists to move, and none of the
 *                       three above can stand in for it:
 *                         · `maxDrawdown` is a fraction of net WORTH, which counts
 *                           the house and any company equity — the two things a
 *                           reserve cannot spend. A plan can hold its net-worth
 *                           drawdown flat while its spendable book goes to nothing.
 *                         · it is a RATIO, so it cannot say how many years of
 *                           spending were left at the worst point.
 *                         · terminal wealth is measured after the recovery, so it
 *                           rewards whoever carried the most equity through it
 *                           (`scenarios/offset-bond-pool/STUDY.md`) — the exact bias
 *                           a reserve study must not score itself on.
 *                       Deflated by the price level sampled AT each point, so it is
 *                       comparable across paths whose realized inflation differs.
 *
 *                       On a path that ran out of funds it is ~0 by construction, so
 *                       failure is the primary key and this is the secondary one.
 *   - troughRealNetLiquidity / …Year / …Drawdown — the same quantity measured AFTER
 *                       the peak: the level at the bottom of the deepest fall from a
 *                       running high, and that fall as a fraction of the high.
 *
 *                       Needed because `minRealNetLiquidity` is the whole-path floor,
 *                       and on any plan that is still accumulating at t0 the floor IS
 *                       t0 — measured on the reference plan, the median path's minimum
 *                       fell in the FIRST sampled year, so the metric reported the
 *                       opening balance and ranked every arm identically. The opening
 *                       balance is the one number no strategy can change.
 *
 *                       The post-peak trough cannot be reached by the opening balance
 *                       (a running peak has to be set first), so it is the one to rank
 *                       strategies on; the whole-path floor stays, because on a plan
 *                       that decumulates from day one they coincide and the floor is
 *                       the more direct statement.
 */
export function computePathShape(timeSeries) {
  const nw = (timeSeries ?? []).map(p => p.netWorthUsd);
  const empty = {
    netWorthCagr: null, worst5yrCagr: null, maxDrawdown: null, decadeNetWorthUsd: null,
    houseCagr: null, houseMaxDrawdown: null,
    minRealNetLiquidity: null, minRealNetLiquidityYear: null,
    troughRealNetLiquidity: null, troughRealNetLiquidityYear: null, troughRealDrawdown: null,
  };
  if (nw.length < 2) return empty;

  const years = nw.length - 1;
  const first = nw[0];
  const last  = nw[nw.length - 1];
  const netWorthCagr = (first > 0 && last > 0) ? Math.pow(last / first, 1 / years) - 1 : null;

  // Worst rolling 5-year annualized growth (skips windows straddling non-positive NW).
  let worst5yrCagr = null;
  for (let t = 0; t + 5 < nw.length; t++) {
    const a = nw[t], b = nw[t + 5];
    if (a > 0 && b > 0) {
      const cagr = Math.pow(b / a, 1 / 5) - 1;
      worst5yrCagr = worst5yrCagr === null ? cagr : Math.min(worst5yrCagr, cagr);
    }
  }

  // Deepest peak-to-trough decline as a fraction of the running peak.
  let peak = -Infinity, maxDrawdown = 0;
  for (const v of nw) {
    if (v > peak) peak = v;
    if (peak > 0) maxDrawdown = Math.max(maxDrawdown, (peak - v) / peak);
  }

  const decadeNetWorthUsd = nw[Math.min(10, nw.length - 1)];

  // The trough of REAL net liquidity, and the year it happened in. A point with no
  // price level deflates by 1 rather than dropping out: an un-indexed series is then
  // a NOMINAL trough, which is a readable number, where skipping the point would
  // silently shorten the window a reserve is judged over.
  let minRealNetLiquidity = null, minRealNetLiquidityYear = null;
  // …and the deepest fall FROM A RUNNING PEAK, which is the ranking metric: the whole-path
  // floor is the opening balance on any plan still accumulating at t0, and no strategy can
  // change the opening balance.
  let liqPeak = null, deepest = 0;
  let troughRealNetLiquidity = null, troughRealNetLiquidityYear = null, troughRealDrawdown = null;
  for (const p of timeSeries ?? []) {
    if (typeof p.netLiquidity !== 'number' || !Number.isFinite(p.netLiquidity)) continue;
    const level = (typeof p.priceLevel === 'number' && p.priceLevel > 0) ? p.priceLevel : 1;
    const real  = p.netLiquidity / level;
    const year  = p.date?.getUTCFullYear?.() ?? null;

    if (minRealNetLiquidity === null || real < minRealNetLiquidity) {
      minRealNetLiquidity     = real;
      minRealNetLiquidityYear = year;
    }

    if (liqPeak === null || real > liqPeak) liqPeak = real;
    // Ties go to the FIRST occurrence: on a path that runs dry the level sits at zero for
    // years, and the year the money ran out is the informative one.
    const fall = liqPeak > 0 ? (liqPeak - real) / liqPeak : 0;
    if (fall > deepest) {
      deepest = fall;
      troughRealNetLiquidity     = real;
      troughRealNetLiquidityYear = year;
      troughRealDrawdown         = fall;
    }
  }
  // A path that only ever rose has no fall from a peak. Its trough is its endpoint and its
  // drawdown is zero — reported as such, rather than as null, because "never fell" is an
  // answer and a null would drop the path out of every percentile.
  if (troughRealNetLiquidity === null && minRealNetLiquidity !== null) {
    const last = (timeSeries ?? []).filter(p => Number.isFinite(p.netLiquidity)).at(-1);
    const lvl  = (typeof last?.priceLevel === 'number' && last.priceLevel > 0) ? last.priceLevel : 1;
    troughRealNetLiquidity     = last.netLiquidity / lvl;
    troughRealNetLiquidityYear = last.date?.getUTCFullYear?.() ?? null;
    troughRealDrawdown         = 0;
  }

  // House-price path (design 75 §6.4 C). Characterize the appreciation PATH over the pre-sale
  // window only: once the house is sold its value drops to 0, which is a sale event, not a
  // market drawdown — so we truncate at the first zero that follows a positive value. This
  // isolates the sequence/timing risk on the binding asset (its realized CAGR and worst
  // peak-to-trough dip while still held) from the sale artifact.
  const houseSeries = (timeSeries ?? []).map(p => p.houseValueUsd ?? 0);
  let hStart = houseSeries.findIndex(v => v > 0);
  let houseCagr = null, houseMaxDrawdown = null;
  if (hStart >= 0) {
    let hEnd = hStart;
    while (hEnd + 1 < houseSeries.length && houseSeries[hEnd + 1] > 0) hEnd++;
    if (hEnd > hStart) {
      const a = houseSeries[hStart], b = houseSeries[hEnd];
      houseCagr = Math.pow(b / a, 1 / (hEnd - hStart)) - 1;
      let peak = -Infinity; houseMaxDrawdown = 0;
      for (let t = hStart; t <= hEnd; t++) {
        const v = houseSeries[t];
        if (v > peak) peak = v;
        if (peak > 0) houseMaxDrawdown = Math.max(houseMaxDrawdown, (peak - v) / peak);
      }
    }
  }

  return {
    netWorthCagr, worst5yrCagr, maxDrawdown, decadeNetWorthUsd, houseCagr, houseMaxDrawdown,
    minRealNetLiquidity, minRealNetLiquidityYear,
    troughRealNetLiquidity, troughRealNetLiquidityYear, troughRealDrawdown,
  };
}
