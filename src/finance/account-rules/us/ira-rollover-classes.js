/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { Reducer, PRIORITY } from '../../../simulation-framework/reducers.js';
import { HandlerEntry }       from '../../../simulation-framework/handlers.js';
import { FieldValueAction, RecordBalanceAction } from '../../../simulation-framework/actions.js';
import { getUniformDistributionPeriod } from './us-rmd-uniform-table.js';

/** Resolve the US cash pool. */
const usCash = (state) => state.usSavingsAccount ?? state.checkingAccount;

/**
 * Reduce IRA by `amount`, drawing from contributionBasis first then earningsBasis.
 * Returns the updated iraAccount object.
 */
export function debitIra(ia, amount) {
  const fromContrib  = Math.min(amount, ia.contributionBasis);
  const fromEarnings = Math.min(amount - fromContrib, ia.earningsBasis);
  return {
    ...ia,
    balance:           ia.balance           - amount,
    contributionBasis: ia.contributionBasis - fromContrib,
    earningsBasis:     ia.earningsBasis     - fromEarnings,
  };
}

// ─── Reducers ─────────────────────────────────────────────────────────────────

/**
 * EVT-35: IRA Rollover Withdrawal — credit US cash pool, debit IRA (contrib first
 * then earnings).  No penalty regardless of age (rollovers are penalty-exempt).
 * Chains IRA_ROLLOVER_WITHDRAWAL_TAX (ordinary income).
 */
export class IraRolloverWithdrawalApplyReducer extends Reducer {
  static description = 'Credits the US cash pool and debits the IRA (no penalty); chains IRA_ROLLOVER_WITHDRAWAL_TAX.';
  static actionType  = 'IRA_ROLLOVER_WITHDRAWAL_APPLY';

  constructor({ accountService }) {
    super('IRA Rollover Withdrawal Apply', PRIORITY.CASH_FLOW);
    this.accountService = accountService;
    this.reducedActionTypes   = ['IRA_ROLLOVER_WITHDRAWAL_APPLY'];
    this.generatedActionTypes = ['IRA_ROLLOVER_WITHDRAWAL_TAX'];
  }

  reduce(state, action) {
    const { amount, isAuResident } = action;
    this.accountService.transaction(usCash(state), amount, null);
    return this.newState(
      state,
      { iraAccount: debitIra(state.iraAccount, amount) },
      [{ type: 'IRA_ROLLOVER_WITHDRAWAL_TAX', amount, isAuResident }]
    );
  }
}

/**
 * EVT-40: IRA RMD — credit US cash pool, debit IRA (required at age 73+, SECURE 2.0).
 * No penalty.  Chains IRA_RMD_TAX (ordinary income).
 * Accepts optional action.stateKey to support multiple IRA accounts per person.
 */
export class IraRmdApplyReducer extends Reducer {
  static description = 'Credits the US cash pool and debits the IRA for the required minimum distribution; chains IRA_RMD_TAX.';
  static actionType  = 'IRA_RMD_APPLY';

  constructor({ accountService }) {
    super('IRA RMD Apply', PRIORITY.CASH_FLOW);
    this.accountService = accountService;
    this.reducedActionTypes   = ['IRA_RMD_APPLY'];
    this.generatedActionTypes = ['IRA_RMD_TAX'];
  }

  reduce(state, action) {
    const { amount, isAuResident } = action;
    const stateKey = action.stateKey ?? 'iraAccount';
    this.accountService.transaction(usCash(state), amount, null);
    return this.newState(
      state,
      { [stateKey]: debitIra(state[stateKey], amount) },
      [{ type: 'IRA_RMD_TAX', amount, isAuResident }]
    );
  }
}

// ─── Handlers ─────────────────────────────────────────────────────────────────

export class IraRolloverWithdrawalHandler extends HandlerEntry {
  static description = 'Dispatches IRA_ROLLOVER_WITHDRAWAL_APPLY — no penalty applied (rollover exemption).';
  static eventType   = 'IRA_ROLLOVER_WITHDRAWAL';

  constructor() {
    super(null, 'IRA Rollover Withdrawal');
    this.generatedActionTypes = ['IRA_ROLLOVER_WITHDRAWAL_APPLY', 'RECORD_FIELD_VALUE', 'RECORD_BALANCE'];
  }

  call({ state, data }) {
    const cashKey = state.usSavingsAccount != null ? 'usSavingsAccount' : 'checkingAccount';
    return [
      {
        type:         'IRA_ROLLOVER_WITHDRAWAL_APPLY',
        amount:       data.amount,
        isAuResident: state.isAuResident,
      },
      new FieldValueAction('ira_rollover_withdrawal', 'IRA Rollover Withdrawal', data.amount),
      new RecordBalanceAction(`${cashKey}.balance`, cashKey),
    ];
  }
}

export class IraRmdHandler extends HandlerEntry {
  static description = 'Dispatches IRA_RMD_APPLY for the required minimum distribution.';
  static eventType   = 'IRA_RMD';

