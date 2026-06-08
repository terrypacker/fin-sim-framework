/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { HandlerEntry }                   from '../../../simulation-framework/handlers.js';
import { computeGuardrailPortfolioValue } from '../guardrail-portfolio-value.js';

/**
 * RetirementDateHandler — handles RETIREMENT_DATE_REACHED one-off events.
 *
 * On each retirement date event it:
 *  1. Computes the current portfolio value (drawdown accounts, FX-converted).
 *  2. Computes the initial withdrawal rate: annualSpending / portfolioValue.
 *  3. Emits GUARDRAIL_BASELINE_APPLY so GuardrailBaselineApplyReducer can store
 *     the rate in state.guardrail.
 *
 * If the simulation opens already post-retirement for a person, the toolset
 * should pre-populate state.guardrail.initialWithdrawalRate in the state()
 * patches instead of scheduling this event — so this handler only fires in the
 * future-retirement case.
 *
 * @param {object} [opts]
 * @param {string} [opts.baseCurrency='USD']  Currency to sum portfolio values into
 */
export class RetirementDateHandler extends HandlerEntry {
  static description = 'On RETIREMENT_DATE_REACHED, captures the initial withdrawal rate baseline for the Guardrail strategy.';
  static type        = 'RetirementDateHandler';
  static eventType   = 'RETIREMENT_DATE_REACHED';

  constructor({ baseCurrency = 'USD' } = {}) {
    super(null, 'Retirement Date (Guardrail Baseline)');
    this.baseCurrency          = baseCurrency;
    this.generatedActionTypes  = ['GUARDRAIL_BASELINE_APPLY'];
  }

  call({ state, date }) {
    const portfolioValue = computeGuardrailPortfolioValue(state, this.baseCurrency);
    if (!portfolioValue) return [];

    const annualSpending        = (state.monthlyExpenses ?? 0) * 12;
    const initialWithdrawalRate = portfolioValue > 0 ? annualSpending / portfolioValue : 0;

    return [{
      type: 'GUARDRAIL_BASELINE_APPLY',
      initialWithdrawalRate,
      portfolioValue,
      annualSpending,
      date: date ?? new Date(),
    }];
  }
}
