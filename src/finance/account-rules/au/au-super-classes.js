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
import { RecordBalanceAction } from '../../../simulation-framework/actions.js';
import { getBirthDate } from '../../residency-utils.js';

/** Resolve the AU cash pool. */
const auCash = (state) => state.auSavingsAccount ?? state.checkingAccount;

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
 * EVT-20: Super contribution — debit AU cash pool, credit contributionBasis.
 * Chains SUPER_CONTRIBUTION_TAX (AU super tax at 15%).
 */
export class SuperContributionApplyReducer extends AccountServiceReducer {
  static type        = 'SuperContributionApplyReducer';
  static description = 'Debits the AU cash pool and credits superAccount contributionBasis; chains SUPER_CONTRIBUTION_TAX.';
  static actionType  = 'SUPER_CONTRIBUTION_APPLY';

  constructor({ accountService }) {
    super('Super Contribution Apply', PRIORITY.CASH_FLOW);
    this.accountService = accountService;
    this.reducedActionTypes   = ['SUPER_CONTRIBUTION_APPLY'];
    this.generatedActionTypes = ['SUPER_CONTRIBUTION_TAX'];
  }

  reduce(state, action) {
    this.accountService.transaction(auCash(state), -action.amount, null);
    const sa = state.superAccount;
    return this.newState(
      state,
      {
        superAccount: {
          ...sa,
          balance:           sa.balance           + action.amount,
          contributionBasis: sa.contributionBasis + action.amount,
        },
      },
      [{ type: 'SUPER_CONTRIBUTION_TAX', amount: action.amount }]
    );
  }
}

/**
 * EVT-21: Super contribution withdrawal — age-gated (blocked before 60).
 * No tax on successful withdrawal.
 */
export class SuperWithdrawalContribApplyReducer extends AccountServiceReducer {
  static type        = 'SuperWithdrawalContribApplyReducer';
  static description = 'Credits the AU cash pool and debits superAccount contributionBasis; blocks withdrawal if person is under 60.';
  static actionType  = 'SUPER_WITHDRAWAL_CONTRIB_APPLY';

  constructor({ accountService }) {
    super('Super Contribution Withdrawal Apply', PRIORITY.CASH_FLOW);
    this.accountService = accountService;
    this.reducedActionTypes = ['SUPER_WITHDRAWAL_CONTRIB_APPLY'];
  }

  reduce(state, action) {
    const { amount, blocked } = action;
    if (blocked) {
      return this.newState(state, { superWithdrawalBlocked: true });
    }
    this.accountService.transaction(auCash(state), amount, null);
    const sa = state.superAccount;
    return this.newState(state, {
      superWithdrawalBlocked: false,
      superAccount: {
        ...sa,
        balance:           sa.balance           - amount,
        contributionBasis: sa.contributionBasis - amount,
      },
    });
  }
}

/**
 * EVT-22: Super earnings withdrawal — age-gated.
 * Chains SUPER_WITHDRAWAL_EARNINGS_TAX (US ordinary income).
 */
export class SuperWithdrawalEarningsApplyReducer extends AccountServiceReducer {
  static type        = 'SuperWithdrawalEarningsApplyReducer';
  static description = 'Credits the AU cash pool and debits superAccount earningsBasis; chains SUPER_WITHDRAWAL_EARNINGS_TAX; blocks if under 60.';
  static actionType  = 'SUPER_WITHDRAWAL_EARNINGS_APPLY';

  constructor({ accountService }) {
    super('Super Withdrawal Earnings Apply', PRIORITY.CASH_FLOW);
    this.accountService = accountService;
    this.reducedActionTypes   = ['SUPER_WITHDRAWAL_EARNINGS_APPLY'];
    this.generatedActionTypes = ['SUPER_WITHDRAWAL_EARNINGS_TAX'];
  }

  reduce(state, action) {
    const { amount, blocked } = action;
    if (blocked) {
      return this.newState(state, { superWithdrawalBlocked: true });
    }
    this.accountService.transaction(auCash(state), amount, null);
    const sa = state.superAccount;
    return this.newState(
      state,
      {
        superWithdrawalBlocked: false,
        superAccount: {
          ...sa,
          balance:       sa.balance       - amount,
          earningsBasis: sa.earningsBasis - amount,
        },
      },
      [{ type: 'SUPER_WITHDRAWAL_EARNINGS_TAX', amount }]
    );
  }
}

/**
 * EVT-23: Super earnings accrual — stay in account.
 * Chains SUPER_EARNINGS_TAX (AU super tax at 15%).
 */
