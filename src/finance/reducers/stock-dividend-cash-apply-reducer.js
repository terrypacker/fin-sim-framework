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
 * Handles STOCK_DIVIDEND_CASH_APPLY actions (cash payout path).
 *
 * Credits the dividend amount to the named savings account via AccountService,
 * then chains STOCK_DIVIDEND_TAX { amount, isAuResident } so the tax module
 * can classify it as US ordinary income (and AU ordinary income when resident).
 *
 * The reinvest path (STOCK_DIVIDEND_APPLY) is handled by UsAccountModule and
 * does not pass through this reducer — it credits the stock account directly
 * and increases both bases.
 *
 * @param {object} opts
 * @param {import('../../finance/services/account-service.js').AccountService} opts.accountService
 * @param {string} [opts.accountKey='usSavingsAccount']
 *   State key for the savings account to credit with the cash dividend.
 */
export class StockDividendCashApplyReducer extends Reducer {
  static description = 'Credits stock dividend cash payout to the savings account and chains STOCK_DIVIDEND_TAX for tax classification.';

  static actionType = 'STOCK_DIVIDEND_CASH_APPLY';

  constructor({ accountService, accountKey = 'usSavingsAccount' } = {}) {
    super('Stock Dividend Cash Apply', PRIORITY.CASH_FLOW);
    this.accountService = accountService;
    this.accountKey     = accountKey;
  }

  reduce(state, action, date) {
    const { amount, isAuResident } = action;
    this.accountService.transaction(state[this.accountKey], amount, date);
    return this.newState(state, {}, [{ type: 'STOCK_DIVIDEND_TAX', amount, isAuResident }]);
  }
}
