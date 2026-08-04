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
import { resolveCashKey } from '../cash-routing.js';
import { debitLedgerForLoss, drawDerivedProRata } from '../../assets/investment-account.js';

/** Resolve the US cash pool (legacy tail; prefer resolveCashKey for routing). */
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
export class IraContributionApplyReducer extends AccountServiceReducer {
  static type        = 'IraContributionApplyReducer';
  static description = 'Debits the US cash pool and credits IRA contributionBasis; chains IRA_CONTRIBUTION_TAX.';
  static actionType  = 'IRA_CONTRIBUTION_APPLY';

  constructor({ accountService, stateRegistry }) {
    super('IRA Contribution Apply', PRIORITY.CASH_FLOW);
    this.accountService = accountService;
    this.stateRegistry  = stateRegistry;
    this.reducedActionTypes   = ['IRA_CONTRIBUTION_APPLY'];
    this.generatedActionTypes = ['IRA_CONTRIBUTION_TAX'];
  }

  reduce(state, action) {
    this.accountService.transaction(state[resolveCashKey(this.stateRegistry, 'US', state)], -action.amount, null);
    const ia         = state.iraAccount;
    const newBalance = ia.balance + action.amount;
    return this.newState(
      state,
      {
        iraAccount: {
          ...ia,
          balance:           newBalance,
          contributionBasis: ia.contributionBasis + action.amount,
          holdings:          scaleHoldings(ia.holdings, ia.balance, newBalance),
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
export class IraWithdrawalContribApplyReducer extends AccountServiceReducer {
  static type        = 'IraWithdrawalContribApplyReducer';
  static description = 'Credits the US cash pool net of penalty and debits IRA contributionBasis; chains IRA_WITHDRAWAL_CONTRIB_TAX.';
  static actionType  = 'IRA_WITHDRAWAL_CONTRIB_APPLY';

  constructor({ accountService, stateRegistry }) {
    super('IRA Contribution Withdrawal Apply', PRIORITY.CASH_FLOW);
    this.accountService = accountService;
    this.stateRegistry  = stateRegistry;
    this.reducedActionTypes   = ['IRA_WITHDRAWAL_CONTRIB_APPLY'];
    this.generatedActionTypes = ['IRA_WITHDRAWAL_CONTRIB_TAX'];
  }

  reduce(state, action) {
    const { amount, penaltyAmount } = action;
    this.accountService.transaction(state[resolveCashKey(this.stateRegistry, 'US', state)], amount - penaltyAmount, null);
    const ia         = state.iraAccount;
    const newBalance = ia.balance - amount;
    return this.newState(
      state,
      {
        iraAccount: {
          ...ia,
          balance:           newBalance,
          contributionBasis: ia.contributionBasis - amount,
          holdings:          scaleHoldings(ia.holdings, ia.balance, newBalance),
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
export class IraWithdrawalEarningsApplyReducer extends AccountServiceReducer {
  static type        = 'IraWithdrawalEarningsApplyReducer';
  static description = 'Credits the US cash pool net of penalty and debits IRA earningsBasis; chains IRA_WITHDRAWAL_EARNINGS_TAX.';
  static actionType  = 'IRA_WITHDRAWAL_EARNINGS_APPLY';

  constructor({ accountService, stateRegistry }) {
    super('IRA Withdrawal Earnings Apply', PRIORITY.CASH_FLOW);
    this.accountService = accountService;
    this.stateRegistry  = stateRegistry;
    this.reducedActionTypes   = ['IRA_WITHDRAWAL_EARNINGS_APPLY'];
    this.generatedActionTypes = ['IRA_WITHDRAWAL_EARNINGS_TAX'];
  }

  reduce(state, action) {
    const { amount, penaltyAmount, residency } = action;
    this.accountService.transaction(state[resolveCashKey(this.stateRegistry, 'US', state)], amount - penaltyAmount, null);
    // Per-account (design 55 §7 / 76 Gap B): honor a handler-stamped stateKey so a
    // household with more than one of these accounts debits — and taxes — the right
    // person's. Falls back to the canonical key for legacy dispatchers and old saves.
    const key        = action.stateKey ?? 'iraAccount';
    const ia         = state[key];
    const newBalance = ia.balance - amount;
    return this.newState(
      state,
      {
        [key]: {
          ...ia,
          balance:       newBalance,
          earningsBasis: ia.earningsBasis - amount,
          // Design 84 G2 — the derived pool leaves with the earnings, pro-rata.
          ...drawDerivedProRata(ia, amount),
          holdings:      scaleHoldings(ia.holdings, ia.balance, newBalance),
        },
      },
      // Design 76 Gap B: stamp the account so the AU return attributes to its owner.
      [{ type: 'IRA_WITHDRAWAL_EARNINGS_TAX', amount, penaltyAmount, residency, stateKey: key }]
    );
  }
}

/**
 * EVT-8: IRA earnings accrual — stays in account, no tax.
 */
export class IraEarningsApplyReducer extends AccountServiceReducer {
  static type        = 'IraEarningsApplyReducer';
  static description = 'Adds earnings to IRA balance and earningsBasis; no tax effect.';
  static actionType  = 'IRA_EARNINGS_APPLY';

  constructor({ accountService }) {  // accountService unused but accepted for API symmetry
    super('IRA Earnings Apply', PRIORITY.CASH_FLOW);
    this.reducedActionTypes = ['IRA_EARNINGS_APPLY'];
  }

  reduce(state, action) {
    const key = action.stateKey ?? 'iraAccount';
    const ia = state[key];
    // Negative year: charge the loss to earnings before corpus (design 84 G12).
    const ledger = action.amount < 0
      ? debitLedgerForLoss(ia, -action.amount)
      : { earningsBasis: ia.earningsBasis + action.amount, contributionBasis: ia.contributionBasis };
    // Design 84 G2 — the yield slice of this year's return is DERIVED income and
    // joins the s99B pool; the appreciation slice does not. On a losing year
    // `debitLedgerForLoss` has already clamped the pool to the reduced earnings, so
    // only a gain year adds. Absent `derivedAmount` (legacy/serialized actions) ⇒ 0,
    // i.e. pre-G2 behaviour.
    if (Number.isFinite(ia.derivedIncomeBasis)) {
      ledger.derivedIncomeBasis = Math.min(
        Math.max(0, (ia.derivedIncomeBasis) + Math.max(0, action.derivedAmount ?? 0)),
        Math.max(0, ledger.earningsBasis),
      );
    }
    return this.newState(state, {
      [key]: {
        ...ia,
        ...ledger,
        balance: Math.max(0, ia.balance + action.amount),
      },
    });
  }
}

// ─── Handlers ─────────────────────────────────────────────────────────────────

export class IraContributionHandler extends HandlerEntry {
  static type        = 'IraContributionHandler';
  static description = 'Dispatches IRA_CONTRIBUTION_APPLY and records the contribution metric.';
  static eventType   = 'IRA_CONTRIBUTION';

  constructor() {
    super(null, 'IRA Contribution');
    this.generatedActionTypes = ['IRA_CONTRIBUTION_APPLY', 'RECORD_FIELD_VALUE', 'RECORD_BALANCE'];
  }

  call({ data, state }) {
    if (state?.contributionsSuspended) return [];
    return [
      { type: 'IRA_CONTRIBUTION_APPLY', amount: data.amount },
      new FieldValueAction('ira_contribution', 'IRA Contribution', data.amount),
      new RecordBalanceAction('iraAccount.balance', 'iraAccount'),
    ];
  }
}

export class IraWithdrawalContributionsHandler extends HandlerEntry {
  static type        = 'IraWithdrawalContributionsHandler';
  static description = 'Applies 10% penalty for under-60 withdrawals and dispatches IRA_WITHDRAWAL_CONTRIB_APPLY.';
  static eventType   = 'IRA_WITHDRAWAL_CONTRIBUTIONS';

  constructor({ ownerId = null } = {}) {
    super(null, 'IRA Withdrawal Contributions');
    this.ownerId = ownerId;
    this.generatedActionTypes = ['IRA_WITHDRAWAL_CONTRIB_APPLY', 'RECORD_FIELD_VALUE', 'RECORD_BALANCE'];
  }

  static fromJSON(d, ctx) { const h = new this({ ownerId: d.ownerId ?? null }); h.id = d.id; return h; }
  toJSON() { return { ...super.toJSON(), ownerId: this.ownerId }; }

  call({ date, state, data }) {
    const personKey = this.ownerId ?? Object.keys(state.people ?? {})[0];
    const birthDate = getBirthDate(state, personKey);
    const age     = birthDate ? getAge(birthDate, date) : 0;
    const penalty = age < 60 ? data.amount * 0.10 : 0;
    return [
      { type: 'IRA_WITHDRAWAL_CONTRIB_APPLY', amount: data.amount, penaltyAmount: penalty },
      new FieldValueAction('ira_withdrawal_contributions', 'IRA Withdrawal', data.amount),
      new RecordBalanceAction('iraAccount.balance', 'iraAccount'),
    ];
  }
}

export class IraWithdrawalEarningsHandler extends HandlerEntry {
  static type        = 'IraWithdrawalEarningsHandler';
  static description = 'Applies 10% penalty for under-60 withdrawals and dispatches IRA_WITHDRAWAL_EARNINGS_APPLY.';
  static eventType   = 'IRA_WITHDRAWAL_EARNINGS';

  constructor({ ownerId = null } = {}) {
    super(null, 'IRA Withdrawal Earnings');
    this.ownerId = ownerId;
    this.generatedActionTypes = ['IRA_WITHDRAWAL_EARNINGS_APPLY', 'RECORD_FIELD_VALUE', 'RECORD_BALANCE'];
  }

  static fromJSON(d, ctx) { const h = new this({ ownerId: d.ownerId ?? null }); h.id = d.id; return h; }
  toJSON() { return { ...super.toJSON(), ownerId: this.ownerId }; }

  call({ date, state, data }) {
    const personKey = this.ownerId ?? Object.keys(state.people ?? {})[0];
    const birthDate = getBirthDate(state, personKey);
    const age     = birthDate ? getAge(birthDate, date) : 0;
    const penalty = age < 60 ? data.amount * 0.10 : 0;
    return [
      {
        type: 'IRA_WITHDRAWAL_EARNINGS_APPLY',
        amount:        data.amount,
        penaltyAmount: penalty,
        residency:     state.people?.[personKey]?.residency ?? null,
      },
      new FieldValueAction('ira_withdrawal_earnings', 'IRA Withdrawal Earnings', data.amount),
      new RecordBalanceAction('iraAccount.balance', 'iraAccount'),
    ];
  }
}

export class IraEarningsHandler extends HandlerEntry {
  static type        = 'IraEarningsHandler';
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
