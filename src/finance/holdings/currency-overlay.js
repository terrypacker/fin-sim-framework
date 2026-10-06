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
import { priceOf }   from './holdings-earnings.js';

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

/**
 * §5.1, Q6 — the hedge ratio a silent lot runs at once the sleeve is re-based, by account
 * role. Super hedges about a quarter of its foreign equity: APRA Table 9a, June 2026, gives
 * 110,764 hedged of 434,406 (\$m), 0.255, and the RBA puts it at "around 25 per cent"
 * (2023) and "around one-fifth" (2025). Every other role is unhedged (0), which is what an
 * AUD market return already assumed.
 */
export const DEFAULT_HEDGE_RATIO_BY_ROLE = Object.freeze({
  super: 0.255,
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
 * @param {object} [account] - the account's state record, for its role's default
 * @returns {number|null}
 */
export function hedgeRatioOf(inst, state = null, account = null) {
  const h = inst?.hedgeRatio;
  if (h != null) return h;
  // §5.5 — once the sleeve runs on the local-currency basis, a silent lot takes its
  // account's default (super 0.255, otherwise unhedged): the overlay is now where its
  // currency risk comes from.
  if (!state?.hedgeOverlay?.rebased) return null;
  return DEFAULT_HEDGE_RATIO_BY_ROLE[account?.role] ?? 0;
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
  const h = hedgeRatioOf(inst, state, account);
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

/**
 * §5.7 `INCOME` — a fund without the TOFA hedging election, whose hedge result moves its
 * distribution. Computed per SECURITY, on the fund's own year (the market's shared rate,
 * not any one account's seeded rate), because the carried loss is the fund's, not a lot's:
 *
 *     distributed  D′ = max(0, D + H − L)
 *     carried      L′ = max(0, L − D − H)
 *
 * D is the year's paid yield (after any regime dividend cut), H the hedge result and L the
 * loss carried in from earlier years, all per dollar of the lot. A positive H is assessable
 * as ordinary income (s275-105(2)(a), s775-15), which is how the AU brokerage already pays
 * an ex-AU distribution: unfranked, undiscounted, no offset. A negative H reduces the
 * year's components, to nil when it exceeds them (s276-265(2), (3)), and the rest is a
 * tax loss of the trust, carried forward (s36-15(2)) and never passed to the investor.
 *
 * The total return is unchanged: the price slice takes D − D′, so `INCOME` and `ALIGNED`
 * lots hold the same value at every year end.
 *
 * L is kept per dollar of the security's value and deflated by its unit-price move each
 * year (see `nextCarriedLoss`), which keeps it a per-UNIT amount: a lot bought after a loss
 * year inherits it, as a real unitholder does. Trust-loss tests are not modelled.
 *
 * Null unless the security declares `hedgeTaxTreatment: 'INCOME'`, a positive hedge ratio,
 * and a market the overlay prices.
 *
 * @param {object} state
 * @param {object} inst    - the security (or a lot's instrument view)
 * @param {string|null} rateKey
 * @returns {{ d: number, hedge: number, carriedIn: number, distributed: number,
 *             carriedOut: number, price: number }|null}
 */
export function incomeHedgeSplit(state, inst, rateKey) {
  if (inst?.hedgeTaxTreatment !== 'INCOME') return null;
  const h = inst.hedgeRatio;
  if (!(h > 0)) return null;
  const exposure = rateKey != null ? FX_EXPOSURE_BY_MARKET[rateKey] : null;
  if (!exposure) return null;
  const yld   = inst.dividendYield ?? state?.marketDividendYields?.[rateKey] ?? 0;
  const adj   = state?.effectiveDividendAdjustments?.[rateKey] ?? 0;
  const d     = Math.max(0, yld * (1 + adj));
  const total = state?.effectiveGrowthRates?.[rateKey] ?? 0;
  const price = priceOf(total, yld) + (state?.securityReturnOverlay?.[inst.id] ?? 0);
  const f     = fxMoveFor(state, exposure);
  const cost  = state?.hedgeOverlay?.cost ?? DEFAULT_HEDGE_COST;
  const hedge = h * (hedgeCarryFor(state, exposure) - cost - f * (1 + price));
  const carriedIn = state?.hedgeOverlay?.carriedLoss?.[inst.id] ?? 0;
  return {
    d, hedge, carriedIn, price,
    distributed: Math.max(0, d + hedge - carriedIn),
    carriedOut:  Math.max(0, carriedIn - d - hedge),
  };
}

/**
 * Next year's carried loss for an `INCOME` security, per dollar of its value: this year's
 * carried amount over the unit price after the distribution. The price after the year is
 * (1 + price + Δ + d − D′) per dollar at its start, with Δ the overlay's delta.
 *
 * @returns {number|null} null when the security is not `INCOME`
 */
export function nextCarriedLoss(state, inst, rateKey) {
  const split = incomeHedgeSplit(state, inst, rateKey);
  if (!split) return null;
  if (split.carriedOut === 0) return 0;
  // The overlay's Δ = (1 − h)·f·(1 + p) + h·(carry − cost) = f·(1 + p) + H.
  const f = fxMoveFor(state, FX_EXPOSURE_BY_MARKET[rateKey]);
  const delta = f * (1 + split.price) + split.hedge;
  const unitGrowth = 1 + split.price + delta + split.d - split.distributed;
  return unitGrowth > 0 ? split.carriedOut / unitGrowth : split.carriedOut;
}
