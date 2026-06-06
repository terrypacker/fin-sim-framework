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
import { scaleHoldings } from '../../holdings/holding-utils.js';

/** Resolve the US cash pool. */
const usCash = (state) => state.usSavingsAccount ?? state.checkingAccount;

/**
 * Roth Rollover account — tracks amounts converted from a Traditional IRA separately
 * from regular Roth contributions.
 *
 * rothAccount fields added by this module:
 *   rolloverContribBasis   — principal rolled over from IRA (after income tax at conversion)
 *   rolloverEarningsBasis  — earnings accrued on the rollover principal inside the Roth
 *
 * Withdrawal rules (per spec):
 *   EVT-43  rollover contributions   → no US or AU tax
 *   EVT-44  rollover earnings        → no US tax, AU ordinary income if resident
 */

// ─── Reducers ─────────────────────────────────────────────────────────────────

/**
 * EVT-41: Roth Rollover Contribution — debit US cash pool, credit rolloverContribBasis.
 * No tax (income tax was paid at the IRA rollover step, EVT-35).
 */
export class RothRolloverContributionApplyReducer extends AccountServiceReducer {
  static type        = 'RothRolloverContributionApplyReducer';
  static description = 'Debits the US cash pool and credits rothAccount.rolloverContribBasis; no tax effect.';
  static actionType  = 'ROTH_ROLLOVER_CONTRIBUTION_APPLY';

  constructor({ accountService }) {
    super('Roth Rollover Contribution Apply', PRIORITY.CASH_FLOW);
    this.accountService = accountService;
    this.reducedActionTypes = ['ROTH_ROLLOVER_CONTRIBUTION_APPLY'];
  }

  reduce(state, action) {
    this.accountService.transaction(usCash(state), -action.amount, null);
    const ra         = state.rothAccount;
    const newBalance = ra.balance + action.amount;
    return this.newState(state, {
      rothAccount: {
        ...ra,
        balance:              newBalance,
        rolloverContribBasis: (ra.rolloverContribBasis ?? 0) + action.amount,
        holdings:             scaleHoldings(ra.holdings, ra.balance, newBalance),
      },
    });
  }
}

/**
 * EVT-42: Roth Rollover Earnings — stays in account, credits rolloverEarningsBasis.
 * No tax.
 */
export class RothRolloverEarningsApplyReducer extends AccountServiceReducer {
  static type        = 'RothRolloverEarningsApplyReducer';
  static description = 'Adds earnings to rothAccount.rolloverEarningsBasis; no tax effect.';
  static actionType  = 'ROTH_ROLLOVER_EARNINGS_APPLY';

  constructor({ accountService }) {  // accountService unused but accepted for API symmetry
    super('Roth Rollover Earnings Apply', PRIORITY.CASH_FLOW);
    this.reducedActionTypes = ['ROTH_ROLLOVER_EARNINGS_APPLY'];
  }

  reduce(state, action) {
    const ra = state.rothAccount;
    return this.newState(state, {
      rothAccount: {
        ...ra,
        balance:               ra.balance                           + action.amount,
        rolloverEarningsBasis: (ra.rolloverEarningsBasis ?? 0)     + action.amount,
      },
    });
  }
}

/**
 * EVT-43: Roth Rollover Withdrawal – Contributions — credit US cash pool,
 * debit rolloverContribBasis.  No tax.
 */
export class RothRolloverWithdrawalContribApplyReducer extends AccountServiceReducer {
  static type        = 'RothRolloverWithdrawalContribApplyReducer';
  static description = 'Credits the US cash pool and debits rothAccount.rolloverContribBasis; no tax effect.';
  static actionType  = 'ROTH_ROLLOVER_WITHDRAWAL_CONTRIB_APPLY';

  constructor({ accountService }) {
    super('Roth Rollover Withdrawal Contrib Apply', PRIORITY.CASH_FLOW);
    this.accountService = accountService;
    this.reducedActionTypes = ['ROTH_ROLLOVER_WITHDRAWAL_CONTRIB_APPLY'];
  }

  reduce(state, action) {
    this.accountService.transaction(usCash(state), action.amount, null);
    const ra         = state.rothAccount;
    const newBalance = ra.balance - action.amount;
    return this.newState(state, {
      rothAccount: {
        ...ra,
        balance:              newBalance,
        rolloverContribBasis: (ra.rolloverContribBasis ?? 0) - action.amount,
        holdings:             scaleHoldings(ra.holdings, ra.balance, newBalance),
      },
    });
  }
}

/**
 * EVT-44: Roth Rollover Withdrawal – Earnings — credit US cash pool,
 * debit rolloverEarningsBasis.  No US tax; chains ROTH_ROLLOVER_WITHDRAWAL_EARNINGS_TAX
 * for optional AU ordinary income.
 */
export class RothRolloverWithdrawalEarningsApplyReducer extends AccountServiceReducer {
  static type        = 'RothRolloverWithdrawalEarningsApplyReducer';
  static description = 'Credits the US cash pool and debits rothAccount.rolloverEarningsBasis; chains ROTH_ROLLOVER_WITHDRAWAL_EARNINGS_TAX.';
  static actionType  = 'ROTH_ROLLOVER_WITHDRAWAL_EARNINGS_APPLY';

