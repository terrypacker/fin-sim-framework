/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { Reducer, PRIORITY, AccountServiceReducer } from '../../../simulation-framework/reducers.js';
import { HandlerEntry }       from '../../../simulation-framework/handlers.js';
import { FieldValueAction, RecordBalanceAction } from '../../../simulation-framework/actions.js';
import { getUniformDistributionPeriod } from './us-rmd-uniform-table.js';

/** Resolve the US cash pool. */
const usCash = (state) => state.usSavingsAccount ?? state.checkingAccount;

/** Returns age as a decimal (years + fractional months) for the 59.5 threshold. */
function getAgeDecimal(birthDate, asOfDate) {
  const msPerYear = 365.25 * 24 * 60 * 60 * 1000;
  return (asOfDate - birthDate) / msPerYear;
}

// ─── Reducers ─────────────────────────────────────────────────────────────────

/**
 * EVT-24: 401k contribution — debit US cash pool, credit contributionBasis.
 * Chains K401_CONTRIBUTION_TAX (US negative income / pre-tax deduction).
 */
export class K401ContributionApplyReducer extends AccountServiceReducer {
  static type        = 'K401ContributionApplyReducer';
  static description = 'Debits the US cash pool and credits 401k contributionBasis; chains K401_CONTRIBUTION_TAX.';
  static actionType  = 'K401_CONTRIBUTION_APPLY';

  constructor({ accountService }) {
    super('401k Contribution Apply', PRIORITY.CASH_FLOW);
    this.accountService = accountService;
    this.reducedActionTypes   = ['K401_CONTRIBUTION_APPLY'];
    this.generatedActionTypes = ['K401_CONTRIBUTION_TAX'];
  }

  reduce(state, action) {
    this.accountService.transaction(usCash(state), -action.amount, null);
    const ka = state.k401Account;
    return this.newState(
      state,
      {
        k401Account: {
          ...ka,
          balance:           ka.balance           + action.amount,
          contributionBasis: ka.contributionBasis + action.amount,
        },
      },
      [{ type: 'K401_CONTRIBUTION_TAX', amount: action.amount }]
    );
  }
}

/**
 * EVT-25 (accrual): 401k earnings — stay in account, tax deferred to withdrawal.
 */
export class K401EarningsApplyReducer extends AccountServiceReducer {
  static type        = 'K401EarningsApplyReducer';
  static description = 'Adds earnings to 401k balance and earningsBasis; no immediate tax (deferred to withdrawal).';
  static actionType  = 'K401_EARNINGS_APPLY';

  constructor({ accountService }) {  // accountService unused but accepted for API symmetry
    super('401k Earnings Apply', PRIORITY.CASH_FLOW);
    this.reducedActionTypes = ['K401_EARNINGS_APPLY'];
  }

  reduce(state, action) {
    const key = action.stateKey ?? 'k401Account';
    const ka = state[key];
    return this.newState(state, {
      [key]: {
        ...ka,
        balance:       ka.balance       + action.amount,
        earningsBasis: ka.earningsBasis + action.amount,
      },
    });
  }
}

/**
 * EVT-25 (withdrawal): credit US cash pool net of penalty, debit account.
 * Chains K401_WITHDRAWAL_TAX (US ordinary income + penalty).
 */
export class K401WithdrawalApplyReducer extends AccountServiceReducer {
  static type        = 'K401WithdrawalApplyReducer';
  static description = 'Credits the US cash pool net of penalty and debits the 401k account; chains K401_WITHDRAWAL_TAX.';
  static actionType  = 'K401_WITHDRAWAL_APPLY';

  constructor({ accountService }) {
    super('401k Withdrawal Apply', PRIORITY.CASH_FLOW);
    this.accountService = accountService;
    this.reducedActionTypes   = ['K401_WITHDRAWAL_APPLY'];
    this.generatedActionTypes = ['K401_WITHDRAWAL_TAX'];
  }

