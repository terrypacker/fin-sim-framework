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
 * The currency overlay on a foreign-equity lot — design 120 §4, §5.6.
 *
 * A market's total return is sourced on the UNHEDGED basis for the holder's currency
 * (D99 §6.6), and the engine applies no FX to equity. That stays true for every lot whose
 * instrument says nothing about hedging. A security that declares a `hedgeRatio` h opts its
 * lots into the overlay, which turns the year's growth rate g into
 *
 *     (1 + g)(1 + (1 − h)·f) − 1 + h·(carry − cost)
 *
 * where f is the year's move in the home-currency price of the exposure currency and
 * carry the policy-rate gap a rolling FX hedge earns. It is applied as the ADDITIVE delta
 *
 *     Δ = (1 − h)·f·(1 + g) + h·(carry − cost)
 *
 * so that h = 0 with a flat rate adds exactly 0 and the lot's arithmetic is unchanged to
 * the bit, rather than passing g through a `(1 + g)·1 − 1` that is not g in binary.
 *
 * The hedge's own result, per dollar of the lot, is H = h·(carry − cost − f·(1 + g)): the
 * difference between the hedged and the unhedged line. §5.7 routes it by the security's
 * `hedgeTaxTreatment`.
 *
 * Pure functions over plain state; nothing here writes state.
 */

import { RATE_KEYS } from '../economic-regimes/rate-keys.js';

/**
 * The markets with a currency exposure the overlay can price, keyed by rate key (§5.2).
 *
 * One today. `EQUITY_INTL_EX_AU` held in AUD is the only pair every §3 source is about
 * (Q2), and the model has one currency pair, so the basket's currency is proxied by USD:
 * the US is 74.07% of the index (§3.5). `volScale` scales the pair's log move to the
 * basket's — J.P. Morgan's numbers imply a 9.86% basket FX vol against USD/AUD's 11.42%
 * (§3, Q3).
 */
export const FX_EXPOSURE_BY_MARKET = Object.freeze({
  [RATE_KEYS.EQUITY_INTL_EX_AU]: Object.freeze({
    home:           'AUD',
    homeCountry:    'AU',
    foreignCountry: 'US',
    pair:           'USD_AUD',
    volScale:       0.86,
  }),
});

/** §5.7 — whether the fund's hedge result stays in the price (TOFA election) or moves the distribution. */
export const HEDGE_TAX_TREATMENTS = Object.freeze(['ALIGNED', 'INCOME']);

/** Q8 — a hedged security that states no treatment: the TOFA hedging election (VGAD from FY2025). */
export const DEFAULT_HEDGE_TAX_TREATMENT = 'ALIGNED';

/** §5.6 / Q5 — the foreign policy rate when the plan does not load that country's Prime. */
export const DEFAULT_HEDGE_FOREIGN_CASH_RATE = 0.045;

/** §3.4 — forward-roll cost, the midpoint of Morningstar's 0.02–0.03% for major currencies. */
export const DEFAULT_HEDGE_COST = 0.00025;

const PRIME_KEY = { US: RATE_KEYS.PRIME_US, AU: RATE_KEYS.PRIME_AU };

/**
 * The hedge ratio a lot runs at, or null when its instrument is silent (no overlay).
 *
 * @param {object} inst - the lot's instrument view (`instrumentOf`)
 * @param {object} [state] - reads `hedgeOverlay.rebased`
 * @returns {number|null}
 */
export function hedgeRatioOf(inst, state = null) {
  const h = inst?.hedgeRatio;
  if (h != null) return h;
  // §5.5 — once the sleeve runs on the local-currency basis, a silent lot is unhedged: the
  // overlay is now where its currency risk comes from.
  return state?.hedgeOverlay?.rebased ? 0 : null;
}

/**
 * The exposure a lot in this account carries, or null when the overlay does not apply:
 * a market the overlay cannot price, or one held in its own currency.
 *
 * @param {string|null} rateKey
 * @param {object} account - the account's state record (reads `currency.code`)
 * @returns {object|null}
 */
export function fxExposureOf(rateKey, account) {
  const exp = rateKey != null ? FX_EXPOSURE_BY_MARKET[rateKey] : null;
  if (!exp) return null;
  const ccy = account?.currency?.code ?? account?.currency ?? null;
  return ccy === exp.home ? exp : null;
}

/**
 * f — the move in the home-currency price of the exposure currency since the last
 * year-end mark, scaled to the basket (§5.2). 0 when the plan runs no FX layer or has not
 * marked the pair: a flat rate moves nothing.
 *
 * @param {object} state
 * @param {object} exposure - an `FX_EXPOSURE_BY_MARKET` entry
 * @returns {number}
 */
export function fxMoveFor(state, exposure) {
  const now  = state?.effectiveExchangeRates?.[exposure.pair];
  const mark = state?.hedgeOverlay?.fxMark?.[exposure.pair];
  if (!(now > 0) || !(mark > 0) || now === mark) return 0;
  return Math.exp(exposure.volScale * Math.log(now / mark)) - 1;
}

/**
 * carry — the policy-rate gap a rolling hedge earns: home Prime less foreign Prime (§5.6).
 * The foreign rate falls back to `hedgeOverlay.foreignCashRate` where the plan does not
 * load that country's Prime (an AU-only plan has no US prime). No home Prime, no carry.
 *
 * @param {object} state
 * @param {object} exposure
 * @returns {number}
 */
export function hedgeCarryFor(state, exposure) {
  const rates = state?.effectiveInterestRates ?? {};
  const home  = rates[PRIME_KEY[exposure.homeCountry]];
  if (home == null) return 0;
  const foreign = rates[PRIME_KEY[exposure.foreignCountry]]
    ?? state?.hedgeOverlay?.foreignCashRate ?? DEFAULT_HEDGE_FOREIGN_CASH_RATE;
  return home - foreign;
}

/**
 * The overlay on one lot's growth rate, or null when it does not apply.
 *
 * @param {object} opts
 * @param {object} opts.state
 * @param {object} opts.account  - the account's state record
 * @param {object} opts.inst     - the lot's instrument view
 * @param {string|null} opts.rateKey - the lot's resolved market
 * @param {number} opts.g        - the growth rate the lot gets without the overlay
 * @returns {{ delta: number, hedgeResult: number, f: number, carry: number, h: number }|null}
 */
export function currencyOverlay({ state, account, inst, rateKey, g }) {
  const h = hedgeRatioOf(inst, state);
  if (h == null) return null;
  const exposure = fxExposureOf(rateKey, account);
  if (!exposure) return null;
  const f     = fxMoveFor(state, exposure);
  const carry = h > 0 ? hedgeCarryFor(state, exposure) : 0;
  const cost  = h > 0 ? (state?.hedgeOverlay?.cost ?? DEFAULT_HEDGE_COST) : 0;
  const delta = (1 - h) * f * (1 + g) + h * (carry - cost);
  const hedgeResult = h * (carry - cost - f * (1 + g));
  return { delta, hedgeResult, f, carry, h };
}
