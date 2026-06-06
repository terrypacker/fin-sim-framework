/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { HandlerEntry }                        from '../../../simulation-framework/handlers.js';
import { RecordBalanceAction, RecordMetricAction } from '../../../simulation-framework/actions.js';

/**
 * HealthcareEventHandler — handles HEALTHCARE_EXPENSE one-off events.
 *
 * Treats the healthcare expense as an essential cash outflow:
 *   1. Prepends REPLENISH_SAVINGS if the target savings account would fall below
 *      its minimumBalance after the debit (same pattern as MonthlyExpensesHandler).
 *   2. Emits EXPENSE_DEBIT to debit from the residence-appropriate savings account.
 *   3. Emits HEALTHCARE_EXPENSE_APPLY for tracking in state.
 *
 * Event data: { amount, category, personId }
 *
 * @param {object} opts
 * @param {import('../../../finance/services/state-registry.js').StateRegistry} opts.stateRegistry
 * @param {string} opts.usRole       ACCOUNT_ROLES value for the USD cash pool
 * @param {string} [opts.usOwnerId]  Person id for US savings (null = any owner)
 * @param {string} opts.auRole       ACCOUNT_ROLES value for the AUD cash pool
 * @param {string} [opts.auOwnerId]  Person id for AU savings (null = any owner)
 */
export class HealthcareEventHandler extends HandlerEntry {
  static description = 'Handles HEALTHCARE_EXPENSE one-off events: debits the residence-appropriate savings account and emits HEALTHCARE_EXPENSE_APPLY for tracking.';
  static type        = 'HealthcareEventHandler';
  static eventType   = 'HEALTHCARE_EXPENSE';

  constructor({
    stateRegistry,
    usRole, usOwnerId = null,
    auRole, auOwnerId = null,
  } = {}) {
    super(null, 'Healthcare Expense');
    this.stateRegistry         = stateRegistry;
    this.usRole                = usRole;
    this.usOwnerId             = usOwnerId;
    this.auRole                = auRole;
    this.auOwnerId             = auOwnerId;
    this.generatedActionTypes  = ['REPLENISH_SAVINGS', 'EXPENSE_DEBIT', 'HEALTHCARE_EXPENSE_APPLY', 'RECORD_METRIC', 'RECORD_BALANCE'];
  }

  call({ state, data }) {
    const amount     = data?.amount ?? 0;
    const category   = data?.category ?? 'healthcare';
    const personId   = data?.personId ?? null;
    if (!amount) return [];

    const personKey  = personId ?? Object.keys(state.people ?? {})[0];
    const residency  = state.people?.[personKey]?.residency ?? null;
    const isAu       = residency === 'AUS';
    const targetKey  = isAu
      ? this.stateRegistry.getStateKey(this.auRole, this.auOwnerId)
      : this.stateRegistry.getStateKey(this.usRole, this.usOwnerId);
    const account    = state[targetKey];

    const actions = [];

    if (account) {
      const postDebitBal = account.balance - amount;
      const deficit      = (account.minimumBalance ?? 0) - postDebitBal;
      if (deficit > 0) {
        actions.push({ type: 'REPLENISH_SAVINGS', deficit, targetKey });
      }
      actions.push({ type: 'EXPENSE_DEBIT', amount, targetKey });
      actions.push(new RecordBalanceAction(`${targetKey}.balance`, targetKey));
    }

    actions.push({ type: 'HEALTHCARE_EXPENSE_APPLY', amount, category, personId });
    actions.push(new RecordMetricAction('healthcare_expenses', amount));

    return actions;
  }
}
