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
 * Accumulates lifetime *real* consumption into state.cumulativeConsumption
 * (design/38 §5.2 — the running quantity DIE_WITH_TARGET maximizes).
 *
 * Each EXPENSE_DEBIT carries the real-terms cost of a month's spending in the
 * debited account's currency. To make "spend early ⇄ leave less" a meaningful
 * trade-off, consumption is accumulated in **base-year USD**:
 *   1. FX-convert AUD debits to USD (USD = audAmount / effectiveExchangeRates['USD_AUD']);
 *   2. deflate by the residence price level (state.inflationAccumulator[cc]) so a
 *      dollar consumed at 65 and at 90 count equally in real terms.
 *
 * A pure-of-final-state accumulator (like cumulativeTaxesPaid / cumulativeDeficit):
 * no per-step objective callback, readable at the end and windowable via a
 * snapshot delta.
 */
export class AccumulateConsumptionReducer extends Reducer {
  static description = 'Accumulates cumulativeConsumption as lifetime real (base-year USD) spending from EXPENSE_DEBIT actions.';
  static type        = 'AccumulateConsumptionReducer';
  static actionType  = 'EXPENSE_DEBIT';

  constructor() {
    super('Accumulate Consumption', PRIORITY.METRICS);
    this.reducedActionTypes = ['EXPENSE_DEBIT'];
  }

  reduce(state, action) {
    const amount = action.amount ?? 0;
    if (!amount) return this.newState(state);

    const account  = state[action.targetKey];
    const currency = account?.currency?.code ?? account?.currency ?? 'USD';
    const cc       = currency === 'AUD' ? 'AU' : 'US';

    let usd = amount;
    if (currency === 'AUD') {
      const rate = state.effectiveExchangeRates?.['USD_AUD']
        ?? state.baseExchangeRates?.['USD_AUD'] ?? 1;
      usd = amount / rate;
    }

    // Deflate to base-year dollars by the residence cumulative price level.
    const priceLevel = state.inflationAccumulator?.[cc] ?? 1;
    const real = usd / (priceLevel || 1);

    return this.newState({
      ...state,
      cumulativeConsumption: (state.cumulativeConsumption ?? 0) + real,
    });
  }
}