  constructor({ accountService }) {
    super('Roth Rollover Withdrawal Earnings Apply', PRIORITY.CASH_FLOW);
    this.accountService = accountService;
    this.reducedActionTypes   = ['ROTH_ROLLOVER_WITHDRAWAL_EARNINGS_APPLY'];
    this.generatedActionTypes = ['ROTH_ROLLOVER_WITHDRAWAL_EARNINGS_TAX'];
  }

  reduce(state, action) {
    const { amount, residency } = action;
    this.accountService.transaction(usCash(state), amount, null);
    const ra         = state.rothAccount;
    const newBalance = ra.balance - amount;
    return this.newState(
      state,
      {
        rothAccount: {
          ...ra,
          balance:               newBalance,
          rolloverEarningsBasis: (ra.rolloverEarningsBasis ?? 0) - amount,
          holdings:              scaleHoldings(ra.holdings, ra.balance, newBalance),
        },
      },
      [{ type: 'ROTH_ROLLOVER_WITHDRAWAL_EARNINGS_TAX', amount, residency }]
    );
  }
}

// ─── Handlers ─────────────────────────────────────────────────────────────────

export class RothRolloverContributionHandler extends HandlerEntry {
  static type        = 'RothRolloverContributionHandler';
  static description = 'Dispatches ROTH_ROLLOVER_CONTRIBUTION_APPLY.';
  static eventType   = 'ROTH_ROLLOVER_CONTRIBUTION';

  constructor() {
    super(null, 'Roth Rollover Contribution');
    this.generatedActionTypes = ['ROTH_ROLLOVER_CONTRIBUTION_APPLY', 'RECORD_FIELD_VALUE', 'RECORD_BALANCE'];
  }

  call({ data, state }) {
    if (state?.contributionsSuspended) return [];
    return [
      { type: 'ROTH_ROLLOVER_CONTRIBUTION_APPLY', amount: data.amount },
      new FieldValueAction('roth_rollover_contribution', 'Roth Rollover Contribution', data.amount),
      new RecordBalanceAction('rothAccount.balance', 'rothAccount'),
    ];
  }
}

export class RothRolloverEarningsHandler extends HandlerEntry {
  static type        = 'RothRolloverEarningsHandler';
  static description = 'Dispatches ROTH_ROLLOVER_EARNINGS_APPLY.';
  static eventType   = 'ROTH_ROLLOVER_EARNINGS';

  constructor() {
    super(null, 'Roth Rollover Earnings');
    this.generatedActionTypes = ['ROTH_ROLLOVER_EARNINGS_APPLY', 'RECORD_FIELD_VALUE', 'RECORD_BALANCE'];
  }

  call({ data }) {
    return [
      { type: 'ROTH_ROLLOVER_EARNINGS_APPLY', amount: data.amount },
      new FieldValueAction('roth_rollover_earnings', 'Roth Rollover Earnings', data.amount),
      new RecordBalanceAction('rothAccount.balance', 'rothAccount'),
    ];
  }
}

export class RothRolloverWithdrawalContributionsHandler extends HandlerEntry {
  static type        = 'RothRolloverWithdrawalContributionsHandler';
  static description = 'Dispatches ROTH_ROLLOVER_WITHDRAWAL_CONTRIB_APPLY; no tax.';
  static eventType   = 'ROTH_ROLLOVER_WITHDRAWAL_CONTRIBUTIONS';

  constructor() {
    super(null, 'Roth Rollover Withdrawal Contributions');
    this.generatedActionTypes = ['ROTH_ROLLOVER_WITHDRAWAL_CONTRIB_APPLY', 'RECORD_FIELD_VALUE', 'RECORD_BALANCE'];
  }

  call({ data }) {
    return [
      { type: 'ROTH_ROLLOVER_WITHDRAWAL_CONTRIB_APPLY', amount: data.amount },
      new FieldValueAction('roth_rollover_withdrawal_contributions', 'Roth Rollover Withdrawal', data.amount),
      new RecordBalanceAction('rothAccount.balance', 'rothAccount'),
    ];
  }
}

export class RothRolloverWithdrawalEarningsHandler extends HandlerEntry {
  static type        = 'RothRolloverWithdrawalEarningsHandler';
  static description = 'Dispatches ROTH_ROLLOVER_WITHDRAWAL_EARNINGS_APPLY with AU residency flag; no US tax.';
  static eventType   = 'ROTH_ROLLOVER_WITHDRAWAL_EARNINGS';

  constructor() {
    super(null, 'Roth Rollover Withdrawal Earnings');
    this.generatedActionTypes = ['ROTH_ROLLOVER_WITHDRAWAL_EARNINGS_APPLY', 'RECORD_FIELD_VALUE', 'RECORD_BALANCE'];
  }

  call({ state, data }) {
    return [
      {
        type:         'ROTH_ROLLOVER_WITHDRAWAL_EARNINGS_APPLY',
        amount:       data.amount,
        residency: state.people?.[Object.keys(state.people ?? {})[0]]?.residency ?? null,
      },
      new FieldValueAction('roth_rollover_withdrawal_earnings', 'Roth Rollover Withdrawal Earnings', data.amount),
      new RecordBalanceAction('rothAccount.balance', 'rothAccount'),
    ];
  }
}
