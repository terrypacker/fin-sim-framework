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
 * Handles the EXPENSE_DEBIT action.
 *
 * Debits the residence-appropriate savings account:
 *   - Pre-move: state[usAccountKey] (USD)
 *   - Post-move: state[auAccountKey] (AUD)
 *
 * The debit is capped to the available balance so this reducer never goes
 * negative — ReplenishSavingsReducer runs first (lower priority = earlier)
 * and tops up the account before this fires.
 *
 * @param {object} opts
 * @param {import('../../finance/services/account-service.js').AccountService} opts.accountService
 * @param {string} [opts.usAccountKey='usSavingsAccount']
 * @param {string} [opts.auAccountKey='auSavingsAccount']
 */
export class ExpenseDebitReducer extends Reducer {
  static description = 'Debits the residence-appropriate savings account (US pre-move, AU post-move); capped to available balance.';

  static actionType = 'EXPENSE_DEBIT';

  constructor({ accountService, usAccountKey = 'usSavingsAccount', auAccountKey = 'auSavingsAccount' } = {}) {
    super('Expense Debit', PRIORITY.CASH_FLOW);
    this.accountService = accountService;
    this.usAccountKey   = usAccountKey;
    this.auAccountKey   = auAccountKey;
  }

  reduce(state, action, date) {
    const accountKey = state.isAuResident ? this.auAccountKey : this.usAccountKey;
    const account    = state[accountKey];
    const debit      = Math.min(action.amount, Math.max(0, account.balance));
    if (debit > 0) {
      this.accountService.transaction(account, -debit, date);
    }
    return this.newState(state);
  }
}
