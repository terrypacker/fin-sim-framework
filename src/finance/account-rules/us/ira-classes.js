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

/** Resolve the US cash pool. */
const usCash = (state) => state.usSavingsAccount ?? state.checkingAccount;

/** Returns age in whole years as of asOfDate. */
function getAge(birthDate, asOfDate) {
  const years = asOfDate.getUTCFullYear() - birthDate.getUTCFullYear();
  const hadBirthday =
    asOfDate.getUTCMonth() > birthDate.getUTCMonth() ||
    (asOfDate.getUTCMonth() === birthDate.getUTCMonth() &&
     asOfDate.getUTCDate() >= birthDate.getUTCDate());
  return hadBirthday ? years : years - 1;
}

// ─── Reducers ─────────────────────────────────────────────────────────────────

/**
 * EVT-5: IRA contribution — debit US cash pool, credit contributionBasis.
 * Chains IRA_CONTRIBUTION_TAX (US negative income / pre-tax deduction).
 */
export class IraContributionApplyReducer extends Reducer {
  static description = 'Debits the US cash pool and credits IRA contributionBasis; chains IRA_CONTRIBUTION_TAX.';
  static actionType  = 'IRA_CONTRIBUTION_APPLY';

  constructor({ accountService }) {
    super('IRA Contribution Apply', PRIORITY.CASH_FLOW);
    this.accountService = accountService;
    this.reducedActionTypes   = ['IRA_CONTRIBUTION_APPLY'];
    this.generatedActionTypes = ['IRA_CONTRIBUTION_TAX'];
  }

  reduce(state, action) {
    this.accountService.transaction(usCash(state), -action.amount, null);
    const ia = state.iraAccount;
    return this.newState(
      state,
      {
        iraAccount: {
          ...ia,
          balance:           ia.balance           + action.amount,
          contributionBasis: ia.contributionBasis + action.amount,
        },
      },
      [{ type: 'IRA_CONTRIBUTION_TAX', amount: action.amount }]
    );
  }
}

/**
 * EVT-6: IRA contribution withdrawal — credit US cash pool net of penalty,
 * debit contributionBasis.  Chains IRA_WITHDRAWAL_CONTRIB_TAX.
 */
export class IraWithdrawalContribApplyReducer extends Reducer {
  static description = 'Credits the US cash pool net of penalty and debits IRA contributionBasis; chains IRA_WITHDRAWAL_CONTRIB_TAX.';
  static actionType  = 'IRA_WITHDRAWAL_CONTRIB_APPLY';

  constructor({ accountService }) {
    super('IRA Contribution Withdrawal Apply', PRIORITY.CASH_FLOW);
    this.accountService = accountService;
    this.reducedActionTypes   = ['IRA_WITHDRAWAL_CONTRIB_APPLY'];
    this.generatedActionTypes = ['IRA_WITHDRAWAL_CONTRIB_TAX'];
  }

  reduce(state, action) {
    const { amount, penaltyAmount } = action;
    this.accountService.transaction(usCash(state), amount - penaltyAmount, null);
    const ia = state.iraAccount;
    return this.newState(
      state,
      {
        iraAccount: {
          ...ia,
          balance:           ia.balance           - amount,
          contributionBasis: ia.contributionBasis - amount,
        },
      },
      [{ type: 'IRA_WITHDRAWAL_CONTRIB_TAX', amount, penaltyAmount }]
    );
  }
}

/**
 * EVT-7: IRA earnings withdrawal — credit US cash pool net of penalty,
 * debit earningsBasis.  Chains IRA_WITHDRAWAL_EARNINGS_TAX.
 */
export class IraWithdrawalEarningsApplyReducer extends Reducer {
  static description = 'Credits the US cash pool net of penalty and debits IRA earningsBasis; chains IRA_WITHDRAWAL_EARNINGS_TAX.';
  static actionType  = 'IRA_WITHDRAWAL_EARNINGS_APPLY';

  constructor({ accountService }) {
    super('IRA Withdrawal Earnings Apply', PRIORITY.CASH_FLOW);
    this.accountService = accountService;
    this.reducedActionTypes   = ['IRA_WITHDRAWAL_EARNINGS_APPLY'];
    this.generatedActionTypes = ['IRA_WITHDRAWAL_EARNINGS_TAX'];
  }

  reduce(state, action) {
    const { amount, penaltyAmount, isAuResident } = action;
    this.accountService.transaction(usCash(state), amount - penaltyAmount, null);
    const ia = state.iraAccount;
    return this.newState(
      state,
      {
        iraAccount: {
          ...ia,
          balance:       ia.balance       - amount,
          earningsBasis: ia.earningsBasis - amount,
        },
      },
      [{ type: 'IRA_WITHDRAWAL_EARNINGS_TAX', amount, penaltyAmount, isAuResident }]
    );
  }
}

