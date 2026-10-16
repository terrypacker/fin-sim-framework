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
import { expectedInflationDeviation, inflationProcessConfig } from './inflation-tick-handler.js';

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

/**
 * The realised inflation over the trailing 12 months for `cc` (design 121 §8, Q6): the price
 * level now over the level a year ago, less one.
 *
 * Read off `state.bracketIndexAccumulatorByYear[cc]`, the per-period-year level history
 * `InflationAdjustReducer` already records, less that series' constant spread
 * (`bracketIndexSpreads[cc]`, 0 by default) to recover CPI itself. The history steps once a
 * year at the period advance, by the inflation of the year just ended, so `level(Y) /
 * level(Y − 1)` IS the trailing year. Reusing it rather than recording a new level keeps every
 * whole-state fixture byte-identical. With no history yet (before a period advance, or a run
 * with every series flat) it falls back to the current effective rate, which is what the
 * trailing year would read in a run whose inflation never moved.
 *
 * @param {object} state
 * @param {'US'|'AU'} cc
 * @returns {number}
 */
export function trailingInflation(state, cc) {
  const levels = state?.bracketIndexAccumulatorByYear?.[cc];
  const year   = new Date(state?.currentPeriods?.[cc]?.startMs ?? NaN).getUTCFullYear();
  const now    = Number.isFinite(year) ? levels?.[year]     : undefined;
  const prior  = Number.isFinite(year) ? levels?.[year - 1] : undefined;
  if (now > 0 && prior > 0) return now / prior - 1 - (state?.bracketIndexSpreads?.[cc] ?? 0);
  return currentInflation(state, cc);
}

/** The effective inflation rate in force now for `cc`. */
function currentInflation(state, cc) {
  return state?.effectiveInflationRates?.[cc] ?? state?.inflationRates?.[cc] ?? 0;
}

/** How a TIPS market real yield reads expected inflation (design 125 §4). */
export const TIPS_EXPECTED_INFLATION_MODES = ['TENOR', 'TRAILING', 'CURRENT'];

/**
 * The expectation spec the bond reducers carry (design 125 §4): the mode, and the inflation
 * process it forecasts with. Built once from the scenario's params so the build and the roll
 * read the same thing.
 *
 * @param {object} p  the scenario's parameters
 * @returns {{ mode: string, process: object }}
 */
export function tipsExpectationSpec(p) {
  return { mode: p?.bondLadderTipsExpectedInflation ?? 'TENOR', process: inflationProcessConfig(p ?? {}) };
}

/**
 * The inflation a TIPS rung of `tenorYears` expects over its life (design 125), by mode:
 *
 *   - TRAILING (also with no spec): `trailingInflation`, design 121's rule.
 *   - CURRENT: the effective rate now, π₀.
 *   - TENOR: the average over the tenor of the expected path from π₀ to the anchor A, one step a
 *     year as the rate itself steps (§3 C). Year k (0 = this year, which accrues at π₀) weighs
 *     the share of it inside the tenor. With the stochastic path on, its part of π₀ − A
 *     (`inflationDev`) follows the latent factors exactly as the tick walks them
 *     (`expectedInflationDeviation`); the rest (a regime's adjustment, the floor's clamp, or all
 *     of it with the path off) decays at the latent's autocorrelation
 *     w·a_g^k + (1 − w)·a^k, the best forecast without the split. No regime foresight (Q3).
 *
 * @param {object} state
 * @param {'US'|'AU'} cc
 * @param {number|null} tenorYears
 * @param {{ mode?: string, process?: object }|null} [spec]
 * @returns {number}
 */
export function expectedInflation(state, cc, tenorYears, spec = null) {
  const mode = spec?.mode ?? 'TRAILING';
  if (mode === 'TRAILING') return trailingInflation(state, cc);
  const now = currentInflation(state, cc);
  if (mode === 'CURRENT') return now;

  const anchor = state?.baseInflationRates?.[cc];
  const T      = Number.isFinite(tenorYears) ? tenorYears : 0;
  if (anchor == null || !(T > 0)) return now;

  const pr    = spec.process ?? {};
  const joint = pr.model === 'HISTORICAL_JOINT';
  const w     = Math.min(1, Math.max(0, (joint ? pr.globalShareJoint : pr.globalShare) ?? 0));
  const ag    = Math.exp(-(pr.globalReversionSpeed ?? 0.1));
  const a     = Math.exp(-(pr.reversionSpeed?.[cc] ?? 0.33));
  const latent = state?.inflationLatent;
  const dev    = state?.inflationDev?.[cc];
  const onPath = latent != null && Number.isFinite(dev);
  const residual = now - anchor - (onPath ? dev : 0);
  const procOpts = { anchor, bound: pr.lowerBound?.[cc] ?? -0.01, vol: pr.vol?.[cc] ?? 0, w, ag, a, joint };

  let sum = 0;
  for (let k = 0; k < T; k++) {
    const weight = Math.min(1, T - k);
    const path   = onPath ? expectedInflationDeviation(latent, cc, k, procOpts) : 0;
    sum += weight * (path + residual * (w * ag ** k + (1 - w) * a ** k));
  }
  return anchor + sum / T;
}

