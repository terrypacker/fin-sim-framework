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
import { HandlerEntry }       from '../../simulation-framework/handlers.js';
import { RecordBalanceAction } from '../../simulation-framework/actions.js';

const usCash = (state) => state.usSavingsAccount ?? state.checkingAccount;
const auCash = (state) => state.auSavingsAccount ?? state.checkingAccount;

// ─── US Mortgage Payment ───────────────────────────────────────────────────────

/**
 * Handles US_MORTGAGE_PAYMENT events.
 *
 * For each US property that still has a positive mortgage balance, computes the
 * actual payment (capped at the remaining balance so the last payment never
 * overpays) and dispatches REPLENISH_SAVINGS if the payment would take the cash
 * account below its minimum balance, then dispatches US_MORTGAGE_PAYMENT_APPLY.
 *
 * Returns no actions when all properties have mortgageBalance <= 0 or the
 * property state is absent (house already sold and state cleared).
 *
 * @param {object} opts
 * @param {{ stateKey: string, monthlyMortgage: number }[]} opts.properties
 */
export class UsMortgagePaymentHandler extends HandlerEntry {
  static description = 'Dispatches REPLENISH_SAVINGS (if needed) then US_MORTGAGE_PAYMENT_APPLY for each US property with a remaining mortgage balance; payment capped to remaining balance so the last payment never overpays.';
  static eventType   = 'US_MORTGAGE_PAYMENT';

  constructor({ properties = [] } = {}) {
    super(null, 'US Mortgage Payment');
    this.properties = properties;
    this.generatedActionTypes = ['REPLENISH_SAVINGS', 'US_MORTGAGE_PAYMENT_APPLY', 'RECORD_BALANCE'];
  }

  call({ data, state }) {
    const cashKey = state.usSavingsAccount != null ? 'usSavingsAccount' : 'checkingAccount';
    const account = state[cashKey];
    const actions = [];

    for (const { stateKey, monthlyMortgage } of this.properties) {
      const propState = state[stateKey];
      if (!propState || propState.mortgageBalance <= 0) continue;

      const payment      = Math.min(monthlyMortgage, propState.mortgageBalance);
      const postDebitBal = account.balance - payment;
      const deficit      = (account.minimumBalance ?? 0) - postDebitBal;
      if (deficit > 0) {
        actions.push({ type: 'REPLENISH_SAVINGS', deficit, targetKey: cashKey });
      }
      actions.push({ type: 'US_MORTGAGE_PAYMENT_APPLY', stateKey, payment, cashKey });
    }

    if (actions.length > 0) {
      actions.push(new RecordBalanceAction(`${cashKey}.balance`, cashKey));
    }
    return actions;
  }
}

/**
 * Handles US_MORTGAGE_PAYMENT_APPLY actions.
 *
 * Debits the US cash pool by the lesser of (payment, available balance), then
 * decrements the property's mortgageBalance by the amount actually paid.
 * Capping to available balance ensures the account never goes negative even if
 * replenishment was insufficient.
 *
 * @param {object} opts
 * @param {import('../../finance/services/account-service.js').AccountService} opts.accountService
 */
export class UsMortgagePaymentApplyReducer extends Reducer {
  static description = 'Debits the US cash pool (capped to available balance) and decrements mortgageBalance by the amount actually paid.';
  static actionType  = 'US_MORTGAGE_PAYMENT_APPLY';

  constructor({ accountService }) {
    super('US Mortgage Payment Apply', PRIORITY.CASH_FLOW);
    this.accountService = accountService;
    this.reducedActionTypes   = ['US_MORTGAGE_PAYMENT_APPLY'];
    this.generatedActionTypes = [];
  }

