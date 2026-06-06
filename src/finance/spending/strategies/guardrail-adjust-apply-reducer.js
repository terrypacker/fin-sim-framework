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
 * GuardrailAdjustApplyReducer — applies a Guardrail multiplier to the
 * discretionary expense slice.
 *
 * Handles GUARDRAIL_ADJUST_APPLY emitted by GuardrailAnnualCheckReducer via
 * state.next.  Runs at PRE_PROCESS (10) so the adjustment is visible to all
 * subsequent reducers within the same simulation tick.
 *
 * Action payload: { multiplier: number, cause: 'cut' | 'raise', date }
 */
export class GuardrailAdjustApplyReducer extends Reducer {
  static description = 'Applies a Guardrail multiplier to state.expenses.discretionary and syncs state.monthlyExpenses.';
  static type        = 'GuardrailAdjustApplyReducer';
  static actionType  = 'GUARDRAIL_ADJUST_APPLY';

  constructor() {
    super('Guardrail Adjust Apply', PRIORITY.PRE_PROCESS);
    this.reducedActionTypes = ['GUARDRAIL_ADJUST_APPLY'];
  }

  reduce(state, action) {
    const { multiplier, cause, date } = action;
    if (!state.expenses || multiplier == null) return this.newState(state);

    const discretionary = (state.expenses.discretionary ?? 0) * multiplier;
    const essential     = state.expenses.essential ?? 0;

    const prevMultiplier = state.guardrail?.currentAdjustmentMultiplier ?? 1.0;

    const guardrail = {
      ...(state.guardrail ?? {}),
      currentAdjustmentMultiplier: prevMultiplier * multiplier,
      lastAdjustmentDate: date ?? null,
      lastAdjustmentCause: cause ?? null,
    };

    return this.newState(state, {
      expenses:        { essential, discretionary },
      monthlyExpenses: essential + discretionary,
      guardrail,
    });
  }
}
