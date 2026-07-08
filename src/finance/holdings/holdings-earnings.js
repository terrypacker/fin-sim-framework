/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { HoldingTransactAction }    from './holding-actions.js';
import { resolveScheduledRate }     from './appreciation-schedule-utils.js';

/**
 * Walk an account's holdings, compute per-holding growth using
 * state[rateSource][holding.rateKey] (falling back to the handler-supplied
 * rate), and return:
 *
 *   - `amount`           — the total Σ per-holding growth (rounded to 2 dp),
 *                          which the calling handler emits as the *_EARNINGS_APPLY
 *                          (or *_INTEREST_CREDIT) action's `amount` so existing
 *                          tax / RMD / UI math keeps working off account.balance.
 *   - `holdingActions`   — one HoldingTransactAction per non-zero-growth
 *                          holding, with marketValueDelta = growth and
 *                          costBasisDelta = 0 (appreciation does not raise basis).
 *
 * For single-holding accounts (the bootstrap default), the arithmetic
 * collapses to the same `balance × rate` as the pre-substrate code path —
 * existing tests remain green.
 *
 * For multi-holding accounts (toolset-declared splits), each sleeve grows at
 * its own regime-adjusted rate and the total still flows through the
 * downstream _APPLY reducer unchanged.
 *
 * Emission contract: the holding actions MUST be emitted AFTER the matching
 * *_EARNINGS_APPLY action so the existing reducer (CASH_FLOW) updates
 * balance first; HoldingTransactReducer (POSITION_UPDATE) then patches
 * holdings and re-syncs balance to the same value.
 *
 * @param {object} opts
 * @param {object} opts.state              - Current simulation state
 * @param {string} opts.stateKey           - state[stateKey] is the account
 * @param {number} opts.fallbackRate       - Rate to use when state has no effective rate for the holding
 * @param {string} opts.fallbackRateKey    - RATE_KEYS entry to look up when a holding has no rateKey
 * @param {string} [opts.rateSource='effectiveGrowthRates']
 *                                          - 'effectiveGrowthRates' (equity-style)
 *                                            or 'effectiveInterestRates' (interest-bearing)
 * @param {number} [opts.factor=1]         - Multiplier applied to (mv × rate): 1 = annual,
 *                                            1/12 = monthly
 * @param {number|null} [opts.rateOverride=null]
 *                                          - When provided, used for every holding,
 *                                            bypassing the effective-rates map and
 *                                            per-holding rateKey entirely. Used by
 *                                            handlers that accept a `data.rate` one-off.
 * @param {Date|null} [opts.currentDate=null]
 *                                          - Current simulation date; used to resolve
 *                                            per-holding appreciationSchedule entries.
 *                                            When null, schedule lookup is skipped and
 *                                            the effective rate is used directly.
 * @returns {{ amount: number, holdingActions: HoldingTransactAction[] }}
 */
export function computeHoldingsGrowth({
  state,
  stateKey,
  fallbackRate,
  fallbackRateKey,
  rateSource   = 'effectiveGrowthRates',
  factor       = 1,
  rateOverride = null,
  currentDate  = null,
}) {
  const account  = state?.[stateKey];
  const holdings = account?.holdings ?? [];
  const ratesMap = state?.[rateSource] ?? {};
  const fbRate   = rateOverride ?? ratesMap[fallbackRateKey] ?? fallbackRate;

  if (!holdings.length) {
    // No holdings (defensive): fall back to the scalar-balance code path.
    const balance = account?.balance ?? 0;
    const amount  = +(balance * fbRate * factor).toFixed(2);
    return { amount, holdingActions: [] };
  }

  // On the fixed-income path, a non-null per-holding `couponRate` is a FIXED
  // contractual coupon — it is NOT re-adjusted by state.effectiveInterestRates
  // regime moves (a fixed-coupon bond pays its stated coupon regardless of where
  // market rates go; its price still marks to market via `duration`). It slots in
  // just ahead of the rateKey lookup, below the handler's one-off rateOverride,
  // matching the existing precedence. On the equity growth path (effectiveGrowthRates)
  // couponRate is a bond concept and is ignored. (design 53 §4)
  const useCoupon = rateSource === 'effectiveInterestRates';

  let total = 0;
  const holdingActions = [];
  for (const h of holdings) {
    if (!h) continue;
    const mv      = h.marketValue ?? 0;
    const baseRate = rateOverride
      ?? (useCoupon ? (h.couponRate ?? undefined) : undefined)
      ?? (h.rateKey != null ? ratesMap[h.rateKey] : undefined)
      ?? fbRate;
    const hRate   = (currentDate && h.appreciationSchedule)
      ? resolveScheduledRate(h.appreciationSchedule, currentDate, baseRate)
      : baseRate;
    const growth  = +(mv * hRate * factor).toFixed(2);
    total += growth;
    if (growth !== 0) {
      holdingActions.push(new HoldingTransactAction({
        stateKey,
        holdingId:        h.id,
        marketValueDelta: growth,
        costBasisDelta:   0,
      }));
    }
  }
  return { amount: +total.toFixed(2), holdingActions };
}

