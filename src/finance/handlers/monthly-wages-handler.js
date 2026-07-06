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
 * Iterates over all people in state.people and dispatches an income-apply action
 * for each person whose monthlyWage > 0 and whose retirementDate has not yet
 * been reached. Stops emitting wages for a person on or after their retirementDate.
 *
 * The wage is routed by the person's `wageCurrency` (design 50), which is the
 * *source/denomination* of the wage and is independent of the earner's residency:
 *   - USD wage → WAGES_INCOME_APPLY → US cash pool (US-source ordinary income).
 *   - AUD wage → AU_WAGES_INCOME_APPLY → AU cash pool as native AUD (AU-source).
 * The matching *ApplyReducer credits the correct-currency account and chains the
 * per-country tax action; the tax module keys AU treatment off the earner's
 * residency (non-resident withholding for a US resident, ordinary income for an
 * AU resident). The deposit is the native wage figure — no FX coercion.
 *
 * @param {object} [opts]
 * @param {import('../services/state-registry.js').StateRegistry} opts.stateRegistry
 */
export class MonthlyWagesHandler extends HandlerEntry {
  static description = 'Credits each employed person\'s wage to the cash pool matching their wageCurrency (USD→US, AUD→AU); stops at their retirementDate.';
  static type        = 'MonthlyWagesHandler';
  static eventType   = 'MONTHLY_WAGES';

  constructor({ stateRegistry } = {}) {
    super(null, 'Monthly Wages');
    this.stateRegistry = stateRegistry;
    this.generatedActionTypes = ['WAGES_INCOME_APPLY', 'AU_WAGES_INCOME_APPLY', 'RECORD_FIELD_VALUE', 'RECORD_BALANCE'];
  }

  static fromJSON(d, { stateRegistry }) {
    const h = new this({ stateRegistry });
    h.id = d.id;
    return h;
  }

  call({ date, state }) {
    const actions = [];
    const usCashKey = this.stateRegistry?.getStateKey(ACCOUNT_ROLES.US_SAVINGS) ?? 'usSavingsAccount';
    const auCashKey = this.stateRegistry?.getStateKey(ACCOUNT_ROLES.AU_SAVINGS) ?? 'auSavingsAccount';
    // Cash pools actually credited this tick, so we RECORD_BALANCE each exactly once.
    const touched = new Set();

    for (const [key, person] of Object.entries(state.people ?? {})) {
      const wage = person.monthlyWage ?? 0;
      if (wage <= 0) continue;
      const retDate = person.retirementDate;
      if (retDate && date >= retDate) continue;

      const isAud = person.wageCurrency === 'AUD';
      actions.push(
        isAud
          ? { type: 'AU_WAGES_INCOME_APPLY', amount: wage, residency: person.residency ?? null, personKey: key }
          : { type: 'WAGES_INCOME_APPLY',    amount: wage, residency: person.residency ?? null, personKey: key },
        new FieldValueAction(`wages_${key}`, `${person.name || key} Wages`, wage),
      );
      touched.add(isAud ? auCashKey : usCashKey);
    }

    for (const cashKey of touched) {
      actions.push(new RecordBalanceAction(`${cashKey}.balance`, cashKey));
    }

    return actions;
  }
}
