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
 * Debits the residence-appropriate savings account. The target account is
 * resolved in priority order:
 *   1. action.targetKey — set by MonthlyExpensesHandler via StateRegistry lookup
 *   2. usAccountKey / auAccountKey constructor params — fallback for manually
 *      dispatched EXPENSE_DEBIT actions that omit targetKey
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
  static description = 'Debits the residence-appropriate savings account (resolved from action.targetKey, then constructor fallback); capped to available balance.';
  static type        = 'ExpenseDebitReducer';
  static actionType  = 'EXPENSE_DEBIT';

  constructor({ accountService, usAccountKey = 'usSavingsAccount', auAccountKey = 'auSavingsAccount' } = {}) {
    super('Expense Debit', PRIORITY.CASH_FLOW);
    this.accountService = accountService;
    this.usAccountKey   = usAccountKey;
    this.auAccountKey   = auAccountKey;
    this.reducedActionTypes = ['EXPENSE_DEBIT'];
  }

  static fromJSON(d, { accountService }) {
    const r = new this({ accountService, usAccountKey: d.usAccountKey ?? 'usSavingsAccount', auAccountKey: d.auAccountKey ?? 'auSavingsAccount' });
    r.id = d.id;
    return r;
  }

  toJSON() {
    return { ...super.toJSON(), usAccountKey: this.usAccountKey, auAccountKey: this.auAccountKey };
  }

  reduce(state, action, date) {
    const primaryKey = Object.keys(state.people ?? {})[0];
    const residency  = state.people?.[primaryKey]?.residency ?? null;
    const fallback   = residency === 'AU' ? this.auAccountKey : this.usAccountKey;
    const accountKey = action.targetKey ?? fallback;
    const account    = state[accountKey];
    const debit      = Math.min(action.amount, Math.max(0, account.balance));
    if (debit > 0) {
      this.accountService.transaction(account, -debit, date);
    }
    // Design 87 §14.4 item 2 — name the pool that disposed. CHARACTER (whether this is a
    // disposition at all, and its §988(e)(3) share) is declared by whichever handler
    // emitted the action, because only it knows what the money bought; the pool is
    // resolved HERE, because `targetKey` may be absent and the residency fallback above
    // is the only thing that knows which account a bare EXPENSE_DEBIT lands on.
    if (debit > 0 && action.section988) action.section988.accountKey = accountKey;
    return this.newState(state);
  }
}
