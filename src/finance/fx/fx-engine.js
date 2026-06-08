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
 * Base class for a bidirectional currency pair.
 *
 * Subclasses declare static `id`, `fromCurrency`, `toCurrency` for the
 * canonical direction.  Both directions are supported; the reverse direction
 * inverts the rate and converts the fee into the from-currency.
 *
 * All rate/fee reads target `state.effectiveExchangeRates[id]` and
 * `state.effectiveFxFees[id]` so that regime-adjusted values flow through
 * automatically.
 */
export class CurrencyPair {
  /** @type {string} — e.g. 'USD_AUD' */
  static id;
  /** @type {string} — canonical from-currency, e.g. 'USD' */
  static fromCurrency;
  /** @type {string} — canonical to-currency, e.g. 'AUD' */
  static toCurrency;

  /**
   * Effective rate for the given direction.
   *
   * @param {object} state
   * @param {{ from: string, to: string }} direction
   * @returns {number}
   */
  rate(state, direction) {
    const base = state.effectiveExchangeRates?.[this.constructor.id] ?? 1;
    return direction.from === this.constructor.fromCurrency ? base : 1 / base;
  }

  /**
   * Fee expressed in `direction.from` currency.
   *
   * The stored fee is always denominated in the canonical `fromCurrency`.
   * For a reverse-direction transfer, the fee is converted to the actual
   * from-currency by multiplying by the canonical rate.
   *
   * @param {object} state
   * @param {number} _notional
   * @param {{ from: string, to: string }} direction
   * @returns {number}
   */
  fee(state, _notional, direction) {
    const feeBase = state.effectiveFxFees?.[this.constructor.id] ?? 0;
    if (direction.from === this.constructor.fromCurrency) {
      return feeBase;
    }
    // Reverse direction: fee is stored in canonical fromCurrency; convert to actual from-currency.
    const rate = state.effectiveExchangeRates?.[this.constructor.id] ?? 1;
    return feeBase * rate;
  }
}

/**
 * Registry of registered CurrencyPair instances.  Pure data; no side effects.
 */
export class FxEngine {
  constructor() {
    this._pairs = {};
  }

  /** @param {CurrencyPair} pair */
  registerPair(pair) {
    this._pairs[pair.constructor.id] = pair;
  }

  /**
   * Resolve a pair that covers `from`/`to` (either direction).
   * @param {string} from
   * @param {string} to
   * @returns {CurrencyPair}
   */
  getPair(from, to) {
    for (const pair of Object.values(this._pairs)) {
      const { fromCurrency, toCurrency } = pair.constructor;
      if (
        (fromCurrency === from && toCurrency === to) ||
        (fromCurrency === to   && toCurrency === from)
      ) {
        return pair;
      }
    }
    throw new Error(`FxEngine: no pair registered for ${from}/${to}`);
  }

  /** @returns {CurrencyPair[]} */
  pairs() {
    return Object.values(this._pairs);
  }
}
