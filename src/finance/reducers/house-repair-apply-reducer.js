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
 * HouseRepairApplyReducer — records a HOUSE_REPAIR_APPLY action (design 75 §5.2, Phase 3). The
 * cash debit itself is handled by the shared ExpenseDebitReducer (via the EXPENSE_DEBIT the
 * repair handler emits); this reducer does the two STATE effects:
 *
 *   1. Tracking — accumulates `houseRepairSpendingYTD` / `houseRepairSpendingTotal` (native
 *      property-currency amount) for journal/report visibility, mirroring
 *      HealthcareExpenseApplyReducer.
 *   2. Capitalization (design 75 §8 Q6 = yes) — when the property's `capitalizeRepairs` fraction
 *      is > 0, lifts `state[stateKey].capitalizedImprovements` by `capitalize · amount` (in the
 *      property's currency). The house-sale reducers add this accumulator to the sale cost basis,
 *      so a fraction of each large repair is treated as a capital improvement and reduces the
 *      eventual capital gain — WITHOUT disturbing the frozen sale-basis or design-62 residency-
 *      reset logic (the accumulator is 0 by default ⇒ inert). Repairs are otherwise maintenance,
 *      not capitalized.
 *
 * Action payload: { stateKey, amount, capitalize }. Priority CASH_FLOW.
 */
export class HouseRepairApplyReducer extends Reducer {
  static description = 'Records HOUSE_REPAIR_APPLY: accumulates house-repair spending and, when capitalizeRepairs > 0, lifts the property\'s capitalizedImprovements accumulator (added to sale basis) — design 75 §5.2/§8 Q6.';
  static type        = 'HouseRepairApplyReducer';
  static actionType  = 'HOUSE_REPAIR_APPLY';

  constructor() {
    super('House Repair Apply', PRIORITY.CASH_FLOW);
    this.reducedActionTypes = ['HOUSE_REPAIR_APPLY'];
  }

  reduce(state, action) {
    const amount     = action?.amount ?? 0;
    const stateKey   = action?.stateKey ?? null;
    const capitalize = action?.capitalize ?? 0;
    if (amount <= 0) return this.newState(state);

    const updates = {
      houseRepairSpendingYTD:   (state.houseRepairSpendingYTD   ?? 0) + amount,
      houseRepairSpendingTotal: (state.houseRepairSpendingTotal ?? 0) + amount,
    };

    // Capitalize a fraction of the repair into the property's improvement accumulator.
    if (capitalize > 0 && stateKey && state[stateKey]) {
      const prop = state[stateKey];
      updates[stateKey] = {
        ...prop,
        capitalizedImprovements: (prop.capitalizedImprovements ?? 0) + capitalize * amount,
      };
    }

    return this.newState(state, updates);
  }
}
