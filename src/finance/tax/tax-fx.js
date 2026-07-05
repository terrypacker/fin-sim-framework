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
