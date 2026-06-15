/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { FxEngine }   from './fx-engine.js';
import { UsdAudPair } from './usd-aud-pair.js';

/** Build an FxEngine pre-registered with the known display pairs. */
function defaultFxEngine() {
  const engine = new FxEngine();
  engine.registerPair(new UsdAudPair());
  return engine;
}

/**
 * CurrencyConverter — stateless display-side currency conversion (design 10
 * §Phase 4).
 *
 * Wraps an FxEngine (the same CurrencyPair rate math the simulation uses) and
 * reads the rate from a state snapshot's `effectiveExchangeRates`, so display
 * conversion always reflects the rate the run recorded — no hardcoded rate, no
 * external feed. Because that field is refreshed each period advance, this also
 * works unchanged once exchange rates vary over time (Phase 6): callers simply
 * pass the snapshot from the relevant point.
 */
export class CurrencyConverter {
  /** @param {FxEngine} [fxEngine] */
  constructor(fxEngine = defaultFxEngine()) {
    this._fx = fxEngine;
  }

  /**
   * Convert `value` from `fromCode` → `toCode` using the rate recorded in
   * `state.effectiveExchangeRates`.
   *
   * @param {number}  value
   * @param {string}  fromCode  native currency code, e.g. 'USD'
   * @param {string}  toCode    display currency code, e.g. 'AUD'
   * @param {object}  [state]   state snapshot carrying effectiveExchangeRates
   * @returns {number|null}
   *   - `value` unchanged when `fromCode === toCode`
   *   - the converted amount when a rate is available
   *   - `null` when no pair or no recorded rate exists (caller renders native);
   *     never silently assumes 1:1.
   */
  convert(value, fromCode, toCode, state) {
    if (value == null || fromCode === toCode) return value;
    let pair;
    try {
      pair = this._fx.getPair(fromCode, toCode);
    } catch {
      return null; // no pair registered for this currency combination
    }
    // Require an actually-recorded rate; pair.rate() would otherwise fall back
    // to 1, which would mislabel the value (display symbol, native magnitude).
    const recorded = state?.effectiveExchangeRates?.[pair.constructor.id];
    if (recorded == null) return null;
    return value * pair.rate(state, { from: fromCode, to: toCode });
  }
}