  reduce(state, action) {
    const { stateKey, payment, cashKey } = action;
    const propState   = state[stateKey];
    const cashAccount = state[cashKey] ?? usCash(state);

    const actualDebit = Math.min(payment, Math.max(0, cashAccount.balance));
    if (actualDebit > 0) {
      this.accountService.transaction(cashAccount, -actualDebit, null);
    }

    const newBalance = Math.max(0, (propState?.mortgageBalance ?? 0) - actualDebit);
    return this.newState(state, {
      [stateKey]: { ...propState, mortgageBalance: newBalance },
    }, []);
  }
}

// ─── AU Mortgage Payment ───────────────────────────────────────────────────────

/**
 * Handles AU_MORTGAGE_PAYMENT events.
 *
 * Mirrors UsMortgagePaymentHandler but targets the AU cash pool.
 *
 * @param {object} opts
 * @param {{ stateKey: string, monthlyMortgage: number }[]} opts.properties
 */
export class AuMortgagePaymentHandler extends HandlerEntry {
  static description = 'Dispatches REPLENISH_SAVINGS (if needed) then AU_MORTGAGE_PAYMENT_APPLY for each AU property with a remaining mortgage balance; payment capped to remaining balance so the last payment never overpays.';
  static eventType   = 'AU_MORTGAGE_PAYMENT';

  constructor({ properties = [] } = {}) {
    super(null, 'AU Mortgage Payment');
    this.properties = properties;
    this.generatedActionTypes = ['REPLENISH_SAVINGS', 'AU_MORTGAGE_PAYMENT_APPLY', 'RECORD_BALANCE'];
  }

  call({ data, state }) {
    const cashKey = state.auSavingsAccount != null ? 'auSavingsAccount' : 'checkingAccount';
    const account = state[cashKey];
    const actions = [];

    for (const { stateKey, monthlyMortgage } of this.properties) {
      const propState = state[stateKey];
      if (!propState || propState.mortgageBalance <= 0) continue;

      const payment      = Math.min(monthlyMortgage, propState.mortgageBalance);
      const postDebitBal = account.balance - payment;
      const deficit      = (account.minimumBalance ?? 0) - postDebitBal;
      if (deficit > 0) {
        actions.push({ type: 'REPLENISH_SAVINGS', deficit, targetKey: cashKey });
      }
      actions.push({ type: 'AU_MORTGAGE_PAYMENT_APPLY', stateKey, payment, cashKey });
    }

    if (actions.length > 0) {
      actions.push(new RecordBalanceAction(`${cashKey}.balance`, cashKey));
    }
    return actions;
  }
}

/**
 * Handles AU_MORTGAGE_PAYMENT_APPLY actions.
 *
 * Debits the AU cash pool by the lesser of (payment, available balance), then
 * decrements the property's mortgageBalance by the amount actually paid.
 * Capping to available balance ensures the account never goes negative even if
 * replenishment was insufficient.
 *
 * @param {object} opts
 * @param {import('../../finance/services/account-service.js').AccountService} opts.accountService
 */
export class AuMortgagePaymentApplyReducer extends Reducer {
  static description = 'Debits the AU cash pool (capped to available balance) and decrements mortgageBalance by the amount actually paid.';
  static actionType  = 'AU_MORTGAGE_PAYMENT_APPLY';

  constructor({ accountService }) {
    super('AU Mortgage Payment Apply', PRIORITY.CASH_FLOW);
    this.accountService = accountService;
    this.reducedActionTypes   = ['AU_MORTGAGE_PAYMENT_APPLY'];
    this.generatedActionTypes = [];
  }

  reduce(state, action) {
    const { stateKey, payment, cashKey } = action;
    const propState   = state[stateKey];
    const cashAccount = state[cashKey] ?? auCash(state);

    const actualDebit = Math.min(payment, Math.max(0, cashAccount.balance));
    if (actualDebit > 0) {
      this.accountService.transaction(cashAccount, -actualDebit, null);
    }

    const newBalance = Math.max(0, (propState?.mortgageBalance ?? 0) - actualDebit);
    return this.newState(state, {
      [stateKey]: { ...propState, mortgageBalance: newBalance },
    }, []);
  }
}
