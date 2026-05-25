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
 * Handles the MONTHLY_SS_INCOME event.
 *
 * Iterates over all people in state.people and dispatches SS_INCOME_APPLY
 * for each person whose socialSecurityMonthly > 0 and whose retirementDate
 * has been reached (or is null, meaning SS is always active).
 *
 * Eligibility age (minAge) is read from the AccountRulesEngine so that the rule
 * lives in the account module rather than being baked into this handler.
 *
 * The SsIncomeApplyReducer (registered via the US account module) handles the
 * actual cash credit and tax chaining (85% of SS is taxable ordinary income).
 *
 * @param {object} [opts]
 * @param {import('../services/state-registry.js').StateRegistry}    opts.stateRegistry
 * @param {import('../account-rules/account-rules-engine.js').AccountRulesEngine} [opts.accountRulesEngine]
 */
export class MonthlySocialSecurityHandler extends HandlerEntry {
  static description = 'Credits the US cash pool with Social Security income for each eligible person; starts at their retirementDate.';
  static eventType   = 'MONTHLY_SS_INCOME';

  constructor({ stateRegistry, accountRulesEngine } = {}) {
    super(null, 'Monthly Social Security');
    this.stateRegistry      = stateRegistry;
    this.accountRulesEngine = accountRulesEngine ?? null;
    this.generatedActionTypes = ['SS_INCOME_APPLY', 'RECORD_FIELD_VALUE', 'RECORD_BALANCE'];
  }

  call({ date, state }) {
    const actions = [];
    const cashKey = this.stateRegistry?.getStateKey(ACCOUNT_ROLES.US_SAVINGS) ?? 'usSavingsAccount';

    //TODO #292 Support Early or FRA, this is FRA only right now (Born 1960+ FRA is 67)
    //  there are also 'delayed retirement credits' that can accrue to age 70
    const year    = date.getUTCFullYear();
    const ssRules = this.accountRulesEngine?.get('US', year)?.getSsEligibilityRules?.();
    const minAge  = ssRules?.minAge ?? 67;

    for (const [key, person] of Object.entries(state.people ?? {})) {
      const ssMonthly = person.socialSecurityMonthly ?? 0;
      if (ssMonthly <= 0) continue;

      const age = getAge(person.birthDate, date);
      if (age < minAge) continue;

      const retDate = person.retirementDate;
      if (retDate && date < new Date(retDate)) continue;

      actions.push(
        { type: 'SS_INCOME_APPLY', amount: ssMonthly, isAuResident: state.isAuResident },
        new FieldValueAction(`ss_income_${key}`, `${person.name || key} Social Security`, ssMonthly),
      );
    }

    if (actions.length > 0) {
      actions.push(new RecordBalanceAction(`${cashKey}.balance`, cashKey));
    }

    return actions;
  }
}

/** Returns age in whole years as of asOfDate. */
function getAge(birthDate, asOfDate) {
  const years = asOfDate.getUTCFullYear() - birthDate.getUTCFullYear();
  const hadBirthday =
      asOfDate.getUTCMonth() > birthDate.getUTCMonth() ||
      (asOfDate.getUTCMonth() === birthDate.getUTCMonth() &&
          asOfDate.getUTCDate() >= birthDate.getUTCDate());
  return hadBirthday ? years : years - 1;
}
