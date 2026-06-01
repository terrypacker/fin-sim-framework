/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { Reducer, PRIORITY, AccountServiceReducer } from '../../../simulation-framework/reducers.js';

// ─── Reducers ─────────────────────────────────────────────────────────────────

/**
 * AU fixed income earnings — stay in account.
 * Chains AU_FIXED_INCOME_EARNINGS_TAX (AU ordinary income for residents,
 * AU NR withholding for non-residents; always US ordinary income).
 */
export class AuFixedIncomeEarningsApplyReducer extends AccountServiceReducer {
  static type        = 'AuFixedIncomeEarningsApplyReducer';
  static description = 'Adds earnings to auFixedIncomeAccount balance; chains AU_FIXED_INCOME_EARNINGS_TAX.';
  static actionType  = 'AU_FIXED_INCOME_EARNINGS_APPLY';

  constructor({ accountService } = {}) {  // accountService unused but accepted for API symmetry
    super('AU Fixed Income Earnings Apply', PRIORITY.CASH_FLOW);
    this.reducedActionTypes   = ['AU_FIXED_INCOME_EARNINGS_APPLY'];
    this.generatedActionTypes = ['AU_FIXED_INCOME_EARNINGS_TAX'];
  }

  reduce(state, action) {
    const { amount, isAuResident } = action;
    const prev = state.auFixedIncomeAccount ?? {};
    return this.newState(
      state,
      {
        auFixedIncomeAccount: { ...prev, balance: (prev.balance ?? 0) + amount },
      },
      [{ type: 'AU_FIXED_INCOME_EARNINGS_TAX', amount, isAuResident }]
    );
  }
}