/**
 * The market REAL yield an inflation-linked bond prices at (design 121 §8): the nominal curve
 * yield at `tenorYears` less the inflation expected over that tenor (design 125; trailing
 * inflation with no `expectation`). A null tenor is the fund tenor on both halves. No floor:
 * real yields were negative in the 1970s and in 2020-21, and the deflation floor on principal
 * is separate. Null when the nominal anchor is absent, so a caller keeps its own fallback.
 *
 * @param {object} state
 * @param {{ rateKey: string, tenorYears?: number|null, stateKey?: string|null, expectation?: object|null }} opts
 * @returns {number|null}
 */
export function tipsRealYield(state, { rateKey, tenorYears = null, stateKey = null, expectation = null } = {}) {
  const nominal = resolveYield(state, { rateKey, tenorYears, stateKey });
  if (nominal == null) return null;
  const tenor = tenorYears ?? RATE_KEY_META[rateKey]?.defaultDuration ?? 0;
  return nominal - expectedInflation(state, countryOfRateKey(rateKey), tenor, expectation);
}

/**
 * Compose an effective curve shape from a base shape + a set of additive TWISTS
 * (design 67 §6, Phase 3). Each twist is `{ points, factor }` — a `{tenor, spread}`
 * shape whose spreads are added (scaled by `factor`, the regime's recovery factor)
 * on top of the base. The result is evaluated on the UNION of all tenor grids so a
 * twist can enrich the curve with a new tenor (e.g. a 2y inversion point):
 *
 *     spread(τ) = interpolateSpread(base, τ) + Σ_twist factor·interpolateSpread(points, τ)
 *
 * With **no** twists it returns the base shape *by reference* (the caller relies on
 * this to keep a twist-free period byte-identical to Phase 2). Spreads are rounded
 * to 1e-6 to keep the composed grid stable across periods.
 *
 * @param {Array<{tenor:number,spread:number}>|null} baseShape
 * @param {Array<{points:Array, factor:number}>|null} twists
 * @returns {Array<{tenor:number, spread:number}>}
 */
export function composeYieldCurve(baseShape, twists) {
  const active = (twists ?? []).filter(t => Array.isArray(t?.points) && t.points.length > 0 && (t.factor ?? 0) !== 0);
  if (active.length === 0) return baseShape ?? [];

  const grid = new Set();
  for (const p of (baseShape ?? [])) if (Number.isFinite(p?.tenor)) grid.add(p.tenor);
  for (const t of active) for (const p of t.points) if (Number.isFinite(p?.tenor)) grid.add(p.tenor);

  return [...grid].sort((a, b) => a - b).map(tenor => {
    let spread = interpolateSpread(baseShape, tenor);
    for (const t of active) spread += (t.factor ?? 1) * interpolateSpread(t.points, tenor);
    return { tenor, spread: +spread.toFixed(6) };
  });
}

/**
 * The additive TWIST that turns `baseShape` into `absShape`: for each tenor in the
 * union grid, `absSpread(τ) − baseSpread(τ)` (design 67 §6). Composing this twist at
 * factor 1 reproduces `absShape` exactly (`base + (abs − base) = abs`), so a scheduled
 * curve that specifies an *absolute* target shape can flow through the same twist path
 * as a named shock. Used by the ECONOMIC_REGIMES `yieldCurveSchedule` compiler.
 *
 * @param {Array<{tenor:number,spread:number}>|null} absShape
 * @param {Array<{tenor:number,spread:number}>|null} baseShape
 * @returns {Array<{tenor:number, spread:number}>}
 */
export function shapeDelta(absShape, baseShape) {
  const grid = new Set();
  for (const p of (absShape ?? []))  if (Number.isFinite(p?.tenor)) grid.add(p.tenor);
  for (const p of (baseShape ?? [])) if (Number.isFinite(p?.tenor)) grid.add(p.tenor);
  return [...grid].sort((a, b) => a - b).map(tenor => ({
    tenor,
    spread: +(interpolateSpread(absShape, tenor) - interpolateSpread(baseShape, tenor)).toFixed(6),
  }));
}
