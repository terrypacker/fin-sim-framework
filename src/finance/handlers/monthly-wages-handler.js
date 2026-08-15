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
 * The wage is routed by the person's `wageCurrency` (design 50), which is purely a
 * *denomination* concern and is independent of both the earner's residency and the
 * source of the income:
 *   - USD wage → WAGES_INCOME_APPLY → US cash pool, as native USD.
 *   - AUD wage → AU_WAGES_INCOME_APPLY → AU cash pool, as native AUD.
 * The matching *ApplyReducer credits the correct-currency account and chains the
 * per-country tax action. The deposit is the native wage figure — no FX coercion.
 *
 * Design 73 Gap 1: currency is NOT a proxy for source. Source of employment income
 * is the place the services are performed, so `workCountry` is stamped on the apply
 * action and carried to the tax reducer, which branches on source first and
 * residency second. Left null it follows the earner's residency at accrual, so a
 * scenario that never sets it behaves exactly as before.
 *
 * KNOWN LIMITATION: routing is still by currency, so a USD-paid wage for work
 * performed in Australia emits no AU action and Australia assesses nothing —
 * unchanged from before, and wrong. Fixing it means emitting the AU tax action off
 * `workCountry` while the cash still follows `wageCurrency`, decoupling the tax
 * action from the cash-flow action. `workCountry` is stamped on ALL FOUR apply types
 * so that change is a reducer-side one when it comes.
 *
 * Design 73 §6b: both AU classifiers now read it, via `AuWagesIncomeApplyReducer`
 * and `AuSeIncomeApplyReducer`. The two US apply reducers still drop it — nothing on
 * the US return reads it yet, because US earned-income sourcing (§861(a)(3) /
 * §862(a)(3)) is a tax-model question left open in §6b.
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
    this.generatedActionTypes = ['WAGES_INCOME_APPLY', 'AU_WAGES_INCOME_APPLY', 'SE_INCOME_US_APPLY', 'SE_INCOME_AU_APPLY', 'RECORD_FIELD_VALUE', 'RECORD_BALANCE'];
  }

  static fromJSON(d, { stateRegistry }) {
    const h = new this({ stateRegistry });
    h.id = d.id;
    return h;
  }

  call({ date, state }) {
    const actions = [];
    // Cash pools actually credited this tick, so we RECORD_BALANCE each exactly once.
    const touched = new Set();

    for (const [key, person] of Object.entries(state.people ?? {})) {
      const wage = person.monthlyWage ?? 0;
      if (wage <= 0) continue;
      const retDate = person.retirementDate;
      if (retDate && date >= retDate) continue;

      const isAud   = person.wageCurrency === 'AUD';
      // Wages land in the designated transaction account (design 55 §7), preferring
      // the earner's own flagged account, then the household's; falling back to the
      // country's savings role (legacy single-pool behavior) so unflagged scenarios
      // are unchanged. targetKey is stamped so the apply reducer credits it directly.
      const country   = isAud ? 'AU' : 'US';
      const role      = isAud ? ACCOUNT_ROLES.AU_SAVINGS : ACCOUNT_ROLES.US_SAVINGS;
      const targetKey = this.stateRegistry?.resolveTransactionAccountKey?.(country, key)
        ?? this.stateRegistry?.getStateKey(role, key)
        ?? this.stateRegistry?.getStateKey(role)
        ?? (isAud ? 'auSavingsAccount' : 'usSavingsAccount');
      // Design 69: a self-employed person's monthlyWage is self-employment income —
      // route it through the SE apply path (SECA on the US side) instead of wages.
      // Currency/target/personKey/residency are identical to the wage path.
      const isSelfEmployed = !!person.selfEmployed;
      const applyType = isSelfEmployed
        ? (isAud ? 'SE_INCOME_AU_APPLY' : 'SE_INCOME_US_APPLY')
        : (isAud ? 'AU_WAGES_INCOME_APPLY' : 'WAGES_INCOME_APPLY');
      const label = isSelfEmployed ? 'Self-Employment' : 'Wages';
      // Where the work is actually performed (design 73 Gap 1). Unset ⇒ the earner
      // works where they live, resolved at accrual so it tracks a mid-sim move.
      const workCountry = person.workCountry ?? person.residency ?? null;
      actions.push(
        { type: applyType, amount: wage, residency: person.residency ?? null, personKey: key, targetKey, workCountry },
        new FieldValueAction(`wages_${key}`, `${person.name || key} ${label}`, wage),
      );
      touched.add(targetKey);
    }

    for (const cashKey of touched) {
      actions.push(new RecordBalanceAction(`${cashKey}.balance`, cashKey));
    }

    return actions;
  }
}
