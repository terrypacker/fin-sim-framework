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
 * Applies or reverts the late-life care expense multiplier (design/27 §4).
 *
 * On active=true: multiplies BOTH expense slices by factor and stores
 * the applied factor in state.lateLifeCare so the END event can divide cleanly.
 *
 * On active=false: divides both slices by the stored appliedFactor and clears
 * the entry (mirrors RegimeAwareSpendingReducer apply/revert pattern, design/26 §6).
 *
 * Late-life medical hits both essential and discretionary uniformly (§11 follow-up).
 */
export class LateLifeCareApplyReducer extends Reducer {
  static description = 'Multiplies/reverts both expense slices by the late-life care factor.';
  static type        = 'LateLifeCareApplyReducer';
  static actionType  = 'LATE_LIFE_CARE_APPLY';

  constructor() {
    super('Late-Life Care Apply', PRIORITY.CASH_FLOW);
    this.reducedActionTypes = ['LATE_LIFE_CARE_APPLY'];
  }

  reduce(state, action) {
    const { active, factor, personId } = action;
    if (!state.expenses) return this.newState(state);

    let essential     = state.expenses.essential     ?? 0;
    let discretionary = state.expenses.discretionary ?? 0;
    let lateLifeCare  = { ...(state.lateLifeCare ?? {}) };

    if (active) {
      const appliedFactor = factor ?? 2.0;
      essential           *= appliedFactor;
      discretionary       *= appliedFactor;
      lateLifeCare[personId ?? '__global'] = { active: true, appliedFactor };
    } else {
      const entry       = lateLifeCare[personId ?? '__global'] ?? {};
      const divBy       = entry.appliedFactor ?? 1;
      essential        /= divBy;
      discretionary    /= divBy;
      delete lateLifeCare[personId ?? '__global'];
    }

    return this.newState(state, {
      expenses:        { essential, discretionary },
      monthlyExpenses: essential + discretionary,
      lateLifeCare,
    });
  }
}
