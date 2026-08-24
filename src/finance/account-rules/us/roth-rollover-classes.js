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
import { scaleHoldings, lotVintage } from '../../holdings/holding-utils.js';
import { resolveCashKey } from '../cash-routing.js';
import { computeConversionRecapture, PENALTY_RATE, AGE_THRESHOLD } from './roth-conversion-lots.js';

/** Resolve the US cash pool (legacy tail; prefer resolveCashKey for routing). */
const usCash = (state) => state.usSavingsAccount ?? state.checkingAccount;

/** Age as a decimal (years + fractional months) for the 59.5 threshold. */
function getAgeDecimal(birthDate, asOfDate) {
  const msPerYear = 365.25 * 24 * 60 * 60 * 1000;
  return (asOfDate - birthDate) / msPerYear;
}

/** Resolve the as-of person's decimal age, or 0 when no birth date is known. */
function ownerAgeDecimal(state, date) {
  const personKey = Object.keys(state.people ?? {})[0];
  const birthDate = getBirthDate(state, personKey);
  return birthDate ? getAgeDecimal(birthDate, date) : 0;
}

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

  constructor({ accountService, stateRegistry }) {
    super('Roth Rollover Contribution Apply', PRIORITY.CASH_FLOW);
    this.accountService = accountService;
    this.stateRegistry  = stateRegistry;
    this.reducedActionTypes = ['ROTH_ROLLOVER_CONTRIBUTION_APPLY'];
  }

  reduce(state, action) {
    this.accountService.transaction(state[resolveCashKey(this.stateRegistry, 'US', state)], -action.amount, null);
    const ra         = state.rothAccount;
    const newBalance = ra.balance + action.amount;
    return this.newState(state, {
      rothAccount: {
        ...ra,
        balance:              newBalance,
        rolloverContribBasis: (ra.rolloverContribBasis ?? 0) + action.amount,
        holdings:             scaleHoldings(ra.holdings, ra.balance, newBalance, lotVintage(state, ra)),
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

  constructor({ accountService, stateRegistry }) {  // accountService unused but accepted for API symmetry
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
 * EVT-43: Roth Rollover Withdrawal – Contributions — credit US cash pool (net of
 * any §408A(d)(3)(F) recapture penalty), debit rolloverContribBasis, and consume
 * the FIFO conversion lots. No US income tax (US taxed the conversion at EVT-52).
 * Chains ROTH_ROLLOVER_WITHDRAWAL_CONTRIB_TAX when a recapture penalty applies or
 * the consumed principal carries an AU-assessable (IRA-earnings-sourced) portion.
 */
export class RothRolloverWithdrawalContribApplyReducer extends AccountServiceReducer {
  static type        = 'RothRolloverWithdrawalContribApplyReducer';
  static description = 'Credits the US cash pool net of any §408A(d)(3)(F) recapture penalty, debits rolloverContribBasis, consumes conversion lots; chains ROTH_ROLLOVER_WITHDRAWAL_CONTRIB_TAX for the penalty and/or the AU-assessable converted-earnings portion.';
  static actionType  = 'ROTH_ROLLOVER_WITHDRAWAL_CONTRIB_APPLY';

  constructor({ accountService, stateRegistry }) {
    super('Roth Rollover Withdrawal Contrib Apply', PRIORITY.CASH_FLOW);
    this.accountService = accountService;
    this.stateRegistry  = stateRegistry;
    this.reducedActionTypes   = ['ROTH_ROLLOVER_WITHDRAWAL_CONTRIB_APPLY'];
    this.generatedActionTypes = ['ROTH_ROLLOVER_WITHDRAWAL_CONTRIB_TAX'];
  }

  reduce(state, action) {
    const { amount, penaltyAmount = 0, auAssessableAmount = 0, residency, rolloverConversions } = action;
    this.accountService.transaction(state[resolveCashKey(this.stateRegistry, 'US', state)], amount - penaltyAmount, null);
    // Per-account (design 55 §7 / 76 Gap B): honor a handler-stamped stateKey so a
    // household with more than one of these accounts debits — and taxes — the right
    // person's. Falls back to the canonical key for legacy dispatchers and old saves.
    const key        = action.stateKey ?? 'rothAccount';
    const ra         = state[key];
    const newBalance = ra.balance - amount;
    const rothAccount = {
      ...ra,
      balance:              newBalance,
      rolloverContribBasis: (ra.rolloverContribBasis ?? 0) - amount,
      holdings:             scaleHoldings(ra.holdings, ra.balance, newBalance, lotVintage(state, ra)),
    };
    if (rolloverConversions !== undefined) rothAccount.rolloverConversions = rolloverConversions;
    const auAssessable = residency === 'AU' ? auAssessableAmount : 0;
    const next = (penaltyAmount > 0 || auAssessable > 0)
      ? [{ type: 'ROTH_ROLLOVER_WITHDRAWAL_CONTRIB_TAX', amount, penaltyAmount, auAssessableAmount, residency, stateKey: key }]
      : [];
    return this.newState(state, { [key]: rothAccount }, next);
  }
}

/**
 * EVT-44: Roth Rollover Withdrawal – Earnings — credit US cash pool (net of any
 * §72(t) early-distribution penalty), debit rolloverEarningsBasis. No US income
 * tax; chains ROTH_ROLLOVER_WITHDRAWAL_EARNINGS_TAX for the penalty and optional
 * AU ordinary income.
 */
export class RothRolloverWithdrawalEarningsApplyReducer extends AccountServiceReducer {
  static type        = 'RothRolloverWithdrawalEarningsApplyReducer';
  static description = 'Credits the US cash pool net of any §72(t) penalty and debits rothAccount.rolloverEarningsBasis; chains ROTH_ROLLOVER_WITHDRAWAL_EARNINGS_TAX.';
  static actionType  = 'ROTH_ROLLOVER_WITHDRAWAL_EARNINGS_APPLY';

  constructor({ accountService, stateRegistry }) {
    super('Roth Rollover Withdrawal Earnings Apply', PRIORITY.CASH_FLOW);
    this.accountService = accountService;
    this.stateRegistry  = stateRegistry;
    this.reducedActionTypes   = ['ROTH_ROLLOVER_WITHDRAWAL_EARNINGS_APPLY'];
    this.generatedActionTypes = ['ROTH_ROLLOVER_WITHDRAWAL_EARNINGS_TAX'];
  }

  reduce(state, action) {
    const { amount, penaltyAmount = 0, residency } = action;
    this.accountService.transaction(state[resolveCashKey(this.stateRegistry, 'US', state)], amount - penaltyAmount, null);
    // Per-account (design 55 §7 / 76 Gap B): honor a handler-stamped stateKey so a
    // household with more than one of these accounts debits — and taxes — the right
    // person's. Falls back to the canonical key for legacy dispatchers and old saves.
    const key        = action.stateKey ?? 'rothAccount';
    const ra         = state[key];
    const newBalance = ra.balance - amount;
    return this.newState(
      state,
      {
        [key]: {
          ...ra,
          balance:               newBalance,
          rolloverEarningsBasis: (ra.rolloverEarningsBasis ?? 0) - amount,
          holdings:              scaleHoldings(ra.holdings, ra.balance, newBalance, lotVintage(state, ra)),
        },
      },
      // Design 76 Gap B: stamp the account so the AU return attributes to its owner.
      [{ type: 'ROTH_ROLLOVER_WITHDRAWAL_EARNINGS_TAX', amount, penaltyAmount, residency, stateKey: key }]
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
  static description = 'Computes the §408A(d)(3)(F) 5-year recapture penalty from the FIFO conversion lots and dispatches ROTH_ROLLOVER_WITHDRAWAL_CONTRIB_APPLY.';
  static eventType   = 'ROTH_ROLLOVER_WITHDRAWAL_CONTRIBUTIONS';

  constructor() {
    super(null, 'Roth Rollover Withdrawal Contributions');
    this.generatedActionTypes = ['ROTH_ROLLOVER_WITHDRAWAL_CONTRIB_APPLY', 'RECORD_FIELD_VALUE', 'RECORD_BALANCE'];
  }

  call({ date, state, data }) {
    const personKey = Object.keys(state.people ?? {})[0];
    const age       = ownerAgeDecimal(state, date);
    const { penaltyAmount, auAssessableAmount, newLots } =
      computeConversionRecapture(state.rothAccount?.rolloverConversions, data.amount, date,
        { underAge: age < AGE_THRESHOLD });
    return [
      {
        type:               'ROTH_ROLLOVER_WITHDRAWAL_CONTRIB_APPLY',
        amount:             data.amount,
        penaltyAmount,
        auAssessableAmount,
        residency:          state.people?.[personKey]?.residency ?? null,
        rolloverConversions: newLots,
      },
      new FieldValueAction('roth_rollover_withdrawal_contributions', 'Roth Rollover Withdrawal', data.amount),
      new RecordBalanceAction('rothAccount.balance', 'rothAccount'),
    ];
  }
}

export class RothRolloverWithdrawalEarningsHandler extends HandlerEntry {
  static type        = 'RothRolloverWithdrawalEarningsHandler';
  static description = 'Applies the §72(t) 10% penalty for under-59½ withdrawals and dispatches ROTH_ROLLOVER_WITHDRAWAL_EARNINGS_APPLY with the AU residency flag; no US income tax.';
  static eventType   = 'ROTH_ROLLOVER_WITHDRAWAL_EARNINGS';

  constructor() {
    super(null, 'Roth Rollover Withdrawal Earnings');
    this.generatedActionTypes = ['ROTH_ROLLOVER_WITHDRAWAL_EARNINGS_APPLY', 'RECORD_FIELD_VALUE', 'RECORD_BALANCE'];
  }

  call({ date, state, data }) {
    const personKey = Object.keys(state.people ?? {})[0];
    const age       = ownerAgeDecimal(state, date);
    const penalty   = age < AGE_THRESHOLD ? data.amount * PENALTY_RATE : 0;
    return [
      {
        type:          'ROTH_ROLLOVER_WITHDRAWAL_EARNINGS_APPLY',
        amount:        data.amount,
        penaltyAmount: penalty,
        residency:     state.people?.[personKey]?.residency ?? null,
      },
      new FieldValueAction('roth_rollover_withdrawal_earnings', 'Roth Rollover Withdrawal Earnings', data.amount),
      new RecordBalanceAction('rothAccount.balance', 'rothAccount'),
    ];
  }
}
