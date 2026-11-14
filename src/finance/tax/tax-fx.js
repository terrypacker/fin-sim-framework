/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { CurrencyConverter } from '../fx/currency-converter.js';

// Module-singleton converter (stateless; reads the rate from the passed state
// snapshot's effectiveExchangeRates each call).
const _converter = new CurrencyConverter();

/**
 * Design 51: tax-bucket FX normalization.
 *
 * Convert an income `amount` from its native `fromCcy` into a tax accumulator's
 * canonical `toCcy` using the run's recorded `state.effectiveExchangeRates`, so
 * that a bucket only ever holds a single currency. Every YTD tax accumulator has
 * one canonical currency (US/state buckets USD, AU buckets AUD); a `*_TAX`
 * reducer whose source income is in a different currency routes each write
 * through here before accumulating.
 *
 * Falls back to the native amount when the source and target currencies match,
 * or when no pair/rate is available — mirroring `convertExpenseToAccount` and the
 * `CurrencyConverter` `null` contract, so single-country (or rate-less) scenarios
 * stay byte-identical. In practice `effectiveExchangeRates` is seeded at scenario
 * start (FxService) and refreshed each period, so a rate is present at runtime.
 *
 * @param {number} amount   income amount in `fromCcy`
 * @param {string} fromCcy  native currency of the amount, e.g. 'AUD'
 * @param {string} toCcy    the target bucket's canonical currency, e.g. 'USD'
 * @param {object} state    state snapshot carrying `effectiveExchangeRates`
 * @returns {number}        `amount` expressed in `toCcy`
 */
export function toCcy(amount, fromCcy, toCcy, state) {
  if (amount == null || fromCcy === toCcy) return amount;
  const converted = _converter.convert(amount, fromCcy, toCcy, state);
  return converted == null ? amount : converted;
}

/** Convert a native `fromCcy` amount into USD (US/state buckets' canonical currency). */
export const toUSD = (amount, fromCcy, state) => toCcy(amount, fromCcy, 'USD', state);

/** Convert a native `fromCcy` amount into AUD (AU buckets' canonical currency). */
export const toAUD = (amount, fromCcy, state) => toCcy(amount, fromCcy, 'AUD', state);

/**
 * The currency pair every cross-border tax conversion goes through, quoted as
 * `1 USD = <rate> AUD` (the `UsdAudPair` id in `state.effectiveExchangeRates`).
 */
export const TAX_FX_PAIR = 'USD_AUD';

/**
 * The USD/AUD rate in force at a settlement, for REPORTING on the return.
 *
 * A cross-border return is the one artifact whose numbers cannot be checked
 * without knowing the rate behind them: every AUD figure on a Form 1040 and
 * every USD figure on an ITR was normalized by `toCcy` above, and a reader with
 * only the converted totals has no way to reproduce them. Stamping the rate on
 * the settlement puts it on the return itself.
 *
 * **What this rate is, precisely.** It is the rate recorded in state at the
 * moment of the settle — the one used for the settle-time conversions (the FITO
 * handoff in `UsTaxSettleHandler`, the §904 basket funding in
 * `AuTaxSettleApplyReducer`). It is NOT a weighted average of the rates applied
 * to individual income items as they accrued: those were converted at each
 * period's own rate as the year ran. With a static FX rate — the default — the
 * two are identical. Once rates move within a year (FX vol / regime shocks, or
 * design 47 time-varying rates) the settle-date rate is the year-end
 * benchmark, not the effective rate of every line above it.
 *
 * @param {object} state  state snapshot carrying `effectiveExchangeRates`
 * @returns {number|null} AUD per USD, or null when the run records no rate
 *                        (single-country scenarios) — never a silent 1.0
 */
export function taxFxRate(state) {
  return state?.effectiveExchangeRates?.[TAX_FX_PAIR] ?? null;
}

/**
 * The currency a disposal tax action's money fields are stated in.
 *
 * Every emitter that can draw an AU-domiciled account states `currency`; an action with
 * none predates that and was always a US-domiciled (USD) disposal.
 *
 * @param {object} action  a *_SALE_TAX / *_WITHDRAWAL_TAX action
 * @returns {string}       ISO currency code
 */
export const disposalCurrency = (action) => action?.currency ?? 'USD';

/**
 * Whether a disposal is of an AU-DOMICILED asset (an AU brokerage lot, an AU-held
 * collectible), read from the drawn account's `country` when the action names one and
 * from the stated currency otherwise.
 *
 * It decides the FITO removal sets. Art. 22(2) of the US–Australia convention
 * (`docs/us-tax/Treaty-Australia-Convention-1982-08-06.txt`) has Australia credit US
 * tax on "income derived from sources in the United States", and excludes US tax
 * "imposed … solely by reason of citizenship". An AU resident's gain on an AU-domiciled
 * asset is taxed by the US only because the seller is a citizen, so it is never in the
 * US-source slices, whatever §865(g)(2) says about its US-law source.
 *
 * @param {object} state
 * @param {object} action
 * @returns {boolean}
 */
export function isAuDomiciledDisposal(state, action) {
  const acct = action?.stateKey != null ? state?.[action.stateKey] : null;
  if (acct?.country === 'AU' || acct?.country === 'US') return acct.country === 'AU';
  return disposalCurrency(action) === 'AUD';
}
