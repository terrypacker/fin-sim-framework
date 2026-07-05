/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { Reducer, PRIORITY } from '../../simulation-framework/reducers.js';
import { InsufficientFundsError } from '../assets/account.js';
import { getUsEarlyWithdrawalRules } from '../account-rules/us/us-early-withdrawal-rules.js';
import { convertNetOfFee, grossUpForTarget } from '../fx/fx-conversion.js';

/**
 * Handles the INTL_TRANSFER_APPLY action.
 *
 * Executes a cross-currency transfer in one of two directions, reading the
 * exchange rate and fee from state so they can be updated at runtime without
 * re-registering the reducer.
 *
 * Direction AU_TO_US (AUD → USD):
 *   AUD needed  = (targetDeficit + feeUsd) × rate
 *   USD received = audWithdrawn ÷ rate − feeUsd
 *
 * Direction US_TO_AU (USD → AUD):
 *   USD needed  = targetDeficit ÷ rate + feeUsd
 *   AUD received = (usdWithdrawn − feeUsd) × rate
 *
 * If the source savings account is short, AccountService.replenishSavings is
 * called synchronously to draw from domestic investment accounts before the
 * transfer executes.  On full exhaustion a partial transfer proceeds with
 * whatever is available, then OUT_OF_FUNDS is chained for the remaining gap.
 *
 * Runs at PRIORITY.PRE_PROCESS — before EXPENSE_DEBIT so the savings account
 * is topped up before the debit fires.
 *
 * State keys read:
 *   state.effectiveExchangeRates.USD_AUD  — 1 USD = N AUD (written by FxRefreshReducer)
 *   state.effectiveFxFees.USD_AUD         — fixed fee per transfer in USD
 *
 * @param {object}   opts
 * @param {import('../../finance/services/account-service.js').AccountService} opts.accountService
 * @param {string}   [opts.usSavingsKey='usSavingsAccount']
 * @param {string}   [opts.auSavingsKey='auSavingsAccount']
 * @param {Function} [opts.earlyWithdrawalRulesFn] - (accountType) → rules | null
 */
export class IntlTransferApplyReducer extends Reducer {
  static description = 'Executes a cross-currency transfer (AU↔US) with exchange rate conversion and fee; chains OUT_OF_FUNDS if neither side can cover the deficit.';
  static type        = 'IntlTransferApplyReducer';
  static actionType  = 'INTL_TRANSFER_APPLY';

  constructor({ accountService, usSavingsKey = 'usSavingsAccount', auSavingsKey = 'auSavingsAccount', earlyWithdrawalRulesFn = getUsEarlyWithdrawalRules } = {}) {
    super('International Transfer Apply', PRIORITY.PRE_PROCESS);
    this.accountService         = accountService;
    this.usSavingsKey           = usSavingsKey;
    this.auSavingsKey           = auSavingsKey;
    this.earlyWithdrawalRulesFn = earlyWithdrawalRulesFn;
    this.reducedActionTypes     = ['INTL_TRANSFER_APPLY'];
    this.generatedActionTypes   = ['OUT_OF_FUNDS'];
  }

  static fromJSON(d, { accountService }) {
    const r = new this({ accountService, usSavingsKey: d.usSavingsKey ?? 'usSavingsAccount', auSavingsKey: d.auSavingsKey ?? 'auSavingsAccount' });
    r.id = d.id;
    return r;
  }

  toJSON() {
    return { ...super.toJSON(), usSavingsKey: this.usSavingsKey, auSavingsKey: this.auSavingsKey };
  }

