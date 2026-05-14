/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { HandlerEntry } from '../../simulation-framework/handlers.js';
import { RecordBalanceAction, RecordMetricAction } from '../../simulation-framework/actions.js';

/**
 * Handles the US_SAVINGS_INTEREST_MONTHLY event.
 *
 * Computes monthly interest as: balance × interestRate ÷ 12, rounded to 2 dp.
 * Emits US_SAVINGS_INTEREST_CREDIT so the reducer can credit the account and
 * update YTD accumulators (including AU cross-reporting when resident).
 *
 * @param {object} opts
 * @param {import('../services/state-registry.js').StateRegistry} opts.stateRegistry
 * @param {string} opts.role       - ACCOUNT_ROLES value for the savings account
 * @param {string} [opts.ownerId]  - Person id (null = any owner)
 * @param {number} [opts.interestRate=0.03] Annual interest rate (e.g. 0.03 = 3%)
 */
export class UsSavingsInterestMonthlyHandler extends HandlerEntry {
  static description = 'Computes monthly interest on a US savings account and emits US_SAVINGS_INTEREST_CREDIT.';

  static eventType = 'US_SAVINGS_INTEREST_MONTHLY';

  constructor({ stateRegistry, role, ownerId = null, interestRate = 0.03 } = {}) {
    super(null, 'Monthly US Savings Interest');
    this.stateRegistry = stateRegistry;
    this.role          = role;
    this.ownerId       = ownerId;
    this.interestRate  = interestRate;
    this.generatedActionTypes = ['US_SAVINGS_INTEREST_CREDIT', 'RECORD_METRIC', 'RECORD_BALANCE'];
  }

  call({ state }) {
    const stateKey = this.stateRegistry.getStateKey(this.role, this.ownerId);
    const balance  = this.stateRegistry.getAccount(state, this.role, this.ownerId)?.balance ?? 0;
    const amount   = +(balance * this.interestRate / 12).toFixed(2);
    if (amount <= 0) return [new RecordBalanceAction(`${stateKey}.balance`, stateKey)];
    return [
      { type: 'US_SAVINGS_INTEREST_CREDIT', amount },
      new RecordMetricAction('us_savings_interest', amount),
      new RecordBalanceAction(`${stateKey}.balance`, stateKey),
    ];
  }
}