  reduce(state, action) {
    const { amount, penaltyAmount } = action;
    this.accountService.transaction(usCash(state), amount - penaltyAmount, null);
    const ka = state.k401Account;
    const fromEarnings = Math.min(amount, ka.earningsBasis);
    const fromContrib  = amount - fromEarnings;
    return this.newState(
      state,
      {
        k401Account: {
          ...ka,
          balance:           ka.balance           - amount,
          earningsBasis:     ka.earningsBasis     - fromEarnings,
          contributionBasis: ka.contributionBasis - fromContrib,
        },
      },
      [{ type: 'K401_WITHDRAWAL_TAX', amount, penaltyAmount }]
    );
  }
}

// ─── Handlers ─────────────────────────────────────────────────────────────────

export class K401ContributionHandler extends HandlerEntry {
  static type        = 'K401ContributionHandler';
  static description = 'Dispatches K401_CONTRIBUTION_APPLY.';
  static eventType   = 'K401_CONTRIBUTION';

  constructor() {
    super(null, '401k Contribution');
    this.generatedActionTypes = ['K401_CONTRIBUTION_APPLY', 'RECORD_BALANCE'];
  }

  call({ data }) {
    return [
      { type: 'K401_CONTRIBUTION_APPLY', amount: data.amount },
      new RecordBalanceAction('k401Account.balance', 'k401Account'),
    ];
  }
}

export class K401EarningsHandler extends HandlerEntry {
  static type        = 'K401EarningsHandler';
  static description = 'Dispatches K401_EARNINGS_APPLY.';
  static eventType   = 'K401_EARNINGS';

  constructor() {
    super(null, '401k Earnings');
    this.generatedActionTypes = ['K401_EARNINGS_APPLY', 'RECORD_BALANCE'];
  }

  call({ data }) {
    return [
      { type: 'K401_EARNINGS_APPLY', amount: data.amount },
      new RecordBalanceAction('k401Account.balance', 'k401Account'),
    ];
  }
}

export class K401WithdrawalHandler extends HandlerEntry {
  static type        = 'K401WithdrawalHandler';
  static description = 'Applies 10% penalty for under-59.5 withdrawals and dispatches K401_WITHDRAWAL_APPLY.';
  static eventType   = 'K401_WITHDRAWAL';

  constructor() {
    super(null, '401k Withdrawal');
    this.generatedActionTypes = ['K401_WITHDRAWAL_APPLY', 'RECORD_BALANCE'];
  }

  call({ date, state, data }) {
    const msPerYear = 365.25 * 24 * 60 * 60 * 1000;
    const age       = (date - state.personBirthDate) / msPerYear;
    const penalty   = age < 59.5 ? data.amount * 0.10 : 0;
    return [
      { type: 'K401_WITHDRAWAL_APPLY', amount: data.amount, penaltyAmount: penalty },
      new RecordBalanceAction('k401Account.balance', 'k401Account'),
    ];
  }
}

/**
 * EVT-40 (401k): 401(k) RMD — credit US cash pool, debit 401(k) (earnings-first basis
 * deduction; no penalty).  Chains K401_RMD_TAX (ordinary income).
 * Accepts optional action.stateKey to support multiple 401(k) accounts per person.
 */
export class K401RmdApplyReducer extends AccountServiceReducer {
  static type        = 'K401RmdApplyReducer';
  static description = 'Credits the US cash pool and debits the 401(k) for the required minimum distribution (no penalty); chains K401_RMD_TAX.';
  static actionType  = 'K401_RMD_APPLY';

  constructor({ accountService }) {
    super('401k RMD Apply', PRIORITY.CASH_FLOW);
    this.accountService = accountService;
    this.reducedActionTypes   = ['K401_RMD_APPLY'];
    this.generatedActionTypes = ['K401_RMD_TAX'];
  }

