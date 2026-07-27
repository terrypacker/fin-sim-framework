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
