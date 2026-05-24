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
import { InsufficientFundsError } from '../account.js';

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
 *   state.exchangeRateUsdToAud  — 1 USD = N AUD
 *   state.intlTransferFeeUsd    — fixed fee per transfer in USD
 *
 * @param {object} opts
 * @param {import('../../finance/services/account-service.js').AccountService} opts.accountService
 * @param {string} [opts.usSavingsKey='usSavingsAccount']
 * @param {string} [opts.auSavingsKey='auSavingsAccount']
 */
export class IntlTransferApplyReducer extends Reducer {
  static description = 'Executes a cross-currency transfer (AU↔US) with exchange rate conversion and fee; chains OUT_OF_FUNDS if neither side can cover the deficit.';

  static actionType = 'INTL_TRANSFER_APPLY';

  constructor({ accountService, usSavingsKey = 'usSavingsAccount', auSavingsKey = 'auSavingsAccount' } = {}) {
    super('International Transfer Apply', PRIORITY.PRE_PROCESS);
    this.accountService = accountService;
    this.usSavingsKey   = usSavingsKey;
    this.auSavingsKey   = auSavingsKey;
  }

  reduce(state, action, date) {
    const { direction, targetDeficit } = action;
    const rate = state.exchangeRateUsdToAud;
    const fee  = state.intlTransferFeeUsd;
    const usAcc = state[this.usSavingsKey];
    const auAcc = state[this.auSavingsKey];

    if (direction === 'AU_TO_US') {
      // How much AUD do we need from the AU side?
      const audNeeded  = (targetDeficit + fee) * rate;
      const shortfall  = audNeeded - auAcc.balance;
      if (shortfall > 0) {
        try {
          this.accountService.replenishSavings(state, this.auSavingsKey, shortfall, date);
        } catch (e) {
          if (!(e instanceof InsufficientFundsError)) throw e;
          // AU exhausted — proceed with whatever AUD is available
        }
      }
      const audActual   = Math.min(audNeeded, auAcc.balance);
      const usdReceived = Math.max(0, audActual / rate - fee);
      if (audActual > 0) {
        this.accountService.transaction(auAcc, -audActual,   date);
        this.accountService.transaction(usAcc, +usdReceived, date);
      }
      const usdShortfall = targetDeficit - usdReceived;
      if (usdShortfall > 0.01) {
        return this.newState(state, {}, [{ type: 'OUT_OF_FUNDS', deficit: usdShortfall, currency: 'USD' }]);
      }

    } else {
      // US_TO_AU — how much USD do we need from the US side?
      const usdNeeded  = targetDeficit / rate + fee;
      const shortfall  = usdNeeded - usAcc.balance;
      if (shortfall > 0) {
        try {
          this.accountService.replenishSavings(state, this.usSavingsKey, shortfall, date);
        } catch (e) {
          if (!(e instanceof InsufficientFundsError)) throw e;
          // US exhausted — proceed with whatever USD is available
        }
      }
      const usdActual   = Math.min(usdNeeded, usAcc.balance);
      const audReceived = Math.max(0, (usdActual - fee) * rate);
      if (usdActual > 0) {
        this.accountService.transaction(usAcc, -usdActual,   date);
        this.accountService.transaction(auAcc, +audReceived, date);
      }
      const audShortfall = targetDeficit - audReceived;
      if (audShortfall > 0.01) {
        return this.newState(state, {}, [{ type: 'OUT_OF_FUNDS', deficit: audShortfall, currency: 'AUD' }]);
      }
    }

    return this.newState(state);
  }
}
