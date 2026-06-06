/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { Reducer, PRIORITY } from '../../../simulation-framework/reducers.js';

/**
 * HealthcareExpenseApplyReducer — records a HEALTHCARE_EXPENSE_APPLY action
 * in state for tracking and reporting purposes.
 *
 * This reducer does NOT modify state.expenses.essential permanently (the
 * healthcare event is a one-off debit from savings, not a change to the
 * recurring monthly budget).  The cash debit is handled by ExpenseDebitReducer
 * via the EXPENSE_DEBIT action emitted by HealthcareEventHandler.
 *
 * State additions:
 *   state.healthcareSpendingYTD  — running YTD total for the current sim year
 *   state.healthcareSpendingTotal — cumulative total over entire simulation
 *
 * Action payload: { amount, category, personId }
 */
export class HealthcareExpenseApplyReducer extends Reducer {
  static description = 'Records HEALTHCARE_EXPENSE_APPLY in state.healthcareSpendingYTD and state.healthcareSpendingTotal for tracking.';
  static type        = 'HealthcareExpenseApplyReducer';
  static actionType  = 'HEALTHCARE_EXPENSE_APPLY';

  constructor() {
    super('Healthcare Expense Apply', PRIORITY.CASH_FLOW);
    this.reducedActionTypes = ['HEALTHCARE_EXPENSE_APPLY'];
  }

  reduce(state, action) {
    const { amount = 0 } = action;

    return this.newState(state, {
      healthcareSpendingYTD:   (state.healthcareSpendingYTD   ?? 0) + amount,
      healthcareSpendingTotal: (state.healthcareSpendingTotal ?? 0) + amount,
    });
  }
}
