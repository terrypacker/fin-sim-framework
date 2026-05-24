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

/**
 * Handles the MONTHLY_EXPENSES event.
 *
 * Residence-aware: reads state.isAuResident to determine whether expenses
 * come from the US savings account (USD pre-move) or AU savings account
 * (AUD post-move).
 *
 * If the target savings account would fall below its minimumBalance after the
 * debit, a REPLENISH_SAVINGS action is prepended to trigger the drawdown
 * cascade before the debit fires.
 *
 * data.amount overrides the configured monthlyExpenses for one-off adjustments.
 *
 * @param {object} opts
 * @param {import('../services/state-registry.js').StateRegistry} opts.stateRegistry
 * @param {number} [opts.monthlyExpenses=6000]
 * @param {string} opts.usRole      - ACCOUNT_ROLES value for the USD cash pool
 * @param {string} [opts.usOwnerId] - Person id for US savings (null = any owner)
 * @param {string} opts.auRole      - ACCOUNT_ROLES value for the AUD cash pool
 * @param {string} [opts.auOwnerId] - Person id for AU savings (null = any owner)
 */
export class MonthlyExpensesHandler extends HandlerEntry {
  static description = 'Residence-aware monthly expense handler: debits US savings (pre-move) or AU savings (post-move), prepending REPLENISH_SAVINGS if the balance would fall below minimum.';

  static eventType = 'MONTHLY_EXPENSES';

  constructor({
    stateRegistry,
    monthlyExpenses = 6000,
    usRole, usOwnerId = null,
    auRole, auOwnerId = null,
  } = {}) {
    super(null, 'Monthly Expenses');
    this.stateRegistry  = stateRegistry;
    this.monthlyExpenses = monthlyExpenses;
    this.usRole         = usRole;
    this.usOwnerId      = usOwnerId;
    this.auRole         = auRole;
    this.auOwnerId      = auOwnerId;
    this.generatedActionTypes = ['REPLENISH_SAVINGS', 'EXPENSE_DEBIT', 'RECORD_METRIC', 'RECORD_BALANCE'];
  }

  call({ data, state }) {
    const amount    = data?.amount ?? state.monthlyExpenses ?? this.monthlyExpenses;
    const isAu      = state.isAuResident;
    const targetKey = isAu
      ? this.stateRegistry.getStateKey(this.auRole, this.auOwnerId)
      : this.stateRegistry.getStateKey(this.usRole, this.usOwnerId);
    const account   = state[targetKey];

    const actions = [];

    const postDebitBal = account.balance - amount;
    const deficit      = (account.minimumBalance ?? 0) - postDebitBal;
    if (deficit > 0) {
      actions.push({ type: 'REPLENISH_SAVINGS', deficit, targetKey });
    }

    actions.push(
      { type: 'EXPENSE_DEBIT', amount },
      new RecordMetricAction('monthly_expenses', amount),
      new RecordBalanceAction(`${targetKey}.balance`, targetKey),
    );
    return actions;
  }
}
