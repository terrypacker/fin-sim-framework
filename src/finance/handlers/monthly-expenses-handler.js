/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { HandlerEntry } from '../../simulation-framework/handlers.js';
import { RecordBalanceAction, RecordMetricAction } from '../../simulation-framework/actions.js';
import { convertExpenseToAccount } from '../fx/expense-fx.js';

/**
 * Handles the MONTHLY_EXPENSES event.
 *
 * Reads primaryPersonKey's residency to determine whether expenses
 * come from the US savings account (USD, 'US' residency) or AU savings account
 * (AUD, 'AUS' residency).
 *
 * The configured expense figure is denominated in `expensesCurrency` (the
 * currency chosen for the monthlyExpenses param, USD by default). Before
 * debiting, it is converted into the *target account's* currency via the run's
 * recorded exchange rate — so after the move a USD expense leaves the converted
 * AUD magnitude from AU savings (e.g. $10k @ 1.5 → A$15k), not the raw number.
 * The RECORD_METRIC 'monthly_expenses' value stays in the native currency so
 * the expense-level series reads consistently across the move.
 *
 * If the target savings account would fall below its minimumBalance after the
 * (converted) debit, a REPLENISH_SAVINGS action is prepended to trigger the
 * drawdown cascade before the debit fires.
 *
 * data.amount overrides the configured monthlyExpenses for one-off adjustments;
 * it is treated as already being in `expensesCurrency`.
 *
 * @param {object} opts
 * @param {import('../services/state-registry.js').StateRegistry} opts.stateRegistry
 * @param {number} [opts.monthlyExpenses=6000]
 * @param {string} [opts.expensesCurrency='USD'] - Native currency of the expense figure
 * @param {string} opts.usRole           - ACCOUNT_ROLES value for the USD cash pool
 * @param {string} [opts.usOwnerId]      - Person id for US savings (null = any owner)
 * @param {string} opts.auRole           - ACCOUNT_ROLES value for the AUD cash pool
 * @param {string} [opts.auOwnerId]      - Person id for AU savings (null = any owner)
 * @param {string} [opts.primaryPersonKey] - Person key to read residency from; defaults to first person
 */
export class MonthlyExpensesHandler extends HandlerEntry {
  static description = 'Residence-aware monthly expense handler: debits US savings (pre-move) or AU savings (post-move) based on primaryPersonKey residency, prepending REPLENISH_SAVINGS if needed.';
  static type        = 'MonthlyExpensesHandler';
  static eventType   = 'MONTHLY_EXPENSES';

  constructor({
    stateRegistry,
    monthlyExpenses = 6000,
    expensesCurrency = 'USD',
    usRole, usOwnerId = null,
    auRole, auOwnerId = null,
    primaryPersonKey = null,
  } = {}) {
    super(null, 'Monthly Expenses');
    this.stateRegistry      = stateRegistry;
    this.monthlyExpenses    = monthlyExpenses;
    this.expensesCurrency   = expensesCurrency;
    this.usRole             = usRole;
    this.usOwnerId          = usOwnerId;
    this.auRole             = auRole;
    this.auOwnerId          = auOwnerId;
    this.primaryPersonKey   = primaryPersonKey;
    this.generatedActionTypes = ['REPLENISH_SAVINGS', 'EXPENSE_DEBIT', 'RECORD_METRIC', 'RECORD_BALANCE'];
  }

  static fromJSON(d, { stateRegistry }) {
    const h = new this({
      stateRegistry,
      monthlyExpenses:  d.monthlyExpenses  ?? 6000,
      expensesCurrency: d.expensesCurrency ?? 'USD',
      usRole:           d.usRole           ?? null,
      usOwnerId:        d.usOwnerId        ?? null,
      auRole:           d.auRole           ?? null,
      auOwnerId:        d.auOwnerId        ?? null,
      primaryPersonKey: d.primaryPersonKey ?? null,
    });
    h.id = d.id;
    return h;
  }

  toJSON() {
    return {
      ...super.toJSON(),
      monthlyExpenses:  this.monthlyExpenses,
      expensesCurrency: this.expensesCurrency,
      usRole:           this.usRole,
      usOwnerId:        this.usOwnerId,
      auRole:           this.auRole,
      auOwnerId:        this.auOwnerId,
      primaryPersonKey: this.primaryPersonKey,
    };
  }

  call({ data, state }) {
    // Native expense figure (in expensesCurrency); the metric records this.
    const nativeAmount = data?.amount ?? state.monthlyExpenses ?? this.monthlyExpenses;
    const personKey   = this.primaryPersonKey ?? Object.keys(state.people ?? {})[0];
    const residency   = state.people?.[personKey]?.residency ?? null;
    const isAu        = residency === 'AUS';
    const targetKey   = isAu
      ? this.stateRegistry.getStateKey(this.auRole, this.auOwnerId)
      : this.stateRegistry.getStateKey(this.usRole, this.usOwnerId);
    const account   = state[targetKey];

    // Convert into the target account's currency so the actual withdrawal is
    // the real-terms cost (e.g. USD expense from AUD savings after the move).
    const debitAmount = convertExpenseToAccount(nativeAmount, this.expensesCurrency, account, state);

    const actions = [];

    const postDebitBal = account.balance - debitAmount;
    const deficit      = (account.minimumBalance ?? 0) - postDebitBal;
    if (deficit > 0) {
      actions.push({ type: 'REPLENISH_SAVINGS', deficit, targetKey });
    }

    actions.push(
      { type: 'EXPENSE_DEBIT', amount: debitAmount, targetKey },
      new RecordMetricAction('monthly_expenses', nativeAmount),
      new RecordBalanceAction(`${targetKey}.balance`, targetKey),
    );
    return actions;
  }
}
