/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { Reducer, PRIORITY }  from '../../../simulation-framework/reducers.js';
import { HandlerEntry }        from '../../../simulation-framework/handlers.js';
import { InsufficientFundsError } from '../../assets/account.js';
import { ACCOUNT_ROLES }       from '../../state/account-roles.js';
import { StateTaxSettleService } from './state-tax-settle-service.js';
import { STATE_YTD_FIELDS }    from './state-income-classification.js';

/**
 * US state tax settlement (design 34 §5) — the state analog of the federal
 * settle chain, scheduled on the US calendar year-end (Dec 31). Because the
 * state keeps its own `state*YTD` accumulators, this chain is fully decoupled
 * from the federal settle's reset ordering.
 *
 *   TAX_SETTLE_STATE (Dec 31)
 *     → StateTaxSettleHandler           computes liability for the active state
 *     → STATE_TAX_SETTLE_APPLY          resets state*YTD; chains the debit if tax > 0
 *     → STATE_TAX_PAYMENT_DEBIT         debits the US savings account
 */

export class StateTaxSettleHandler extends HandlerEntry {
  static type        = 'StateTaxSettleHandler';
  static category    = 'handler';
  static eventType   = 'TAX_SETTLE_STATE';
  static description  = 'Computes end-of-year US state tax for the active residency state and emits STATE_TAX_SETTLE_APPLY + RECORD_BALANCE.';

  constructor() {
    super(null, 'State Tax Settle');
    this._settleService = new StateTaxSettleService();
    this.generatedActionTypes = ['STATE_TAX_SETTLE_APPLY', 'RECORD_BALANCE'];
  }

  call({ state }) {
    const taxDetail = this._settleService.computeStateTax(state);
    // No active residency state (or abroad) ⇒ nothing accrued, nothing to settle.
    // Skip emitting so the default (no-state) scenario's journal stays clean.
    if (!taxDetail.stateCode) return [];
    return [
      { type: 'STATE_TAX_SETTLE_APPLY', tax: taxDetail.netLiability, taxDetail },
      { type: 'RECORD_BALANCE' },
    ];
  }
}

export class StateTaxSettleApplyReducer extends Reducer {
  static type        = 'StateTaxSettleApplyReducer';
  static category    = 'reducer';
  static description = 'Resets state YTD tax fields after settlement; chains STATE_TAX_PAYMENT_DEBIT when tax > 0.';

  constructor() {
    super('State Tax Settle Apply', PRIORITY.TAX_APPLY);
    this.reducedActionTypes   = ['STATE_TAX_SETTLE_APPLY'];
    this.generatedActionTypes = ['STATE_TAX_PAYMENT_DEBIT'];
  }

  static fromJSON(d) {
    const r = new this();
    r.id = d.id;
    return r;
  }

  reduce(state, action) {
    const { tax } = action;
    const resets = {};
    for (const field of STATE_YTD_FIELDS) {
      if (field in state) resets[field] = 0;
    }
    if (tax > 0) {
      return this.newState({ ...state, ...resets }, {}, [{ type: 'STATE_TAX_PAYMENT_DEBIT', amount: tax }]);
    }
    return this.newState({ ...state, ...resets });
  }
}

export class StateTaxPaymentDebitReducer extends Reducer {
  static type        = 'StateTaxPaymentDebitReducer';
  static category    = 'reducer';
  static description = 'Debits the US savings account for the state tax amount; replenishes from investment accounts first when the balance is short.';

  constructor({ accountService, stateRegistry }) {
    super('State Tax Payment Debit', PRIORITY.TAX_APPLY + 1);
    this.accountService = accountService;
    this.stateRegistry  = stateRegistry;
    this.reducedActionTypes = ['STATE_TAX_PAYMENT_DEBIT'];
  }

  static fromJSON(d, services) {
    const r = new this(services);
    r.id = d.id;
    return r;
  }

  reduce(state, action, date) {
    const accountKey  = this.stateRegistry.getStateKey(ACCOUNT_ROLES.US_SAVINGS);
    const cashAccount = state[accountKey];
    const shortfall   = action.amount - Math.max(0, cashAccount.balance);

    if (shortfall > 0) {
      try {
        this.accountService.replenishSavings(state, accountKey, shortfall, date);
      } catch (e) {
        if (!(e instanceof InsufficientFundsError)) throw e;
        // Partial payment — pay what's available.
      }
    }

    const debit = Math.min(action.amount, Math.max(0, cashAccount.balance));
    if (debit > 0) {
      this.accountService.transaction(cashAccount, -debit, date);
    }

    return this.newState(state, {
      [accountKey]: { ...cashAccount },   // explicit new reference so the balance change shows in diffs
    });
  }
}