/**
 * EVT-8: IRA earnings accrual — stays in account, no tax.
 */
export class IraEarningsApplyReducer extends Reducer {
  static description = 'Adds earnings to IRA balance and earningsBasis; no tax effect.';
  static actionType  = 'IRA_EARNINGS_APPLY';

  constructor({ accountService }) {  // accountService unused but accepted for API symmetry
    super('IRA Earnings Apply', PRIORITY.CASH_FLOW);
    this.reducedActionTypes = ['IRA_EARNINGS_APPLY'];
  }

  reduce(state, action) {
    const key = action.stateKey ?? 'iraAccount';
    const ia = state[key];
    return this.newState(state, {
      [key]: {
        ...ia,
        balance:       ia.balance       + action.amount,
        earningsBasis: ia.earningsBasis + action.amount,
      },
    });
  }
}

// ─── Handlers ─────────────────────────────────────────────────────────────────

export class IraContributionHandler extends HandlerEntry {
  static description = 'Dispatches IRA_CONTRIBUTION_APPLY and records the contribution metric.';
  static eventType   = 'IRA_CONTRIBUTION';

  constructor() {
    super(null, 'IRA Contribution');
    this.generatedActionTypes = ['IRA_CONTRIBUTION_APPLY', 'RECORD_FIELD_VALUE', 'RECORD_BALANCE'];
  }

  call({ data }) {
    return [
      { type: 'IRA_CONTRIBUTION_APPLY', amount: data.amount },
      new FieldValueAction('ira_contribution', 'IRA Contribution', data.amount),
      new RecordBalanceAction('iraAccount.balance', 'iraAccount'),
    ];
  }
}

export class IraWithdrawalContributionsHandler extends HandlerEntry {
  static description = 'Applies 10% penalty for under-60 withdrawals and dispatches IRA_WITHDRAWAL_CONTRIB_APPLY.';
  static eventType   = 'IRA_WITHDRAWAL_CONTRIBUTIONS';

  constructor() {
    super(null, 'IRA Withdrawal Contributions');
    this.generatedActionTypes = ['IRA_WITHDRAWAL_CONTRIB_APPLY', 'RECORD_FIELD_VALUE', 'RECORD_BALANCE'];
  }

  call({ date, state, data }) {
    const age     = getAge(state.personBirthDate, date);
    const penalty = age < 60 ? data.amount * 0.10 : 0;
    return [
      { type: 'IRA_WITHDRAWAL_CONTRIB_APPLY', amount: data.amount, penaltyAmount: penalty },
      new FieldValueAction('ira_withdrawal_contributions', 'IRA Withdrawal', data.amount),
      new RecordBalanceAction('iraAccount.balance', 'iraAccount'),
    ];
  }
}

export class IraWithdrawalEarningsHandler extends HandlerEntry {
  static description = 'Applies 10% penalty for under-60 withdrawals and dispatches IRA_WITHDRAWAL_EARNINGS_APPLY.';
  static eventType   = 'IRA_WITHDRAWAL_EARNINGS';

  constructor() {
    super(null, 'IRA Withdrawal Earnings');
    this.generatedActionTypes = ['IRA_WITHDRAWAL_EARNINGS_APPLY', 'RECORD_FIELD_VALUE', 'RECORD_BALANCE'];
  }

  call({ date, state, data }) {
    const age     = getAge(state.personBirthDate, date);
    const penalty = age < 60 ? data.amount * 0.10 : 0;
    return [
      {
        type: 'IRA_WITHDRAWAL_EARNINGS_APPLY',
        amount:        data.amount,
        penaltyAmount: penalty,
        isAuResident:  state.isAuResident,
      },
      new FieldValueAction('ira_withdrawal_earnings', 'IRA Withdrawal Earnings', data.amount),
      new RecordBalanceAction('iraAccount.balance', 'iraAccount'),
    ];
  }
}

export class IraEarningsHandler extends HandlerEntry {
  static description = 'Dispatches IRA_EARNINGS_APPLY and records the earnings metric.';
  static eventType   = 'IRA_EARNINGS';

  constructor() {
    super(null, 'IRA Earnings');
    this.generatedActionTypes = ['IRA_EARNINGS_APPLY', 'RECORD_FIELD_VALUE', 'RECORD_BALANCE'];
  }

  call({ data }) {
    return [
      { type: 'IRA_EARNINGS_APPLY', amount: data.amount },
      new FieldValueAction('ira_earnings', 'IRA Earnings', data.amount),
      new RecordBalanceAction('iraAccount.balance', 'iraAccount'),
    ];
  }
}