  constructor() {
    super(null, 'IRA RMD');
    this.generatedActionTypes = ['IRA_RMD_APPLY', 'RECORD_FIELD_VALUE', 'RECORD_BALANCE'];
  }

  call({ state, data }) {
    const cashKey = state.usSavingsAccount != null ? 'usSavingsAccount' : 'checkingAccount';
    return [
      {
        type:         'IRA_RMD_APPLY',
        amount:       data.amount,
        isAuResident: state.isAuResident,
      },
      new FieldValueAction('ira_rmd', 'IRA RMD', data.amount),
      new RecordBalanceAction(`${cashKey}.balance`, cashKey),
    ];
  }
}

/**
 * Auto-scheduled annual IRA Required Minimum Distribution handler.
 *
 * Fires on the IRA_ANNUAL_RMD event (year-end) for a specific IRA account / owner.
 * Checks whether the associated person has reached RMD age (per the AccountRulesEngine),
 * calculates the distribution using the IRS Uniform Lifetime Table, and dispatches
 * IRA_RMD_APPLY.
 *
 * Rules per SECURE 2.0 Act:
 *   - First RMD: due by December 31 of the year the owner turns 73 (default simulation
 *     behaviour — no delay).  IRS allows delay to April 1 of the following year, but
 *     that results in two RMDs in a single tax year.
 *   TODO: Support delayFirstRmd=true (April 1 grace period) and the resulting two-RMD year.
 *
 * RMD amount = current IRA balance / Uniform Lifetime distribution period for owner's age.
 *   TODO: IRS basis is the prior December 31 balance; simplified here to use the balance
 *         at the time the event fires.
 *
 * Early withdrawal penalties do not apply to RMDs.
 *   TODO: Enforce failure-to-withdraw penalty (50% of shortfall) if the full RMD is
 *         not taken — not yet implemented.
 *
 * @param {object} opts
 * @param {import('../../../finance/services/state-registry.js').StateRegistry} opts.stateRegistry
 * @param {string}  opts.role              - ACCOUNT_ROLES.IRA
 * @param {string}  opts.ownerId           - Person id owning this IRA
 * @param {string}  [opts.stateKey]        - Explicit state key (falls back to registry lookup)
 * @param {import('../account-rules-engine.js').AccountRulesEngine} opts.accountRulesEngine
 */
export class IraAnnualRmdHandler extends HandlerEntry {
  static description = 'Auto-calculates and dispatches the annual IRA RMD for the account owner once they reach age 73.';
  static eventType   = 'IRA_ANNUAL_RMD';

  constructor({ stateRegistry, role, ownerId, stateKey, accountRulesEngine } = {}) {
    super(null, 'IRA Annual RMD');
    this.stateRegistry      = stateRegistry;
    this.role               = role;
    this.ownerId            = ownerId;
    this._stateKeyFixed     = stateKey ?? null;
    this.accountRulesEngine = accountRulesEngine ?? null;
    this.generatedActionTypes = ['IRA_RMD_APPLY', 'RECORD_FIELD_VALUE', 'RECORD_BALANCE'];
  }

  call({ date, state }) {
    const resolvedKey = this._stateKeyFixed ?? this.stateRegistry?.getStateKey(this.role, this.ownerId);
    const ira = state[resolvedKey];
    if (!ira || ira.balance <= 0) return [];

    const year   = date.getUTCFullYear();
    const rules  = this.accountRulesEngine?.get('US', year)?.getIraRmdRules?.();
    if (!rules) return [];

    const person = state.people?.[this.ownerId];
    if (!person?.birthDate) return [];

    const birthDate = person.birthDate instanceof Date ? person.birthDate : new Date(person.birthDate);
    const age = _getAge(birthDate, date);
    if (age < rules.rmdAge) return [];

    const distributionPeriod = getUniformDistributionPeriod(age);
    if (!distributionPeriod) return [];

    const rmdAmount = Math.round(ira.balance / distributionPeriod * 100) / 100;
    if (rmdAmount <= 0) return [];

    const cashKey  = state.usSavingsAccount != null ? 'usSavingsAccount' : 'checkingAccount';
    const label    = `${person.name ?? this.ownerId} IRA RMD`;
    return [
      { type: 'IRA_RMD_APPLY', amount: rmdAmount, stateKey: resolvedKey, isAuResident: state.isAuResident },
      new FieldValueAction(`ira_annual_rmd_${this.ownerId}`, label, rmdAmount),
      new RecordBalanceAction(`${cashKey}.balance`, cashKey),
      new RecordBalanceAction(`${resolvedKey}.balance`, resolvedKey),
    ];
  }
}

/** Returns whole years of age as of asOfDate. */
function _getAge(birthDate, asOfDate) {
  const years = asOfDate.getUTCFullYear() - birthDate.getUTCFullYear();
  const hadBirthday =
    asOfDate.getUTCMonth() > birthDate.getUTCMonth() ||
    (asOfDate.getUTCMonth() === birthDate.getUTCMonth() &&
      asOfDate.getUTCDate() >= birthDate.getUTCDate());
  return hadBirthday ? years : years - 1;
}
