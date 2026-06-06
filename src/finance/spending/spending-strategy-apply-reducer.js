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
 * Applies a spending strategy adjustment to a specific expense slice.
 *
 * Emitted by RegimeAwareSpendingReducer (and future Guardrail strategy) with:
 *   { type: 'SPENDING_STRATEGY_APPLY', delta, slice, reason }
 *
 * Writes state.expenses[slice] += delta and keeps state.monthlyExpenses in
 * sync as the sum of both slices.
 */
export class SpendingStrategyApplyReducer extends Reducer {
  static description = 'Applies a spending strategy delta to state.expenses[slice] and syncs state.monthlyExpenses.';
  static type        = 'SpendingStrategyApplyReducer';
  static actionType  = 'SPENDING_STRATEGY_APPLY';

  constructor() {
    super('Spending Strategy Apply', PRIORITY.CASH_FLOW);
    this.reducedActionTypes = ['SPENDING_STRATEGY_APPLY'];
  }

  reduce(state, action) {
    const { delta, slice } = action;
    if (!state.expenses || delta == null || !slice) return this.newState(state);

    const essential     = slice === 'essential'
      ? (state.expenses.essential ?? 0) + delta
      : (state.expenses.essential ?? 0);
    const discretionary = slice === 'discretionary'
      ? (state.expenses.discretionary ?? 0) + delta
      : (state.expenses.discretionary ?? 0);

    return this.newState(state, {
      expenses:        { essential, discretionary },
      monthlyExpenses: essential + discretionary,
    });
  }
}
