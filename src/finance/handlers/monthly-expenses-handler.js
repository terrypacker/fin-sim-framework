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
 * come from usSavingsAccount (USD pre-move) or auSavingsAccount (AUD post-move).
 *
 * If the target savings account would fall below its minimumBalance after the
 * debit, a REPLENISH_SAVINGS action is prepended to trigger the drawdown
 * cascade before the debit fires.
 *
 * data.amount overrides the configured monthlyExpenses for one-off adjustments.
 *
 * @param {object} opts
 * @param {number} [opts.monthlyExpenses=6000]
 *   Default monthly spending amount in the local currency.
 * @param {string} [opts.usAccountKey='usSavingsAccount']
 *   State key for the USD cash pool.
 * @param {string} [opts.auAccountKey='auSavingsAccount']
 *   State key for the AUD cash pool.
 */
export class MonthlyExpensesHandler extends HandlerEntry {
  static description = 'Residence-aware monthly expense handler: debits usSavingsAccount (pre-move) or auSavingsAccount (post-move), prepending REPLENISH_SAVINGS if the balance would fall below minimum.';

  static eventType = 'MONTHLY_EXPENSES';

  constructor({ monthlyExpenses = 6000, usAccountKey = 'usSavingsAccount', auAccountKey = 'auSavingsAccount' } = {}) {
    super(null, 'Monthly Expenses');
    this.monthlyExpenses = monthlyExpenses;
    this.usAccountKey    = usAccountKey;
    this.auAccountKey    = auAccountKey;
  }

  call({ data, state }) {
    const amount    = data?.amount ?? this.monthlyExpenses;
    const targetKey = state.isAuResident ? this.auAccountKey : this.usAccountKey;
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
      new RecordBalanceAction(),
    );
    return actions;
  }
}
