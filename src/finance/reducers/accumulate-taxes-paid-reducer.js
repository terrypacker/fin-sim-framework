/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { Reducer, PRIORITY } from '../../simulation-framework/reducers.js';

/**
 * Accumulates lifetime taxes paid into state.cumulativeTaxesPaid (design/38 §5.3).
 *
 * Mirrors AccumulateDeficitReducer: it sums the `tax` carried on each tax-settle
 * action into a single running state field, so objectives like MIN_LIFETIME_TAXES
 * can read it as a pure function of the final state (and, for windowed/MPC
 * horizons, subtract the snapshot's value). Also useful beyond optimization as a
 * chartable KPI.
 *
 * **Normalized to USD.** The settle family spans currencies — US and US-state
 * settlements are in USD, AU settlements in AUD — so AU tax is FX-converted to
 * USD (same convention as computeNetWorth: USD = audAmount / rate, rate =
 * effectiveExchangeRates['USD_AUD']) before accumulating. One coherent USD
 * lifetime-tax figure regardless of cross-border residency.
 */
export class AccumulateTaxesPaidReducer extends Reducer {
  static description = 'Accumulates cumulativeTaxesPaid (USD-normalized) from US/AU/state tax-settle actions.';
  static type        = 'AccumulateTaxesPaidReducer';
  static actionType  = null;

  constructor() {
    super('Accumulate Taxes Paid', PRIORITY.METRICS);
    this.reducedActionTypes = ['US_TAX_SETTLE_APPLY', 'AU_TAX_SETTLE_APPLY', 'STATE_TAX_SETTLE_APPLY'];
  }

  reduce(state, action) {
    const tax = action.tax ?? 0;
    if (!tax) return this.newState(state);

    // AU settlements are denominated in AUD; convert to USD. US + state are USD.
    let usd = tax;
    if (action.type === 'AU_TAX_SETTLE_APPLY') {
      const rate = state.effectiveExchangeRates?.['USD_AUD']
        ?? state.baseExchangeRates?.['USD_AUD'] ?? 1;
      usd = tax / rate;
    }

    return this.newState({
      ...state,
      cumulativeTaxesPaid: (state.cumulativeTaxesPaid ?? 0) + usd,
    });
  }
}