  reduce(state, action, date) {
    const { direction, targetDeficit } = action;
    const rate  = state.effectiveExchangeRates?.USD_AUD ?? 1.55;
    const fee   = state.effectiveFxFees?.USD_AUD ?? 15;
    const usAcc = state[this.usSavingsKey];
    const auAcc = state[this.auSavingsKey];
    const pendingTaxActions = [];

    if (direction === 'AU_TO_US') {
      const audNeeded = grossUpForTarget(targetDeficit, 'AUD', 'USD', rate, fee);
      const shortfall = audNeeded - auAcc.balance;
      if (shortfall > 0) {
        try {
          const result = this.accountService.replenishSavings(state, this.auSavingsKey, shortfall, date, this.earlyWithdrawalRulesFn);
          pendingTaxActions.push(...result.pendingTaxActions, ...(result.crossBorderTransfers ?? []));
        } catch (e) {
          if (!(e instanceof InsufficientFundsError)) throw e;
        }
      }
      const audActual   = Math.min(audNeeded, auAcc.balance);
      const usdReceived = Math.max(0, convertNetOfFee(audActual, 'AUD', 'USD', rate, fee));
      if (audActual > 0) {
        this.accountService.transaction(auAcc, -audActual,   date);
        this.accountService.transaction(usAcc, +usdReceived, date);
      }
      const usdShortfall = targetDeficit - usdReceived;
      if (usdShortfall > 0.01) {
        return this.newState(state, {}, [...pendingTaxActions, { type: 'OUT_OF_FUNDS', deficit: usdShortfall, currency: 'USD' }]);
      }

    } else {
      const usdNeeded = grossUpForTarget(targetDeficit, 'USD', 'AUD', rate, fee);
      const shortfall = usdNeeded - usAcc.balance;
      if (shortfall > 0) {
        try {
          const result = this.accountService.replenishSavings(state, this.usSavingsKey, shortfall, date, this.earlyWithdrawalRulesFn);
          pendingTaxActions.push(...result.pendingTaxActions, ...(result.crossBorderTransfers ?? []));
        } catch (e) {
          if (!(e instanceof InsufficientFundsError)) throw e;
        }
      }
      const usdActual   = Math.min(usdNeeded, usAcc.balance);
      const audReceived = Math.max(0, convertNetOfFee(usdActual, 'USD', 'AUD', rate, fee));
      if (usdActual > 0) {
        this.accountService.transaction(usAcc, -usdActual,   date);
        this.accountService.transaction(auAcc, +audReceived, date);
      }
      const audShortfall = targetDeficit - audReceived;
      if (audShortfall > 0.01) {
        return this.newState(state, {}, [...pendingTaxActions, { type: 'OUT_OF_FUNDS', deficit: audShortfall, currency: 'AUD' }]);
      }
    }

    return pendingTaxActions.length > 0
      ? this.newState(state, {}, pendingTaxActions)
      : this.newState(state);
  }
}

/**
 * Handles INTL_TRANSFER_RECORD — a journal/telemetry-only marker for a
 * cross-currency cash sweep that `AccountService.replenishSavings` already
 * executed inline (the "stranding fix" spends idle foreign cash before domestic
 * investments, so the conversion must happen synchronously inside the drawdown
 * loop rather than via a chained INTL_TRANSFER_APPLY). This reducer makes that
 * leg visible in the journal without moving money — the transfer is already
 * done. Design 44 Gap A / A2.
 *
 * Action fields (all informational): direction, srcKey, dstKey, from, to,
 *   fromAmount, toAmount, fee.
 */
export class IntlTransferRecordReducer extends Reducer {
  static description = 'Journal/telemetry-only record of a cross-border cash sweep already executed inline by replenishSavings; no state change.';
  static type        = 'IntlTransferRecordReducer';
  static actionType  = 'INTL_TRANSFER_RECORD';

  constructor() {
    super('International Transfer Record', PRIORITY.CASH_FLOW);
    this.reducedActionTypes   = ['INTL_TRANSFER_RECORD'];
    this.generatedActionTypes = [];
  }

  static fromJSON(d) {
    const r = new this();
    r.id = d.id;
    return r;
  }

  reduce(state) {
    return this.newState(state);
  }
}
