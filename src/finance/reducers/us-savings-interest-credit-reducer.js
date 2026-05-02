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
 * Handles the US_SAVINGS_INTEREST_CREDIT action.
 *
 * Credits action.amount to the named US savings account via AccountService,
 * then increments usOrdinaryIncomeYTD. When the person is already an AU
 * resident, the same amount is also added to auOrdinaryIncomeYTD and ftcYTD
 * (foreign-tax-credit tracking for cross-country tax reconciliation).
 *
 * AccountService is injected at construction time so this class holds no
 * non-serializable state of its own; only accountKey is persisted.
 *
 * @param {object} opts
 * @param {import('../../finance/services/account-service.js').AccountService} opts.accountService
 * @param {string} [opts.accountKey='usSavingsAccount']
 *   State key for the savings account to credit.
 */
export class UsSavingsInterestCreditReducer extends Reducer {
  static description = 'Credits interest to a US savings account and increments usOrdinaryIncomeYTD (plus auOrdinaryIncomeYTD/ftcYTD when AU-resident).';

  /** Action type this reducer handles. Used by SimulationSync for auto-wiring. */
  static actionType = 'US_SAVINGS_INTEREST_CREDIT';

  constructor({ accountService, accountKey = 'usSavingsAccount' } = {}) {
    super('US Savings Interest Credit', PRIORITY.CASH_FLOW);
    this.accountService = accountService;
    this.accountKey     = accountKey;
  }

  reduce(state, action, date) {
    this.accountService.transaction(state[this.accountKey], action.amount, date);

    const usNext = (state.usOrdinaryIncomeYTD ?? 0) + action.amount;
    const base   = { ...state, usOrdinaryIncomeYTD: usNext };

    if (state.isAuResident) {
      return this.newState({
        ...base,
        auOrdinaryIncomeYTD: (state.auOrdinaryIncomeYTD ?? 0) + action.amount,
        ftcYTD:              (state.ftcYTD ?? 0) + action.amount,
      });
    }
    return this.newState(base);
  }
}
