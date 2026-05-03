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
import { RecordBalanceAction } from '../../../simulation-framework/actions.js';

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
export class K401ContributionApplyReducer extends Reducer {
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
export class K401EarningsApplyReducer extends Reducer {
  static description = 'Adds earnings to 401k balance and earningsBasis; no immediate tax (deferred to withdrawal).';
  static actionType  = 'K401_EARNINGS_APPLY';

  constructor({ accountService }) {  // accountService unused but accepted for API symmetry
    super('401k Earnings Apply', PRIORITY.CASH_FLOW);
    this.reducedActionTypes = ['K401_EARNINGS_APPLY'];
  }

  reduce(state, action) {
    const ka = state.k401Account;
    return this.newState(state, {
      k401Account: {
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
export class K401WithdrawalApplyReducer extends Reducer {
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
