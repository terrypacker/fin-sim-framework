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

/**
 * Reduce IRA by `amount`, drawing from contributionBasis first then earningsBasis.
 * Returns the updated iraAccount object.
 */
export function debitIra(ia, amount) {
  const fromContrib  = Math.min(amount, ia.contributionBasis);
  const fromEarnings = Math.min(amount - fromContrib, ia.earningsBasis);
  return {
    ...ia,
    balance:           ia.balance           - amount,
    contributionBasis: ia.contributionBasis - fromContrib,
    earningsBasis:     ia.earningsBasis     - fromEarnings,
  };
}

// ─── Reducers ─────────────────────────────────────────────────────────────────

/**
 * EVT-35: IRA Rollover Withdrawal — credit US cash pool, debit IRA (contrib first
 * then earnings).  No penalty regardless of age (rollovers are penalty-exempt).
 * Chains IRA_ROLLOVER_WITHDRAWAL_TAX (ordinary income).
 */
export class IraRolloverWithdrawalApplyReducer extends Reducer {
  static description = 'Credits the US cash pool and debits the IRA (no penalty); chains IRA_ROLLOVER_WITHDRAWAL_TAX.';
  static actionType  = 'IRA_ROLLOVER_WITHDRAWAL_APPLY';

  constructor({ accountService }) {
    super('IRA Rollover Withdrawal Apply', PRIORITY.CASH_FLOW);
    this.accountService = accountService;
    this.reducedActionTypes   = ['IRA_ROLLOVER_WITHDRAWAL_APPLY'];
    this.generatedActionTypes = ['IRA_ROLLOVER_WITHDRAWAL_TAX'];
  }

  reduce(state, action) {
    const { amount, isAuResident } = action;
    this.accountService.transaction(usCash(state), amount, null);
    return this.newState(
      state,
      { iraAccount: debitIra(state.iraAccount, amount) },
      [{ type: 'IRA_ROLLOVER_WITHDRAWAL_TAX', amount, isAuResident }]
    );
  }
}

/**
 * EVT-40: IRA RMD — credit US cash pool, debit IRA (required at age 72+).
 * No penalty.  Chains IRA_RMD_TAX (ordinary income).
 */
export class IraRmdApplyReducer extends Reducer {
  static description = 'Credits the US cash pool and debits the IRA for the required minimum distribution; chains IRA_RMD_TAX.';
  static actionType  = 'IRA_RMD_APPLY';

  constructor({ accountService }) {
    super('IRA RMD Apply', PRIORITY.CASH_FLOW);
    this.accountService = accountService;
    this.reducedActionTypes   = ['IRA_RMD_APPLY'];
    this.generatedActionTypes = ['IRA_RMD_TAX'];
  }

  reduce(state, action) {
    const { amount, isAuResident } = action;
    this.accountService.transaction(usCash(state), amount, null);
    return this.newState(
      state,
      { iraAccount: debitIra(state.iraAccount, amount) },
      [{ type: 'IRA_RMD_TAX', amount, isAuResident }]
    );
  }
}

// ─── Handlers ─────────────────────────────────────────────────────────────────

export class IraRolloverWithdrawalHandler extends HandlerEntry {
  static description = 'Dispatches IRA_ROLLOVER_WITHDRAWAL_APPLY — no penalty applied (rollover exemption).';
  static eventType   = 'IRA_ROLLOVER_WITHDRAWAL';

  constructor() {
    super(null, 'IRA Rollover Withdrawal');
    this.generatedActionTypes = ['IRA_ROLLOVER_WITHDRAWAL_APPLY', 'RECORD_FIELD_VALUE', 'RECORD_BALANCE'];
  }

  call({ state, data }) {
    const cashKey = state.usSavingsAccount != null ? 'usSavingsAccount' : 'checkingAccount';
    return [
      {
        type:         'IRA_ROLLOVER_WITHDRAWAL_APPLY',
        amount:       data.amount,
        isAuResident: state.isAuResident,
      },
      new FieldValueAction('ira_rollover_withdrawal', 'IRA Rollover Withdrawal', data.amount),
      new RecordBalanceAction(`${cashKey}.balance`, cashKey),
    ];
  }
}

export class IraRmdHandler extends HandlerEntry {
  static description = 'Dispatches IRA_RMD_APPLY for the required minimum distribution.';
  static eventType   = 'IRA_RMD';

  constructor() {
    super(null, 'IRA RMD');
    this.generatedActionTypes = ['IRA_RMD_APPLY', 'RECORD_FIELD_VALUE', 'RECORD_BALANCE'];
  }

  call({ state, data }) {
    const cashKey = state.usSavingsAccount != null ? 'usSavingsAccount' : 'checkingAccount';
    return [
      {
        type:         'IRA_RMD_APPLY',
        amount:       data.amount,
        isAuResident: state.isAuResident,
      },
      new FieldValueAction('ira_rmd', 'IRA RMD', data.amount),
      new RecordBalanceAction(`${cashKey}.balance`, cashKey),
    ];
  }
}
