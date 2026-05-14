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
import { ACCOUNT_ROLES } from '../state/account-roles.js';

/**
 * Handles the US_SAVINGS_INTEREST_CREDIT action.
 *
 * Credits action.amount to the US savings account (resolved via StateRegistry)
 * then increments usOrdinaryIncomeYTD. When the person is already an AU
 * resident, the same amount is also added to auOrdinaryIncomeYTD and ftcYTD
 * (foreign-tax-credit tracking for cross-country tax reconciliation).
 *
 * @param {object} opts
 * @param {import('../../finance/services/account-service.js').AccountService} opts.accountService
 * @param {import('../services/state-registry.js').StateRegistry} opts.stateRegistry
 * @param {string} [opts.role=ACCOUNT_ROLES.US_SAVINGS]
 * @param {string|null} [opts.ownerId=null]
 */
export class UsSavingsInterestCreditReducer extends Reducer {
  static description = 'Credits interest to a US savings account and increments usOrdinaryIncomeYTD (plus auOrdinaryIncomeYTD/ftcYTD when AU-resident).';

  static actionType = 'US_SAVINGS_INTEREST_CREDIT';

  constructor({ accountService, stateRegistry, role = ACCOUNT_ROLES.US_SAVINGS, ownerId = null } = {}) {
    super('US Savings Interest Credit', PRIORITY.CASH_FLOW);
    this.accountService = accountService;
    this.stateRegistry  = stateRegistry;
    this.role           = role;
    this.ownerId        = ownerId;
    this.reducedActionTypes = ['US_SAVINGS_INTEREST_CREDIT'];
  }

  reduce(state, action, date) {
    const key = this.stateRegistry.getStateKey(this.role, this.ownerId);
    this.accountService.transaction(state[key], action.amount, date);

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