/**
 * Walk an account's holdings and compute per-holding dividends under any active
 * economic regime (design 28 §7 — dividend-yield cuts under regimes):
 *
 *   perHolding = marketValue × max(0, yield × (1 + adj))
 *
 * where `yield` is `holding.dividendYield ?? fallbackYield` and `adj` is the
 * active regime dividend adjustment for the holding's rate key
 * (`state.effectiveDividendAdjustments[holding.rateKey ?? fallbackRateKey] ?? 0`,
 * already scaled by each regime's recovery factor in RegimeApplyReducer). The
 * `max(0, …)` floors a full dividend suspension (adj ≤ -1) at zero.
 *
 * Returns the same `{ amount, holdingActions }` shape as computeHoldingsGrowth so
 * a handler can either emit the per-holding reinvestment actions (AU franked
 * dividends grow the sleeves) or use only the summed amount (US cash / account-
 * level apply). `costBasisDelta` is 0 — reinvested-dividend basis is raised at
 * the account level by the *_DIVIDEND_*_APPLY reducers, matching the
 * computeHoldingsGrowth precedent.
 *
 * Single-holding accounts (and the no-holdings fallback) collapse to
 * `balance × max(0, yield × (1 + adj))`, matching the pre-substrate code path
 * when no regime is active.
 *
 * @param {object} opts
 * @param {object} opts.state              - Current simulation state
 * @param {string} opts.stateKey           - state[stateKey] is the account
 * @param {number} opts.fallbackYield      - Account-level yield used when a holding has no dividendYield
 * @param {string|null} opts.fallbackRateKey - Rate key used when a holding has no rateKey
 * @returns {{ amount: number, holdingActions: HoldingTransactAction[] }}
 */
export function computeHoldingsDividends({ state, stateKey, fallbackYield, fallbackRateKey }) {
  const account  = state?.[stateKey];
  const holdings = account?.holdings ?? [];
  const adjMap   = state?.effectiveDividendAdjustments ?? {};

  const effYield = (yld, rk) => Math.max(0, yld * (1 + (adjMap[rk] ?? 0)));

  if (!holdings.length) {
    const balance = account?.balance ?? 0;
    const amount  = +(balance * effYield(fallbackYield, fallbackRateKey)).toFixed(2);
    return { amount, holdingActions: [] };
  }

  let total = 0;
  const holdingActions = [];
  for (const h of holdings) {
    if (!h) continue;
    const mv  = h.marketValue ?? 0;
    const yld = h.dividendYield ?? fallbackYield;
    const rk  = h.rateKey ?? fallbackRateKey;
    const div = +(mv * effYield(yld, rk)).toFixed(2);
    total += div;
    if (div !== 0) {
      holdingActions.push(new HoldingTransactAction({
        stateKey,
        holdingId:        h.id,
        marketValueDelta: div,
        costBasisDelta:   0,
      }));
    }
  }
  return { amount: +total.toFixed(2), holdingActions };
}
