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
 * Handles STOCK_DIVIDEND_CASH_APPLY actions (cash payout path).
 *
 * Credits the dividend amount to the US savings account (resolved via StateRegistry),
 * then chains STOCK_DIVIDEND_TAX { amount, residency } so the tax module
 * can classify it as US ordinary income (and AU ordinary income when resident).
 *
 * The reinvest path (STOCK_DIVIDEND_APPLY) is handled by UsAccountModule and
 * does not pass through this reducer — it credits the stock account directly
 * and increases both bases.
 *
 * @param {object} opts
 * @param {import('../../finance/services/account-service.js').AccountService} opts.accountService
 * @param {import('../services/state-registry.js').StateRegistry} opts.stateRegistry
 * @param {string} [opts.role=ACCOUNT_ROLES.US_SAVINGS]
 * @param {string|null} [opts.ownerId=null]
 */
export class StockDividendCashApplyReducer extends Reducer {
  static description = 'Credits stock dividend cash payout to the savings account and chains STOCK_DIVIDEND_TAX for tax classification.';
  static type        = 'StockDividendCashApplyReducer';
  static actionType  = 'STOCK_DIVIDEND_CASH_APPLY';

  constructor({ accountService, stateRegistry, role = ACCOUNT_ROLES.US_SAVINGS, ownerId = null } = {}) {
    super('Stock Dividend Cash Apply', PRIORITY.CASH_FLOW);
    this.accountService  = accountService;
    this.stateRegistry   = stateRegistry;
    this.role            = role;
    this.ownerId         = ownerId;
    this.reducedActionTypes  = ['STOCK_DIVIDEND_CASH_APPLY'];
    this.generatedActionTypes = ['STOCK_DIVIDEND_TAX'];
  }

  static fromJSON(d, { accountService, stateRegistry }) {
    const r = new this({ accountService, stateRegistry, role: d.role ?? ACCOUNT_ROLES.US_SAVINGS, ownerId: d.ownerId ?? null });
    r.id = d.id;
    return r;
  }

  toJSON() {
    return { ...super.toJSON(), role: this.role, ownerId: this.ownerId };
  }

  reduce(state, action, date) {
    const { amount, residency } = action;
    const key = this.stateRegistry.getStateKey(this.role, this.ownerId);
    this.accountService.transaction(state[key], amount, date);
    return this.newState(state, {}, [{ type: 'STOCK_DIVIDEND_TAX', amount, residency, stateKey: key }]);
  }
}
