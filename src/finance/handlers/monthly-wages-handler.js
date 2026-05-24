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
import { FieldValueAction, RecordBalanceAction } from '../../simulation-framework/actions.js';
import { ACCOUNT_ROLES } from '../state/account-roles.js';

/**
 * Handles the MONTHLY_WAGES event.
 *
 * Iterates over all people in state.people and dispatches WAGES_INCOME_APPLY
 * for each person whose monthlyWage > 0 and whose retirementDate has not yet
 * been reached. Stops emitting wages for a person on or after their retirementDate.
 *
 * The WagesIncomeApplyReducer (registered via the US account module) handles the
 * actual cash credit and tax chaining.
 *
 * @param {object} [opts]
 * @param {import('../services/state-registry.js').StateRegistry} opts.stateRegistry
 */
export class MonthlyWagesHandler extends HandlerEntry {
  static description = 'Credits the US cash pool with gross wages for each employed person; stops at their retirementDate.';
  static eventType   = 'MONTHLY_WAGES';

  constructor({ stateRegistry } = {}) {
    super(null, 'Monthly Wages');
    this.stateRegistry = stateRegistry;
    this.generatedActionTypes = ['WAGES_INCOME_APPLY', 'RECORD_FIELD_VALUE', 'RECORD_BALANCE'];
  }

  call({ date, state }) {
    const actions = [];
    const cashKey = this.stateRegistry?.getStateKey(ACCOUNT_ROLES.US_SAVINGS) ?? 'usSavingsAccount';

    for (const [key, person] of Object.entries(state.people ?? {})) {
      const wage = person.monthlyWage ?? 0;
      if (wage <= 0) continue;
      const retDate = person.retirementDate;
      if (retDate && date >= retDate) continue;

      actions.push(
        { type: 'WAGES_INCOME_APPLY', amount: wage, isAuResident: state.isAuResident, personKey: key },
        new FieldValueAction(`wages_${key}`, `${person.name || key} Wages`, wage),
      );
    }

    if (actions.length > 0) {
      actions.push(new RecordBalanceAction(`${cashKey}.balance`, cashKey));
    }

    return actions;
  }
}
