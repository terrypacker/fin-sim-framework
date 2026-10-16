/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { Reducer, PRIORITY } from '../../simulation-framework/reducers.js';
import { priceOf }           from '../holdings/holdings-earnings.js';
import { HandlerEntry }      from '../../simulation-framework/handlers.js';
import { EventSeries }       from '../../simulation-framework/events/event-series.js';
import { periodRate, multiplicativePrice } from '../holdings/earnings-cadence.js';

/**
 * Market and security index levels — design 101 §6 (M1).
 *
 *   marketIndex.<rateKey>.price / .total     one per market (the bare keys of baseGrowthRates)
 *   securityIndex.<securityId>.price / .total one per registry security tracking a market
 *   marketIndexAsOfMs                        the last 31 Dec whose growth the levels include
 *
 * Both start at 100 at sim start. `price` is what an index chart shows; `total` reinvests
 * the yield. They answer "what did the market do", which state never recorded: a holding's
 * value moves with flows, and `effectiveGrowthRates` is a rate, not a level.
 *
 * ─── the step mirrors the holdings, not a formula of its own ──────────────────────────
 *
 * Equity growth is applied ONCE A YEAR, on the 31 Dec `year-end` earnings events, at
 * factor 1, with the market's effective rate at that moment (`computeHoldingsGrowth`). A
 * taxable lot's price moves by `priceOf(total, yield)`, and a wrapper lot by the total.
 * The index takes exactly those two rates, through the same `priceOf`, so a lone β = 1 lot
 * with no flows tracks it exactly: `total` on the wrapper path, `price` on the taxable one.
 * A registry security adds its overlay (`securityReturnOverlay`) to both, and its own
 * yield replaces the market's, as `baseDividendYield` does for its lots.
 *
 * Per-account rate seeding (`<rateKey>::<stateKey>`) is excluded on purpose: the index is
 * the market, not one account's view of it (§6.1).
 *
 * ─── the carrier (Q2) ─────────────────────────────────────────────────────────────────
 *
 * The step rides the period advances (`US_PERIOD_ADVANCE` on 1 Jan, `AU_PERIOD_ADVANCE`
 * on 1 Jul), not an event of its own: any new event re-resolves same-date ties across the
 * run and would re-gold every fixture with ordering noise. It cannot ride the earnings
 * applies either, since those are per account, and an empty account short-circuits
 * without one. The advances exist in every scenario with a tax toolset.
 *
 * It runs at PRE_PROCESS + 0.5, after PeriodAdvanceReducer (10) and BEFORE RegimeApplyReducer
 * (11) resets `effectiveGrowthRates` and EquityReturnReducer (11.5) folds next year's
 * draw and republishes the overlay. So it reads the rates the 31 Dec growth used, a day
 * (US) or six months (AU-only) later. It steps once per 31 Dec passed since
 * `marketIndexAsOfMs`, so whichever advance comes first after a year-end takes the step
 * and the other finds nothing to do.
 *
 * Shocks reach the index through RevalueAssetReducer (`markDownIndexLevels`), with the
 * same multiplier it applies to the holdings.
 *
 * ─── design 127: MONTHLY earnings ─────────────────────────────────────────────────────
 *
 * Under MONTHLY the lots grow at every month-end, so the index must too or a watchlist reads
 * a level up to a year stale. A month-end `MARKET_INDEX_STEP` (order 0.5, after the month's
 * growth and dividends) steps it one period at the period rates the lots used, through the
 * same `multiplicativePrice` / `periodRate`, and moves `marketIndexAsOfMs` to that month-end.
 * The period advances then find no 31 Dec after the as-of date and step nothing, so the
 * annual path needs no flag: the seed's as-of (the last 31 Dec before the start) is always
 * followed by a month-end step before any advance can count a year-end.
 */

export const INDEX_BASE = 100;

/** The markets an index is kept for: the bare keys of a rate map (per-account keys excluded). */
export function indexMarkets(rates) {
  return Object.keys(rates ?? {}).filter(k => !k.includes('::'));
}