export class SuperEarningsApplyReducer extends AccountServiceReducer {
  static type        = 'SuperEarningsApplyReducer';
  static description = 'Adds earnings to superAccount balance and earningsBasis; chains SUPER_EARNINGS_TAX.';
  static actionType  = 'SUPER_EARNINGS_APPLY';

  constructor({ accountService }) {  // accountService unused but accepted for API symmetry
    super('Super Earnings Apply', PRIORITY.CASH_FLOW);
    this.reducedActionTypes   = ['SUPER_EARNINGS_APPLY'];
    this.generatedActionTypes = ['SUPER_EARNINGS_TAX'];
  }

  reduce(state, action) {
    const key = action.stateKey ?? 'superAccount';
    const sa = state[key];
    return this.newState(
      state,
      {
        [key]: {
          ...sa,
          balance:       sa.balance       + action.amount,
          earningsBasis: sa.earningsBasis + action.amount,
        },
      },
      [{ type: 'SUPER_EARNINGS_TAX', amount: action.amount, stateKey: key }]
    );
  }
}

// ─── Handlers ─────────────────────────────────────────────────────────────────

export class SuperContributionHandler extends HandlerEntry {
  static type        = 'SuperContributionHandler';
  static description = 'Dispatches SUPER_CONTRIBUTION_APPLY.';
  static eventType   = 'SUPER_CONTRIBUTION';

  constructor() {
    super(null, 'Super Contribution');
    this.generatedActionTypes = ['SUPER_CONTRIBUTION_APPLY', 'RECORD_BALANCE'];
  }

  call({ data }) {
    return [
      { type: 'SUPER_CONTRIBUTION_APPLY', amount: data.amount },
      new RecordBalanceAction('superAccount.balance', 'superAccount'),
    ];
  }
}

export class SuperWithdrawalContributionsHandler extends HandlerEntry {
  static type        = 'SuperWithdrawalContributionsHandler';
  static description = 'Age-gates the request (blocks under 60) and dispatches SUPER_WITHDRAWAL_CONTRIB_APPLY.';
  static eventType   = 'SUPER_WITHDRAWAL_CONTRIBUTIONS';

  constructor({ ownerId = null } = {}) {
    super(null, 'Super Withdrawal Contributions');
    this.ownerId = ownerId;
    this.generatedActionTypes = ['SUPER_WITHDRAWAL_CONTRIB_APPLY', 'RECORD_BALANCE'];
  }

  call({ date, state, data }) {
    const personKey = this.ownerId ?? Object.keys(state.people ?? {})[0];
    const birthDate = getBirthDate(state, personKey);
    const age     = birthDate ? getAge(birthDate, date) : 0;
    const blocked = age < 60;
    return [
      { type: 'SUPER_WITHDRAWAL_CONTRIB_APPLY', amount: data.amount, blocked },
      new RecordBalanceAction('superAccount.balance', 'superAccount'),
    ];
  }
}

export class SuperWithdrawalEarningsHandler extends HandlerEntry {
  static type        = 'SuperWithdrawalEarningsHandler';
  static description = 'Age-gates the request (blocks under 60) and dispatches SUPER_WITHDRAWAL_EARNINGS_APPLY.';
  static eventType   = 'SUPER_WITHDRAWAL_EARNINGS';

  constructor({ ownerId = null } = {}) {
    super(null, 'Super Withdrawal Earnings');
    this.ownerId = ownerId;
    this.generatedActionTypes = ['SUPER_WITHDRAWAL_EARNINGS_APPLY', 'RECORD_BALANCE'];
  }

  call({ date, state, data }) {
    const personKey = this.ownerId ?? Object.keys(state.people ?? {})[0];
    const birthDate = getBirthDate(state, personKey);
    const age     = birthDate ? getAge(birthDate, date) : 0;
    const blocked = age < 60;
    return [
      { type: 'SUPER_WITHDRAWAL_EARNINGS_APPLY', amount: data.amount, blocked },
      new RecordBalanceAction('superAccount.balance', 'superAccount'),
    ];
  }
}

export class SuperEarningsDirectHandler extends HandlerEntry {
  static type        = 'SuperEarningsDirectHandler';
  static description = 'Dispatches SUPER_EARNINGS_APPLY from a direct SUPER_EARNINGS event (as opposed to the scheduled INTL_SUPER_EARNINGS path).';
  static eventType   = 'SUPER_EARNINGS';

  constructor() {
    super(null, 'Super Earnings');
    this.generatedActionTypes = ['SUPER_EARNINGS_APPLY', 'RECORD_BALANCE'];
  }

  call({ data }) {
    return [
      { type: 'SUPER_EARNINGS_APPLY', amount: data.amount },
      new RecordBalanceAction('superAccount.balance', 'superAccount'),
    ];
  }
}
