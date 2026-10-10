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
import { InsufficientFundsError } from '../assets/account.js';
import { RecordBalanceAction } from '../../simulation-framework/actions.js';
import { getUsEarlyWithdrawalRules } from '../account-rules/us/us-early-withdrawal-rules.js';
import { escalateShortfall } from '../account-rules/shortfall-escalation.js';

/**
 * Handles the REPLENISH_SAVINGS action.
 *
 * Delegates to AccountService.replenishSavings, which walks accounts in the
 * same country as the target savings account (sorted by drawdownPriority) and
 * draws from each until the deficit is covered or all eligible accounts are
 * exhausted.  Early-withdrawal-eligible accounts (Roth, IRA, 401k) are drawn
 * in a second phase when normal sources are insufficient.
 *
 * On InsufficientFundsError (domestic accounts exhausted), chains an
 * INTL_TRANSFER_APPLY action for the remaining amount so the international
 * transfer path can attempt to cover the shortfall from the other country —
 * or, when there is no other country to draw from (a single-country plan),
 * OUT_OF_FUNDS directly (see escalateShortfall).
 *
 * Runs at PRIORITY.PRE_PROCESS so it always fires before EXPENSE_DEBIT
 * (PRIORITY.CASH_FLOW).
 *
 * @param {object}   opts
 * @param {import('../../finance/services/account-service.js').AccountService} opts.accountService
 * @param {import('../../finance/services/state-registry.js').StateRegistry} [opts.stateRegistry]
 * @param {Function} [opts.earlyWithdrawalRulesFn] - (accountType) → rules | null
 */
export class ReplenishSavingsReducer extends Reducer {
  static description = 'Draws from domestic investment accounts (by drawdownPriority) to cover a savings deficit; includes early-withdrawal-eligible accounts (with penalty) before escalating to INTL_TRANSFER_APPLY, or to OUT_OF_FUNDS when there is no other country to draw from.';
  static type        = 'ReplenishSavingsReducer';
  static actionType  = 'REPLENISH_SAVINGS';

  constructor({ accountService, stateRegistry = null, earlyWithdrawalRulesFn = getUsEarlyWithdrawalRules } = {}) {
    super('Replenish Savings', PRIORITY.PRE_PROCESS);
    this.accountService          = accountService;
    this.stateRegistry           = stateRegistry;
    this.earlyWithdrawalRulesFn  = earlyWithdrawalRulesFn;
    this.reducedActionTypes      = ['REPLENISH_SAVINGS'];
    this.generatedActionTypes    = ['INTL_TRANSFER_APPLY', 'OUT_OF_FUNDS', 'INTL_TRANSFER_RECORD', 'RECORD_BALANCE'];
  }

  static fromJSON(d, { accountService, stateRegistry } = {}) {
    const r = new this({ accountService, stateRegistry });
    r.id = d.id;
    return r;
  }

  reduce(state, action, date) {
    const { deficit, targetKey } = action;
    const isAu = state[targetKey]?.country === 'AU';

    try {
      const { drawnKeys, pendingTaxActions, crossBorderTransfers = [] } = this.accountService.replenishSavings(
        state, targetKey, deficit, date, this.earlyWithdrawalRulesFn
      );
      const balanceActions = drawnKeys.map(k => new RecordBalanceAction(`${k}.balance`, k));
      // crossBorderTransfers are INTL_TRANSFER_RECORD markers for cash legs the
      // drawdown already converted inline — journaled for visibility (design 44).
      return this.newState(state, {}, [...balanceActions, ...crossBorderTransfers, ...pendingTaxActions]);
    } catch (e) {
      if (!(e instanceof InsufficientFundsError)) throw e;
      // Exhausting the domestic accounts is not a no-op: the draw emptied each one
      // on the way down, realizing gains and taxable distributions. Carry those
      // accruals (and their balance/journal records) forward alongside the
      // escalation, or the household escapes tax on everything it just sold.
      const { drawnKeys = [], pendingTaxActions = [], crossBorderTransfers = [] } = e.partial;
      const balanceActions = drawnKeys.map(k => new RecordBalanceAction(`${k}.balance`, k));
      const { actions: escalation } = escalateShortfall({
        state, stateRegistry: this.stateRegistry,
        toCountry: isAu ? 'AU' : 'US', deficit: e.remaining,
      });
      return this.newState(state, {}, [
        ...balanceActions, ...crossBorderTransfers, ...pendingTaxActions, ...escalation,
      ]);
    }
  }
}