/** The last equity year-end (31 Dec 00:00 UTC, `DateUtils.endOfYear`) strictly before `ms`. */
export function lastYearEndBefore(ms) {
  const y = new Date(ms).getUTCFullYear();
  const thisYears = Date.UTC(y, 11, 31);
  return thisYears < ms ? thisYears : Date.UTC(y - 1, 11, 31);
}

/** How many 31 Dec year-ends fall in (fromMs, toMs]. */
export function yearEndsBetween(fromMs, toMs) {
  if (!(toMs > fromMs)) return 0;
  let n = 0;
  for (let y = new Date(fromMs).getUTCFullYear(); Date.UTC(y, 11, 31) <= toMs; y++) {
    if (Date.UTC(y, 11, 31) > fromMs) n++;
  }
  return n;
}

/**
 * The initial levels: 100 for every market in `state.baseGrowthRates` and every registry
 * security that tracks one. Empty (no patch) when the state carries no growth rates,
 * i.e. a scenario without the economic-regimes toolset.
 *
 * @param {object} state    reads baseGrowthRates, securities
 * @param {number} startMs  sim start: growth on a 31 Dec at or after it is still to come
 */
export function seedIndexLevels(state, startMs) {
  if (!state?.baseGrowthRates || !Number.isFinite(startMs)) return {};
  const marketIndex = {};
  for (const k of indexMarkets(state.baseGrowthRates)) marketIndex[k] = { price: INDEX_BASE, total: INDEX_BASE };
  const securityIndex = {};
  for (const [id, sec] of Object.entries(state.securities ?? {})) {
    if (sec?.rateKey && marketIndex[sec.rateKey]) securityIndex[id] = { price: INDEX_BASE, total: INDEX_BASE };
  }
  return { marketIndex, securityIndex, marketIndexAsOfMs: lastYearEndBefore(startMs) };
}

function grow(level, rate, n) {
  let v = level;
  for (let i = 0; i < n; i++) v *= 1 + rate;
  return v;
}

/**
 * Advance every level `n` equity years at the current effective rates.
 * A market with no effective rate keeps its level.
 *
 * Design 127: `periodsPerYear` above 1 makes each of the `n` steps one period, at the
 * period rate of the lots' sub-annual split (see the file header).
 */
export function stepIndexLevels(state, n, periodsPerYear = 1) {
  const eff     = state.effectiveGrowthRates ?? {};
  const yields  = state.marketDividendYields ?? {};
  const overlay = state.securityReturnOverlay ?? {};
  const sub     = periodsPerYear !== 1;
  const priceR  = (total, yld, o = 0) => sub
    ? periodRate(multiplicativePrice(total, yld) + o, periodsPerYear)
    : priceOf(total, yld) + o;
  const totalR  = (total, o = 0) => sub ? periodRate(total + o, periodsPerYear) : total + o;

  const marketIndex = { ...state.marketIndex };
  for (const [k, lv] of Object.entries(state.marketIndex ?? {})) {
    const total = eff[k];
    if (total == null) continue;
    marketIndex[k] = sub
      ? { price: grow(lv.price, priceR(total, yields[k] ?? 0), n), total: grow(lv.total, totalR(total), n) }
      : { price: grow(lv.price, priceOf(total, yields[k] ?? 0), n), total: grow(lv.total, total, n) };
  }

  const securityIndex = { ...(state.securityIndex ?? {}) };
  for (const [id, lv] of Object.entries(state.securityIndex ?? {})) {
    const sec   = state.securities?.[id];
    const total = sec ? eff[sec.rateKey] : null;
    if (total == null) continue;
    const o   = overlay[id] ?? 0;
    const yld = sec.dividendYield ?? yields[sec.rateKey] ?? 0;
    securityIndex[id] = {
      price: grow(lv.price, priceR(total, yld, o), n),
      total: grow(lv.total, totalR(total, o), n),
    };
  }
  return { marketIndex, securityIndex };
}

