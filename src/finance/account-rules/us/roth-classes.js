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

/**
 * The DERIVED slice of an earnings withdrawal (design 84 G2), pro-rata on the
 * wrapper's own composition — the same split `drawDerivedProRata` applies to the
 * pool it leaves behind, so the two cannot disagree.
 *
 * Returns null when the account carries no derived pool, which the tax module reads
 * as "assess the whole amount" — the pre-G2 behaviour, and the safe direction for a
 * saved state written before the pool existed.
 */
function _derivedShareOf(account, earningsDrawn) {
  const d = account?.derivedIncomeBasis;
  if (!Number.isFinite(d)) return null;
  const earnings = Math.max(0, account?.earningsBasis ?? 0);
  if (earnings <= 0) return 0;
  const share = Math.min(1, Math.max(0, d) / earnings);
  return +(Math.max(0, earningsDrawn) * share).toFixed(2);
}

/** Resolve the US cash pool (legacy tail; prefer resolveCashKey for routing). */
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

  constructor({ accountService, stateRegistry }) {
    super('Roth Contribution Apply', PRIORITY.CASH_FLOW);
    this.accountService = accountService;
    this.stateRegistry  = stateRegistry;
    this.reducedActionTypes = ['ROTH_CONTRIBUTION_APPLY'];
  }

  reduce(state, action) {
    this.accountService.transaction(state[resolveCashKey(this.stateRegistry, 'US', state)], -action.amount, null);
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

  constructor({ accountService, stateRegistry }) {
    super('Roth Contribution Withdrawal Apply', PRIORITY.CASH_FLOW);
    this.accountService = accountService;
    this.stateRegistry  = stateRegistry;
    this.reducedActionTypes = ['ROTH_WITHDRAWAL_CONTRIB_APPLY'];
  }

  reduce(state, action) {
    this.accountService.transaction(state[resolveCashKey(this.stateRegistry, 'US', state)], action.amount, null);
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

  constructor({ accountService, stateRegistry }) {
    super('Roth Withdrawal Earnings Apply', PRIORITY.CASH_FLOW);
    this.accountService = accountService;
    this.stateRegistry  = stateRegistry;
    this.reducedActionTypes   = ['ROTH_WITHDRAWAL_EARNINGS_APPLY'];
    this.generatedActionTypes = ['ROTH_WITHDRAWAL_EARNINGS_TAX'];
  }

  reduce(state, action) {
    const { amount, penaltyAmount, residency } = action;
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
          balance:       newBalance,
          earningsBasis: ra.earningsBasis - amount,
          // Design 84 G2 — the derived pool leaves with the earnings, pro-rata.
          ...drawDerivedProRata(ra, amount),
          holdings:      scaleHoldings(ra.holdings, ra.balance, newBalance),
        },
      },
      // Design 76 Gap B: stamp the account so the AU return attributes to its owner.
      // Design 84 G2: `auAssessableAmount` is the DERIVED slice of the earnings being drawn —
      // the part s99B actually reaches. The §72(t) penalty still bites on the whole
      // `amount`, because that is a US rule about earnings, not about trust income.
      // Absent (no ledger, or a pre-G2 saved action) ⇒ the tax module falls back to
      // `amount`, i.e. the old assess-everything behaviour.
      [{
        type: 'ROTH_WITHDRAWAL_EARNINGS_TAX', amount, penaltyAmount, residency, stateKey: key,
        auAssessableAmount: _derivedShareOf(ra, amount),
      }]
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
    // A negative year charges the loss to earnings before corpus (design 84 G12).
    // Adding it straight to `earningsBasis` would drive the s99B-assessable slice
    // negative and, once clamped, would leave assessable earnings standing that the
    // market has already removed.
    const ledger = action.amount < 0
      ? debitLedgerForLoss(ra, -action.amount)
      : { earningsBasis: ra.earningsBasis + action.amount, contributionBasis: ra.contributionBasis };
    // Design 84 G2 — the yield slice of this year's return is DERIVED income and
    // joins the s99B pool; the appreciation slice does not. On a losing year
    // `debitLedgerForLoss` has already clamped the pool to the reduced earnings, so
    // only a gain year adds. Absent `derivedAmount` (legacy/serialized actions) ⇒ 0,
    // i.e. pre-G2 behaviour.
    if (Number.isFinite(ra.derivedIncomeBasis)) {
      ledger.derivedIncomeBasis = Math.min(
        Math.max(0, (ra.derivedIncomeBasis) + Math.max(0, action.derivedAmount ?? 0)),
        Math.max(0, ledger.earningsBasis),
      );
    }
    return this.newState(state, {
      [key]: {
        ...ra,
        ...ledger,
        balance: Math.max(0, ra.balance + action.amount),
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
