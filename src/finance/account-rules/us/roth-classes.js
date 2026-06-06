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
import { getBirthDate } from '../../residency-utils.js';
import { scaleHoldings } from '../../holdings/holding-utils.js';

/** Resolve the US cash pool. */
const usCash = (state) => state.usSavingsAccount ?? state.checkingAccount;

/** Returns age as a decimal (years + fractional months) for the 59.5 threshold. */
function getAgeDecimal(birthDate, asOfDate) {
  const msPerYear = 365.25 * 24 * 60 * 60 * 1000;
  return (asOfDate - birthDate) / msPerYear;
}

// ─── Reducers ─────────────────────────────────────────────────────────────────

/**
 * EVT-1: Roth contribution — debit US cash pool, credit contributionBasis.
 * No tax effect.
 */
export class RothContributionApplyReducer extends AccountServiceReducer {
  static type        = 'RothContributionApplyReducer';
  static description = 'Debits the US cash pool and credits Roth contributionBasis; no tax effect.';
  static actionType  = 'ROTH_CONTRIBUTION_APPLY';

  constructor({ accountService }) {
    super('Roth Contribution Apply', PRIORITY.CASH_FLOW);
    this.accountService = accountService;
    this.reducedActionTypes = ['ROTH_CONTRIBUTION_APPLY'];
  }

  reduce(state, action) {
    this.accountService.transaction(usCash(state), -action.amount, null);
    const ra         = state.rothAccount;
    const newBalance = ra.balance + action.amount;
    return this.newState(state, {
      rothAccount: {
        ...ra,
        balance:           newBalance,
        contributionBasis: ra.contributionBasis + action.amount,
        holdings:          scaleHoldings(ra.holdings, ra.balance, newBalance),
      },
    });
  }
}

/**
 * EVT-2: Roth contribution withdrawal — credit US cash pool, debit contributionBasis.
 * No tax effect.
 */
export class RothWithdrawalContribApplyReducer extends AccountServiceReducer {
  static type        = 'RothWithdrawalContribApplyReducer';
  static description = 'Credits the US cash pool and debits Roth contributionBasis; no tax effect.';
  static actionType  = 'ROTH_WITHDRAWAL_CONTRIB_APPLY';

  constructor({ accountService }) {
    super('Roth Contribution Withdrawal Apply', PRIORITY.CASH_FLOW);
    this.accountService = accountService;
    this.reducedActionTypes = ['ROTH_WITHDRAWAL_CONTRIB_APPLY'];
  }

  reduce(state, action) {
    this.accountService.transaction(usCash(state), action.amount, null);
    const ra         = state.rothAccount;
    const newBalance = ra.balance - action.amount;
    return this.newState(state, {
      rothAccount: {
        ...ra,
        balance:           newBalance,
        contributionBasis: ra.contributionBasis - action.amount,
        holdings:          scaleHoldings(ra.holdings, ra.balance, newBalance),
      },
    });
  }
}

/**
 * EVT-3: Roth earnings withdrawal — credit US cash pool (net of penalty),
 * debit earningsBasis.  Chains ROTH_WITHDRAWAL_EARNINGS_TAX for penalty +
 * optional AU tax.
 */
export class RothWithdrawalEarningsApplyReducer extends AccountServiceReducer {
  static type        = 'RothWithdrawalEarningsApplyReducer';
  static description = 'Credits the US cash pool net of penalty and debits Roth earningsBasis; chains ROTH_WITHDRAWAL_EARNINGS_TAX.';
  static actionType  = 'ROTH_WITHDRAWAL_EARNINGS_APPLY';

  constructor({ accountService }) {
    super('Roth Withdrawal Earnings Apply', PRIORITY.CASH_FLOW);
    this.accountService = accountService;
    this.reducedActionTypes   = ['ROTH_WITHDRAWAL_EARNINGS_APPLY'];
    this.generatedActionTypes = ['ROTH_WITHDRAWAL_EARNINGS_TAX'];
  }

  reduce(state, action) {
    const { amount, penaltyAmount, residency } = action;
    this.accountService.transaction(usCash(state), amount - penaltyAmount, null);
    const ra         = state.rothAccount;
    const newBalance = ra.balance - amount;
    return this.newState(
      state,
      {
        rothAccount: {
          ...ra,
          balance:       newBalance,
          earningsBasis: ra.earningsBasis - amount,
          holdings:      scaleHoldings(ra.holdings, ra.balance, newBalance),
        },
      },
      [{ type: 'ROTH_WITHDRAWAL_EARNINGS_TAX', amount, penaltyAmount, residency }]
    );
  }
}

/**
 * EVT-4: Roth earnings accrual — stays in account, no tax.
 */
export class RothEarningsApplyReducer extends AccountServiceReducer {
  static type        = 'RothEarningsApplyReducer';
  static description = 'Adds earnings to Roth balance and earningsBasis; no tax effect.';
  static actionType  = 'ROTH_EARNINGS_APPLY';