  reduce(state, action) {
    const { amount, isAuResident } = action;
    const stateKey    = action.stateKey ?? 'k401Account';
    const ka          = state[stateKey];
    const fromEarnings = Math.min(amount, ka.earningsBasis);
    const fromContrib  = amount - fromEarnings;
    this.accountService.transaction(usCash(state), amount, null);
    return this.newState(
      state,
      {
        [stateKey]: {
          ...ka,
          balance:           ka.balance           - amount,
          earningsBasis:     ka.earningsBasis     - fromEarnings,
          contributionBasis: ka.contributionBasis - fromContrib,
        },
      },
      [{ type: 'K401_RMD_TAX', amount, isAuResident }]
    );
  }
}

/**
 * Auto-scheduled annual 401(k) Required Minimum Distribution handler.
 *
 * Fires on the K401_ANNUAL_RMD event (year-end) for a specific 401(k) account / owner.
 * Applies the same SECURE 2.0 rules as IRA RMDs: starts at age 73, uses the IRS
 * Uniform Lifetime Table.
 *
 * TODO: Support delayFirstRmd=true (April 1 grace period) — same caveat as IRA RMDs.
 * TODO: IRS basis is the prior December 31 balance; simplified here to current balance.
 * TODO: Enforce failure-to-withdraw 50% penalty if RMD is not taken.
 *
 * @param {object} opts
 * @param {import('../../../finance/services/state-registry.js').StateRegistry} opts.stateRegistry
 * @param {string}  opts.role              - ACCOUNT_ROLES.K401
 * @param {string}  opts.ownerId           - Person id owning this 401(k)
 * @param {string}  [opts.stateKey]        - Explicit state key (falls back to registry lookup)
 * @param {import('../account-rules-engine.js').AccountRulesEngine} opts.accountRulesEngine
 */
export class K401AnnualRmdHandler extends HandlerEntry {
  static type        = 'K401AnnualRmdHandler';
  static description = 'Auto-calculates and dispatches the annual 401(k) RMD for the account owner once they reach age 73.';
  static eventType   = 'K401_ANNUAL_RMD';

  constructor({ stateRegistry, role, ownerId, stateKey, accountRulesEngine } = {}) {
    super(null, '401k Annual RMD');
    this.stateRegistry      = stateRegistry;
    this.role               = role;
    this.ownerId            = ownerId;
    this._stateKeyFixed     = stateKey ?? null;
    this.accountRulesEngine = accountRulesEngine ?? null;
    this.generatedActionTypes = ['K401_RMD_APPLY', 'RECORD_FIELD_VALUE', 'RECORD_BALANCE'];
  }

  call({ date, state }) {
    const resolvedKey = this._stateKeyFixed ?? this.stateRegistry?.getStateKey(this.role, this.ownerId);
    const k401 = state[resolvedKey];
    if (!k401 || k401.balance <= 0) return [];

    const year  = date.getUTCFullYear();
    const rules = this.accountRulesEngine?.get('US', year)?.getIraRmdRules?.();
    if (!rules) return [];

    const person = state.people?.[this.ownerId];
    if (!person?.birthDate) return [];

    const birthDate = person.birthDate instanceof Date ? person.birthDate : new Date(person.birthDate);
    const age = _getAge(birthDate, date);
    if (age < rules.rmdAge) return [];

    const distributionPeriod = getUniformDistributionPeriod(age);
    if (!distributionPeriod) return [];

    const rmdAmount = Math.round(k401.balance / distributionPeriod * 100) / 100;
    if (rmdAmount <= 0) return [];

    const cashKey = state.usSavingsAccount != null ? 'usSavingsAccount' : 'checkingAccount';
    const label   = `${person.name ?? this.ownerId} 401(k) RMD`;
    return [
      { type: 'K401_RMD_APPLY', amount: rmdAmount, stateKey: resolvedKey, isAuResident: state.isAuResident },
      new FieldValueAction(`k401_annual_rmd_${this.ownerId}`, label, rmdAmount),
      new RecordBalanceAction(`${cashKey}.balance`, cashKey),
      new RecordBalanceAction(`${resolvedKey}.balance`, resolvedKey),
    ];
  }
}