/**
 * A shock's instantaneous markdown (RevalueAssetReducer's multiplier) applied to the
 * shocked market and every security tracking it. Empty when there is no index or no
 * level for that key (a property or FX series).
 */
export function markDownIndexLevels(state, rateKey, multiplier) {
  if (!state?.marketIndex || multiplier == null) return {};
  const hit = lv => ({
    price: Math.max(0, lv.price * (1 + multiplier)),
    total: Math.max(0, lv.total * (1 + multiplier)),
  });
  const patch = {};
  if (state.marketIndex[rateKey]) patch.marketIndex = { ...state.marketIndex, [rateKey]: hit(state.marketIndex[rateKey]) };
  let sec = null;
  for (const [id, lv] of Object.entries(state.securityIndex ?? {})) {
    if (state.securities?.[id]?.rateKey !== rateKey) continue;
    sec ??= { ...state.securityIndex };
    sec[id] = hit(lv);
  }
  if (sec) patch.securityIndex = sec;
  return patch;
}

/**
 * MarketIndexReducer — steps the index levels at the period advance that follows each
 * 31 Dec equity year-end. See the file header for why it rides the advances.
 */
export class MarketIndexReducer extends Reducer {
  static type        = 'MarketIndexReducer';
  static description = 'Advances marketIndex / securityIndex by each market\'s effective price and total return for every 31 Dec passed, at the next period advance, before the regime reset (design 101 §6).';

  constructor() {
    super('Market Index', PRIORITY.PRE_PROCESS + 0.5);
    this.reducedActionTypes = ['US_PERIOD_ADVANCE', 'AU_PERIOD_ADVANCE', 'MARKET_INDEX_STEP_APPLY'];
  }

  reduce(state, action, currentDate) {
    if (!state.marketIndex) return this.newState(state);
    const when  = currentDate ?? action?.date ?? null;
    const nowMs = when == null ? NaN : new Date(when).getTime();
    if (!Number.isFinite(nowMs)) return this.newState(state);
    // Design 127 — one sub-annual period, then the as-of moves to today.
    if (action?.type === 'MARKET_INDEX_STEP_APPLY') {
      return this.newState(state, {
        ...stepIndexLevels(state, 1, action.periodsPerYear ?? 12),
        marketIndexAsOfMs: nowMs,
      });
    }
    const asOf = state.marketIndexAsOfMs ?? lastYearEndBefore(nowMs);
    const n    = yearEndsBetween(asOf, nowMs);
    if (n === 0) return this.newState(state);
    return this.newState(state, {
      ...stepIndexLevels(state, n),
      marketIndexAsOfMs: lastYearEndBefore(nowMs + 1),
    });
  }
}

/** Design 127 — the month-end order of the index step: after the day's growth and dividends. */
export const MARKET_INDEX_STEP_ORDER = 0.5;

/** The month-end series that steps the index under MONTHLY earnings. @returns {EventSeries} */
export function buildMarketIndexStepSeries() {
  return new EventSeries({
    name:     'Market Index Step',
    type:     'MARKET_INDEX_STEP',
    interval: 'month-end',
    order:    MARKET_INDEX_STEP_ORDER,
    data:     { periodsPerYear: 12 },
    enabled:  true,
    color:    '#78909C',
  });
}

/** Emits the step for MarketIndexReducer (design 127). */
export class MarketIndexStepHandler extends HandlerEntry {
  static description = 'Steps the market and security index levels by one sub-annual period under MONTHLY equity earnings (design 127 §4.2).';
  static type        = 'MarketIndexStepHandler';
  static eventType   = 'MARKET_INDEX_STEP';

  constructor() {
    super(null, 'Market Index Step');
    this.generatedActionTypes = ['MARKET_INDEX_STEP_APPLY'];
  }

  static fromJSON(d) {
    const h = new this();
    h.id = d.id;
    return h;
  }

  call({ state, data }) {
    if (!state.marketIndex) return [];
    return [{ type: 'MARKET_INDEX_STEP_APPLY', periodsPerYear: data?.periodsPerYear ?? 12 }];
  }
}