  constructor({ accountService }) {  // accountService unused but accepted for API symmetry
    super('Roth Earnings Apply', PRIORITY.CASH_FLOW);
    this.reducedActionTypes = ['ROTH_EARNINGS_APPLY'];
  }

  reduce(state, action) {
    const key = action.stateKey ?? 'rothAccount';
    const ra = state[key];
    return this.newState(state, {
      [key]: {
        ...ra,
        balance:       ra.balance       + action.amount,
        earningsBasis: ra.earningsBasis + action.amount,
      },
    });
  }
}

// ─── Handlers ─────────────────────────────────────────────────────────────────

export class RothContributionHandler extends HandlerEntry {
  static type        = 'RothContributionHandler';
  static description = 'Dispatches ROTH_CONTRIBUTION_APPLY and records the contribution metric.';
  static eventType   = 'ROTH_CONTRIBUTION';

  constructor() {
    super(null, 'Roth Contribution');
    this.generatedActionTypes = ['ROTH_CONTRIBUTION_APPLY', 'RECORD_FIELD_VALUE', 'RECORD_BALANCE'];
  }

  call({ data, state }) {
    if (state?.contributionsSuspended) return [];
    return [
      { type: 'ROTH_CONTRIBUTION_APPLY', amount: data.amount },
      new FieldValueAction('roth_contribution', 'Roth Contribution', data.amount),
      new RecordBalanceAction('rothAccount.balance', 'rothAccount'),
    ];
  }
}

export class RothWithdrawalContributionsHandler extends HandlerEntry {
  static type        = 'RothWithdrawalContributionsHandler';
  static description = 'Dispatches ROTH_WITHDRAWAL_CONTRIB_APPLY and records the withdrawal metric.';
  static eventType   = 'ROTH_WITHDRAWAL_CONTRIBUTIONS';

  constructor() {
    super(null, 'Roth Withdrawal Contributions');
    this.generatedActionTypes = ['ROTH_WITHDRAWAL_CONTRIB_APPLY', 'RECORD_FIELD_VALUE', 'RECORD_BALANCE'];
  }

  call({ data }) {
    return [
      { type: 'ROTH_WITHDRAWAL_CONTRIB_APPLY', amount: data.amount },
      new FieldValueAction('roth_withdrawal_contributions', 'Roth Withdrawal', data.amount),
      new RecordBalanceAction('rothAccount.balance', 'rothAccount'),
    ];
  }
}

export class RothWithdrawalEarningsHandler extends HandlerEntry {
  static type        = 'RothWithdrawalEarningsHandler';
  static description = 'Applies 10% penalty for under-60 withdrawals and dispatches ROTH_WITHDRAWAL_EARNINGS_APPLY.';
  static eventType   = 'ROTH_WITHDRAWAL_EARNINGS';

  constructor({ ownerId = null } = {}) {
    super(null, 'Roth Withdrawal Earnings');
    this.ownerId = ownerId;
    this.generatedActionTypes = ['ROTH_WITHDRAWAL_EARNINGS_APPLY', 'RECORD_FIELD_VALUE', 'RECORD_BALANCE'];
  }

  static fromJSON(d, ctx) {
    const h = new this({ ownerId: d.ownerId ?? null });
    h.id = d.id;
    return h;
  }

  toJSON() {
    return { ...super.toJSON(), ownerId: this.ownerId };
  }

  call({ date, state, data }) {
    const personKey = this.ownerId ?? Object.keys(state.people ?? {})[0];
    const birthDate = getBirthDate(state, personKey);
    const age     = birthDate ? getAgeDecimal(birthDate, date) : 0;
    const penalty = age < 59.5 ? data.amount * 0.10 : 0;
    return [
      {
        type: 'ROTH_WITHDRAWAL_EARNINGS_APPLY',
        amount:        data.amount,
        penaltyAmount: penalty,
        residency:     state.people?.[personKey]?.residency ?? null,
      },
      new FieldValueAction('roth_withdrawal_earnings', 'Roth Withdrawal Earnings', data.amount),
      new RecordBalanceAction('rothAccount.balance', 'rothAccount'),
    ];
  }
}

export class RothEarningsHandler extends HandlerEntry {
  static type        = 'RothEarningsHandler';
  static description = 'Dispatches ROTH_EARNINGS_APPLY and records the earnings metric.';
  static eventType   = 'ROTH_EARNINGS';

  constructor() {
    super(null, 'Roth Earnings');
    this.generatedActionTypes = ['ROTH_EARNINGS_APPLY', 'RECORD_FIELD_VALUE', 'RECORD_BALANCE'];
  }

  call({ data }) {
    return [
      { type: 'ROTH_EARNINGS_APPLY', amount: data.amount },
      new FieldValueAction('roth_earnings', 'Roth Earnings', data.amount),
      new RecordBalanceAction('rothAccount.balance', 'rothAccount'),
    ];
  }
}