/**
 * EVT-53: 401(k) → IRA Conversion (rollover) — direct pre-tax transfer.
 *
 * No cash pool movement, no tax: both accounts are pre-tax, so a rollover from
 * a Traditional 401(k) into a Traditional IRA preserves basis types and creates
 * no taxable event.  The full amount is moved from the 401(k) (drawing from
 * contributionBasis first, then earningsBasis) into the destination IRA,
 * preserving the same basis split on the IRA side.
 *
 * Accepts:
 *   - action.amount     (optional) — if omitted, converts the full 401(k) balance
 *   - action.k401Key    — source 401(k) state key
 *   - action.iraKey     — destination IRA state key
 */
export class K401ToIraConversionApplyReducer extends AccountServiceReducer {
  static type        = 'K401ToIraConversionApplyReducer';
  static description = 'Debits the 401(k) and credits a Traditional IRA, preserving contribution/earnings basis; no cash pool, no tax.';
  static actionType  = 'K401_TO_IRA_CONVERSION_APPLY';

  constructor({ accountService } = {}) { // accountService unused — no cash pool movement
    super('401k→IRA Conversion Apply', PRIORITY.CASH_FLOW);
    this.reducedActionTypes = ['K401_TO_IRA_CONVERSION_APPLY'];
  }

  reduce(state, action) {
    const { amount, k401Key, iraKey } = action;
    const k401 = state[k401Key];
    const ira  = state[iraKey];

    const fromContrib  = Math.min(amount, k401.contributionBasis);
    const fromEarnings = Math.min(amount - fromContrib, k401.earningsBasis);

    return this.newState(state, {
      [k401Key]: {
        ...k401,
        balance:           k401.balance           - amount,
        contributionBasis: k401.contributionBasis - fromContrib,
        earningsBasis:     k401.earningsBasis     - fromEarnings,
      },
      [iraKey]: {
        ...ira,
        balance:           ira.balance           + amount,
        contributionBasis: ira.contributionBasis + fromContrib,
        earningsBasis:     ira.earningsBasis     + fromEarnings,
      },
    });
  }
}

/**
 * EVT-53: 401(k) → IRA Conversion handler.  Validates the source 401(k) has
 * the requested funds, then dispatches K401_TO_IRA_CONVERSION_APPLY.  If
 * data.amount is omitted, converts the entire 401(k) balance.
 */
export class K401ToIraConversionHandler extends HandlerEntry {
  static type        = 'K401ToIraConversionHandler';
  static description = 'Validates 401(k) balance and dispatches K401_TO_IRA_CONVERSION_APPLY (no tax).';
  static eventType   = 'K401_TO_IRA_CONVERSION';

  constructor() {
    super(null, '401k→IRA Conversion');
    this.generatedActionTypes = ['K401_TO_IRA_CONVERSION_APPLY', 'RECORD_FIELD_VALUE', 'RECORD_BALANCE'];
  }

  call({ state, data }) {
    const k401Key = data.k401Key ?? 'k401Account';
    const iraKey  = data.iraKey  ?? 'iraAccount';
    const k401 = state[k401Key];
    const ira  = state[iraKey];
    if (!k401) throw new Error(`K401ToIraConversion: missing source ${k401Key}`);
    if (!ira)  throw new Error(`K401ToIraConversion: missing destination ${iraKey}`);

    const amount = data.amount ?? k401.balance;
    if (amount <= 0) return [];
    if (amount > k401.balance) {
      throw new Error(`K401ToIraConversion: requested ${amount} exceeds ${k401Key} balance ${k401.balance}`);
    }

    return [
      { type: 'K401_TO_IRA_CONVERSION_APPLY', amount, k401Key, iraKey },
      new FieldValueAction('k401_to_ira_conversion', '401(k)→IRA Conversion', amount),
      new RecordBalanceAction(`${k401Key}.balance`, k401Key),
      new RecordBalanceAction(`${iraKey}.balance`,  iraKey),
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
