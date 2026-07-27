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
 * ExpenseEventApplyReducer — the STATE half of a one-off expense event (design 86 G8,
 * generalized from HealthcareExpenseApplyReducer).
 *
 * It does NOT move cash and it does NOT touch `state.expenses.*`: a one-off event is a
 * debit from savings, not a change to the recurring monthly budget. The cash leg is
 * ExpenseDebitReducer's, via the EXPENSE_DEBIT actions ExpenseEventHandler emits.
 *
 * Two effects:
 *
 *   1. **Tracking**, per category — `expenseEventSpendingByCategory[category]` and
 *      `expenseEventSpendingTotal`. Per-category because `category` is now the
 *      discriminator between kinds of event ('healthcare' is a value here, not a
 *      strategy), so one accumulator per kind is the only way a report can tell a
 *      medical event from a capital one.
 *   2. **Capitalization** — lifts the linked property's `capitalizedImprovements`,
 *      which the house-sale reducers add to the sale cost basis. Identical mechanism
 *      to HouseRepairApplyReducer (design 75 §5.2), so a scheduled improvement and a
 *      stochastic repair reduce the eventual capital gain the same way. 0 by default
 *      ⇒ inert.
 *
 * `capitalizeAmount` arrives already denominated in the PROPERTY's currency — the
 * handler converts it, because this reducer has no business doing FX and the
 * accumulator it feeds is property-denominated.
 *
 * Replaces `healthcareSpendingYTD` / `healthcareSpendingTotal`. The former was never
 * reset by any settle path, so despite its name it was a second copy of the latter;
 * it is not carried forward. Nothing read either field.
 *
 * Action payload: { amount, category, personId, currency, propertyKey, capitalizeAmount }
 */
export class ExpenseEventApplyReducer extends Reducer {
  static description = 'Records EXPENSE_EVENT_APPLY: accumulates per-category one-off expense spending and, when capitalizeAmount > 0, lifts the linked property\'s capitalizedImprovements (added to sale basis) — design 86 G8.';
  static type        = 'ExpenseEventApplyReducer';
  static actionType  = 'EXPENSE_EVENT_APPLY';

  constructor() {
    super('Expense Event Apply', PRIORITY.CASH_FLOW);
    this.reducedActionTypes = ['EXPENSE_EVENT_APPLY'];
  }

  reduce(state, action) {
    const amount = action?.amount ?? 0;
    if (amount <= 0) return this.newState(state);

    const category = action?.category ?? 'other';
    const byCategory = { ...(state.expenseEventSpendingByCategory ?? {}) };
    byCategory[category] = (byCategory[category] ?? 0) + amount;

    const updates = {
      expenseEventSpendingByCategory: byCategory,
      expenseEventSpendingTotal:      (state.expenseEventSpendingTotal ?? 0) + amount,
    };

    const propertyKey      = action?.propertyKey      ?? null;
    const capitalizeAmount = action?.capitalizeAmount ?? 0;
    if (capitalizeAmount > 0 && propertyKey && state[propertyKey]) {
      const prop = state[propertyKey];
      updates[propertyKey] = {
        ...prop,
        capitalizedImprovements: (prop.capitalizedImprovements ?? 0) + capitalizeAmount,
      };
    }

    return this.newState(state, updates);
  }
}
