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
 * couponless-yield.js — what a BOND lot with no contractual coupon earns (design 99 D-6).
 *
 * A lot that names its own `couponRate` pays it: a fixed contractual coupon, untouched by
 * rate moves (design 53 §4). A lot that names none is a bond FUND (no `maturityDate`) or an
 * authored bond whose coupon was never stamped. Until design 99 P5 it paid the flat market
 * param the handler carried — not regime-adjusted and blind to the curve's shape. It now
 * FLOATS: the regime-adjusted curve at its remaining tenor, a fund at the fund tenor (the
 * 5y anchor, where the default curve's spread is 0).
 *
 * Two kinds of lot must not float, and get null (the caller's existing fallback):
 *   - inflation-linked — the engine's curve is nominal, and paying a nominal yield on a
 *     CPI-indexed principal would compensate for inflation twice (the same reason the
 *     maturity roll holds a TIPS's real yield flat);
 *   - zero-coupon — its return is accretion (design 66 §G6), not a coupon.
 */

import { resolveYield } from './yield-curve.js';

/**
 * One year in ms for BOND TENOR — the same constant the bond price reducer marks durations
 * with. Deliberately not `YEAR_MS`: `holdings/holding-period.js` exports that name as a
 * 365-day year (the 12-month holding tests), and the generated index can bind a name to only
 * one of them.
 */
export const BOND_YEAR_MS = 365.25 * 24 * 60 * 60 * 1000;

/**
 * Years from `asOfMs` to a holding's maturity (design 66 §G4). Returns null when the
 * holding is a bond *fund* (no `maturityDate`) or the as-of date is unknown, in which case
 * the caller keeps the perpetual-fund behavior. Floored at 0 (a bond at/after maturity has
 * 0 years left — BondMaturityReducer redeems it).
 *
 * Takes the INSTRUMENT view (design 94 §5.1): a maturity date is a fact about the bond.
 *
 * @param {object} inst     - instrument view of a holding (`instrumentOf`)
 * @param {number|null} asOfMs
 * @returns {number|null}
 */
export function yearsToMaturity(inst, asOfMs) {
  if (inst?.maturityDate == null || asOfMs == null) return null;
  const matMs = inst.maturityDate instanceof Date ? inst.maturityDate.getTime() : new Date(inst.maturityDate).getTime();
  if (!Number.isFinite(matMs)) return null;
  return Math.max(0, (matMs - asOfMs) / BOND_YEAR_MS);
}

/**
 * The yield a coupon-less BOND lot earns: the regime-adjusted curve at its remaining tenor.
 *
 * @param {object} state                     - reads `effectiveInterestRates` and `yieldCurve`
 * @param {object} inst                      - instrument view of the lot (needs `rateKey`)
 * @param {object} [opts]
 * @param {string|null} [opts.stateKey]      - for a per-account `<rateKey>::<stateKey>` level
 * @param {Date|string|number|null} [opts.asOf] - the date the coupon accrues to
 * @returns {number|null} null when the lot must not float, or no curve level is in state
 */
export function couponlessYield(state, inst, { stateKey = null, asOf = null } = {}) {
  if (!inst?.rateKey || inst.inflationLinked || inst.zeroCoupon) return null;
  const asOfMs = asOf == null ? null : new Date(asOf).getTime();
  return resolveYield(state, {
    rateKey:    inst.rateKey,
    stateKey,
    tenorYears: yearsToMaturity(inst, Number.isFinite(asOfMs) ? asOfMs : null),
  });
}
