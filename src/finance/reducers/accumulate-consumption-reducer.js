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
 * **REALIZED, not intent** (design 89 §5.4). `ExpenseDebitReducer` caps the debit at
 * the available balance and publishes what moved as `action.realizedAmount`; this
 * reads that. Reading `action.amount` — what the strategy asked for — meant a plan
 * that ran short booked consumption the household never received, into the very
 * quantity the `consumption`, `crra` and DIE_WITH_TARGET objectives maximize.
 * Measured at 53% / 276% / 660% overstatement under 2x / 4x / 8x expense stress,
 * and EXACTLY ZERO on any solvent plan, because the cap only binds when short.
 *
 * The `?? action.amount` fallback covers an EXPENSE_DEBIT dispatched without the
 * debit reducer (unit tests do this). It is only ever correct because
 * PRIORITY.CASH_FLOW runs strictly before PRIORITY.METRICS — pinned by
 * `tests/unit/consumption-intent-gap.test.mjs`, which exists so that a future
 * re-ordering fails loudly instead of silently restoring the old behaviour.
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
    // Design 89 §5.4 — the money that MOVED, not the money that was asked for.
    const amount = action.realizedAmount ?? action.amount ?? 0;
    if (!amount) return this.newState(state);

    const account  = state[action.targetKey];
    const currency = account?.currency?.code ?? account?.currency ?? 'USD';

    let usd = amount;
    if (currency === 'AUD') {
      const rate = state.effectiveExchangeRates?.['USD_AUD']
        ?? state.baseExchangeRates?.['USD_AUD'] ?? 1;
      usd = amount / rate;
    }

    // Design 89 §5.6 — the price level is STAMPED by the emitter, never inferred here.
    // CURRENCY is still read off the account (that IS the account's axis: `amount` is
    // denominated in it), but the price INDEX is a different axis entirely, and one
    // action can even blend two of them when several properties pay from one account.
    // The `?? currency-derived` fallback keeps a hand-dispatched EXPENSE_DEBIT working.
    const cc         = currency === 'AUD' ? 'AU' : 'US';
    const priceLevel = action.priceLevel ?? state.inflationAccumulator?.[cc] ?? 1;
    const real       = usd / (priceLevel || 1);

    return this.newState({
      ...state,
      cumulativeConsumption: (state.cumulativeConsumption ?? 0) + real,
    });
  }
}
