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
 * GuardrailBaselineApplyReducer — stores the initial withdrawal rate baseline
 * for the Guyton-Klinger Guardrail strategy.
 *
 * Handles GUARDRAIL_BASELINE_APPLY emitted by RetirementDateHandler.
 * Runs at PRE_PROCESS (10) so the baseline is available to
 * GuardrailAnnualCheckReducer at PRE_PROCESS + 3 on the same period advance.
 *
 * Also initializes the full state.guardrail shape so the check reducer
 * never has to handle absent fields.
 */
export class GuardrailBaselineApplyReducer extends Reducer {
  static description = 'Stores the initial withdrawal rate in state.guardrail when GUARDRAIL_BASELINE_APPLY fires.';
  static type        = 'GuardrailBaselineApplyReducer';
  static actionType  = 'GUARDRAIL_BASELINE_APPLY';

  constructor() {
    super('Guardrail Baseline Apply', PRIORITY.PRE_PROCESS);
    this.reducedActionTypes = ['GUARDRAIL_BASELINE_APPLY'];
  }

  reduce(state, action) {
    const { initialWithdrawalRate, portfolioValue, annualSpending, date } = action;

    const guardrail = {
      ...(state.guardrail ?? {}),
      initialWithdrawalRate,
      portfolioValue,
      annualSpending,
      baselineDate:               date ?? null,
      lastAdjustmentDate:         null,
      currentAdjustmentMultiplier: 1.0,
    };

    return this.newState(state, { guardrail });
  }
}
