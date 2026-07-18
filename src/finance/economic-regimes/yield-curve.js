/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { RATE_KEY_META } from './rate-keys.js';

/**
 * Yield curve — the term-structure primitive (design 67).
 *
 * Representation C (anchor + shape overlay): the single
 * `effectiveInterestRates[FIXED_INCOME_{country}]` scalar remains the LEVEL anchor
 * (the 5-year point, still moved by RegimeApplyReducer as a parallel shift), and a
 * separate additive SHAPE — `state.yieldCurve[country]`, an array of
 * `{ tenor, spread }` anchor points — is layered on top. A bond's yield at its own
 * tenor is `level + interpolateSpread(shape, tenor)`.
 *
 * An empty/absent shape ⇒ every spread is 0 ⇒ every tenor returns the anchor ⇒ a
 * flat curve, byte-identical to the pre-67 single-rate model. The 5-year point is
 * conventionally the anchor (spread 0), so a perpetual fund resolved at its 5y
 * `defaultDuration` tenor is unchanged even under a sloped curve.
 */

/**
 * Country a FIXED_INCOME_* rate key belongs to ('US' / 'AU'), or null for a key
 * with no country suffix. Used to select the curve shape from the holding's own
 * rate key (independent US and AU curves — design 67 §9 Q6).
 *
 * @param {string|null|undefined} rateKey
 * @returns {'US'|'AU'|null}
 */
export function countryOfRateKey(rateKey) {
  if (typeof rateKey !== 'string') return null;
  if (rateKey.endsWith('_US')) return 'US';
  if (rateKey.endsWith('_AU')) return 'AU';
  return null;
}

/**
 * The additive spread at `tenorYears` for a curve shape, by piecewise-LINEAR
 * interpolation between `{ tenor, spread }` anchor points, CLAMPED to the endpoints
 * (a tenor before the first / after the last point returns that endpoint's spread).
 *
 * An empty/absent/degenerate `points` returns 0 (a flat curve — the back-compat
 * identity). Malformed points (non-finite tenor/spread) are ignored.
 *
 * @param {Array<{tenor:number, spread:number}>|null|undefined} points
 * @param {number|null|undefined} tenorYears
 * @returns {number}
 */
export function interpolateSpread(points, tenorYears) {
  if (!Array.isArray(points) || points.length === 0) return 0;
  const pts = points
    .filter(p => p && Number.isFinite(p.tenor) && Number.isFinite(p.spread))
    .sort((a, b) => a.tenor - b.tenor);
  if (pts.length === 0) return 0;

  const t = Number.isFinite(tenorYears) ? tenorYears : 0;
  if (t <= pts[0].tenor)               return pts[0].spread;
  if (t >= pts[pts.length - 1].tenor)  return pts[pts.length - 1].spread;

  for (let i = 1; i < pts.length; i++) {
    if (t <= pts[i].tenor) {
      const a = pts[i - 1];
      const b = pts[i];
      const frac = (t - a.tenor) / (b.tenor - a.tenor);
      return a.spread + frac * (b.spread - a.spread);
    }
  }
  return pts[pts.length - 1].spread;   // unreachable (clamped above); defensive
}

/**
 * The market yield for a bond at its own tenor (design 67 §3 accessor):
 *
 *     resolveYield(state, { rateKey, stateKey, tenorYears })
 *         = level(effectiveInterestRates)          // per-account `<rateKey>::<stateKey>`
 *                                                  //   override → shared `<rateKey>`
 *         + interpolateSpread(yieldCurve[country], tenor)   // shape (0 when absent)
 *
 * The country is derived from `rateKey` (FIXED_INCOME_US→US, _AU→AU) unless an
 * explicit `country` is passed. A `null`/absent `tenorYears` (a perpetual fund with
 * no `maturityDate`) resolves at the FUND tenor = `RATE_KEY_META[rateKey].defaultDuration`
 * (5y — the anchor point), keeping the flat-curve identity for funds.
 *
 * Returns **null** when the anchor level is absent (or `state`/`rateKey` is missing),
 * so the coupon-stamp / roll consumers can fall back to their own per-account rate —
 * exactly the pre-67 `?? null` behavior. When a level IS present, the shape spread
 * (default 0) is layered on.
 *
 * @param {object} state
 * @param {object} opts
 * @param {string|null} opts.rateKey
 * @param {string|null} [opts.stateKey]   - per-account key for the `<rateKey>::<stateKey>` override
 * @param {'US'|'AU'|null} [opts.country] - overrides the country derived from rateKey
 * @param {number|null} [opts.tenorYears] - null ⇒ the fund (defaultDuration) tenor
 * @returns {number|null}
 */
export function resolveYield(state, { rateKey, stateKey = null, country = null, tenorYears = null } = {}) {
  const rates = state?.effectiveInterestRates;
  if (!rates || rateKey == null) return null;
  const perAcct = (stateKey != null) ? rates[`${rateKey}::${stateKey}`] : undefined;
  const level   = perAcct ?? rates[rateKey];
  if (level == null) return null;

  const cc        = country ?? countryOfRateKey(rateKey);
  const fundTenor = RATE_KEY_META[rateKey]?.defaultDuration ?? 0;
  const tenor     = (tenorYears != null) ? tenorYears : fundTenor;
  const shape     = state?.yieldCurve?.[cc];
  return level + interpolateSpread(shape, tenor);
}
