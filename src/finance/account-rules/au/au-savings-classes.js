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

/** Resolve the AU cash pool. */
const auCash = (state) => state.auSavingsAccount ?? state.checkingAccount;

// ─── Reducers ─────────────────────────────────────────────────────────────────

/**
 * EVT-16: AU savings contribution — debit external cash pool, credit AU savings.
 * In the intl scenario this is a no-op (src === auSavingsAccount).
 */
export class AuSavingsContributionApplyReducer extends AccountServiceReducer {
  static type        = 'AuSavingsContributionApplyReducer';
  static description = 'Debits the external cash pool and credits auSavingsAccount balance; no-op in the intl scenario where there is no checkingAccount.';
  static actionType  = 'AU_SAVINGS_CONTRIBUTION_APPLY';

  constructor({ accountService }) {
    super('AU Savings Contribution Apply', PRIORITY.CASH_FLOW);
    this.accountService = accountService;
    this.reducedActionTypes = ['AU_SAVINGS_CONTRIBUTION_APPLY'];
  }

  reduce(state, action) {
    const src = state.checkingAccount ?? state.auSavingsAccount;
    this.accountService.transaction(src, -action.amount, null);
    this.accountService.transaction(state.auSavingsAccount, action.amount, null);
    return this.newState(state, {});
  }
}

/**
 * EVT-17: AU savings withdrawal — debit AU savings balance, credit external cash pool.
 */
export class AuSavingsWithdrawalApplyReducer extends AccountServiceReducer {
  static type        = 'AuSavingsWithdrawalApplyReducer';
  static description = 'Credits the external cash pool and debits auSavingsAccount balance.';
  static actionType  = 'AU_SAVINGS_WITHDRAWAL_APPLY';

  constructor({ accountService }) {
    super('AU Savings Withdrawal Apply', PRIORITY.CASH_FLOW);
    this.accountService = accountService;
    this.reducedActionTypes = ['AU_SAVINGS_WITHDRAWAL_APPLY'];
  }

  reduce(state, action) {
    const src = state.checkingAccount ?? state.auSavingsAccount;
    this.accountService.transaction(src, action.amount, null);
    this.accountService.transaction(state.auSavingsAccount, -action.amount, null);
    return this.newState(state, {});
  }
}

/**
 * EVT-18/19: AU savings earnings — stay in account.
 * Chains AU_SAVINGS_EARNINGS_TAX (US ordinary + AU resident/NR bucket).
 */
export class AuSavingsEarningsApplyReducer extends AccountServiceReducer {
  static type        = 'AuSavingsEarningsApplyReducer';
  static description = 'Adds earnings to auSavingsAccount balance; chains AU_SAVINGS_EARNINGS_TAX.';
  static actionType  = 'AU_SAVINGS_EARNINGS_APPLY';

  constructor({ accountService }) {  // accountService unused but accepted for API symmetry
    super('AU Savings Earnings Apply', PRIORITY.CASH_FLOW);
    this.reducedActionTypes   = ['AU_SAVINGS_EARNINGS_APPLY'];
    this.generatedActionTypes = ['AU_SAVINGS_EARNINGS_TAX'];
  }

  reduce(state, action) {
    const { amount, residency } = action;
    // Per-account (design 55 §7): credit the account the handler stamped, not a
    // hardcoded key. Fall back to the canonical single-account key for legacy
    // bare-event dispatchers and pre-stateKey saved actions. (Also fixes a latent
    // bug where the balance was rebased on auCash(state) rather than the account.)
    const key  = action.stateKey ?? 'auSavingsAccount';
    const acct = state[key];
    return this.newState(
      state,
      {
        [key]: { ...acct, balance: acct.balance + amount },
      },
      [{ type: 'AU_SAVINGS_EARNINGS_TAX', amount, residency, stateKey: key }]
    );
  }
}

// ─── Handlers ─────────────────────────────────────────────────────────────────

export class AuSavingsContributionHandler extends HandlerEntry {
  static type        = 'AuSavingsContributionHandler';
  static description = 'Dispatches AU_SAVINGS_CONTRIBUTION_APPLY.';
  static eventType   = 'AU_SAVINGS_CONTRIBUTION';

  constructor() {
    super(null, 'AU Savings Contribution');
    this.generatedActionTypes = ['AU_SAVINGS_CONTRIBUTION_APPLY', 'RECORD_BALANCE'];
  }

  call({ data, state }) {
    const cashKey = state.auSavingsAccount != null ? 'auSavingsAccount' : 'checkingAccount';
    return [
      { type: 'AU_SAVINGS_CONTRIBUTION_APPLY', amount: data.amount },
      new RecordBalanceAction(`${cashKey}.balance`, cashKey),
    ];
  }
}

export class AuSavingsWithdrawalHandler extends HandlerEntry {
  static type        = 'AuSavingsWithdrawalHandler';
  static description = 'Dispatches AU_SAVINGS_WITHDRAWAL_APPLY.';
  static eventType   = 'AU_SAVINGS_WITHDRAWAL';

  constructor() {
    super(null, 'AU Savings Withdrawal');
    this.generatedActionTypes = ['AU_SAVINGS_WITHDRAWAL_APPLY', 'RECORD_BALANCE'];
  }

  call({ data, state }) {
    const cashKey = state.auSavingsAccount != null ? 'auSavingsAccount' : 'checkingAccount';
    return [
      { type: 'AU_SAVINGS_WITHDRAWAL_APPLY', amount: data.amount },
      new RecordBalanceAction(`${cashKey}.balance`, cashKey),
    ];
  }
}

export class AuSavingsEarningsHandler extends HandlerEntry {
  static type        = 'AuSavingsEarningsHandler';
  static description = 'Dispatches AU_SAVINGS_EARNINGS_APPLY, passing the AU residency flag from state.';
  static eventType   = 'AU_SAVINGS_EARNINGS';

  constructor() {
    super(null, 'AU Savings Earnings');
    this.generatedActionTypes = ['AU_SAVINGS_EARNINGS_APPLY', 'RECORD_BALANCE'];
  }

  call({ data, state }) {
    const cashKey = state.auSavingsAccount != null ? 'auSavingsAccount' : 'checkingAccount';
    return [
      { type: 'AU_SAVINGS_EARNINGS_APPLY', amount: data.amount, residency: state.people?.[Object.keys(state.people ?? {})[0]]?.residency ?? null },
      new RecordBalanceAction(`${cashKey}.balance`, cashKey),
    ];
  }
}
