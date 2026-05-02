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
import { InsufficientFundsError } from '../account.js';

/**
 * Handles the REPLENISH_SAVINGS action.
 *
 * Delegates to AccountService.replenishSavings, which walks accounts in the
 * same country as the target savings account (sorted by drawdownPriority) and
 * draws from each until the deficit is covered or all eligible accounts are
 * exhausted.
 *
 * On InsufficientFundsError (domestic accounts exhausted), chains an
 * INTL_TRANSFER_APPLY action for the remaining amount so the international
 * transfer path can attempt to cover the shortfall from the other country.
 *
 * Runs at PRIORITY.PRE_PROCESS so it always fires before EXPENSE_DEBIT
 * (PRIORITY.CASH_FLOW).
 *
 * @param {object} opts
 * @param {import('../../finance/services/account-service.js').AccountService} opts.accountService
 */
export class ReplenishSavingsReducer extends Reducer {
  static description = 'Draws from domestic investment accounts (by drawdownPriority) to cover a savings deficit; on exhaustion chains INTL_TRANSFER_APPLY for the remaining shortfall.';

  static actionType = 'REPLENISH_SAVINGS';

  constructor({ accountService } = {}) {
    super('Replenish Savings', PRIORITY.PRE_PROCESS);
    this.accountService = accountService;
  }

  reduce(state, action, date) {
    const { deficit, targetKey } = action;
    const isAu = targetKey === 'auSavingsAccount';

    try {
      this.accountService.replenishSavings(state, targetKey, deficit, date);
      return this.newState(state);
    } catch (e) {
      if (!(e instanceof InsufficientFundsError)) throw e;
      // Domestic accounts exhausted — request an international transfer for
      // whatever could not be covered (e.remaining).
      return this.newState(state, {}, [{
        type:          'INTL_TRANSFER_APPLY',
        direction:     isAu ? 'US_TO_AU' : 'AU_TO_US',
        targetDeficit: e.remaining,
      }]);
    }
  }
}
