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
 *
 * **Net of refunds, so it can fall (#774).** AU franking credits are refundable
 * (s67-25), both to a member (design 90 §8) and to the super fund (s207-20, design 90
 * §8.4). A settle whose `tax` or `fundTax` is negative is a refund the household really
 * receives as cash, and it is subtracted here at that settle's rate, exactly as a
 * payment is added. It is not floored. Flooring would let MIN_LIFETIME_TAXES ignore the
 * cash a franked-dividend portfolio gets back. The usual case is a fund in pension phase
 * (0% earnings tax), which turns every franking credit into a refund. Each settle is
 * converted once, at its own rate, and never restated later, so FX never lowers the
 * figure.
 */
export class AccumulateTaxesPaidReducer extends Reducer {
  static description = 'Accumulates cumulativeTaxesPaid (USD-normalized) from US/AU/state tax-settle actions, net of refunds: a negative settle (refundable franking credits, incl. a pension-phase super fund) lowers it.';
  static type        = 'AccumulateTaxesPaidReducer';
  static actionType  = null;

  constructor() {
    super('Accumulate Taxes Paid', PRIORITY.METRICS);
    this.reducedActionTypes = ['US_TAX_SETTLE_APPLY', 'AU_TAX_SETTLE_APPLY', 'STATE_TAX_SETTLE_APPLY'];
  }

  reduce(state, action) {
    // `fundTax` (design 77 §5.4) is the AU Div 295 superannuation FUND tax for the
    // year. It is not the member's liability and is never debited from their cash —
    // the fund withholds it at accrual — but it is tax the household genuinely bore,
    // out of the super balance. Counting it keeps "lifetime taxes" a measure of tax
    // paid rather than of tax *invoiced to the member*, which is what an optimizer
    // minimizing this metric would otherwise learn to game.
    const tax = (action.tax ?? 0) + (action.fundTax ?? 0);
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
