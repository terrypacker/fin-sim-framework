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
 * @param {string} [opts.accountKey='usSavingsAccount']
 *   State key for the savings account whose balance drives the calculation.
 * @param {number} [opts.interestRate=0.03]
 *   Annual interest rate (e.g. 0.03 = 3%).
 */
export class UsSavingsInterestMonthlyHandler extends HandlerEntry {
  static description = 'Computes monthly interest on a US savings account and emits US_SAVINGS_INTEREST_CREDIT.';

  static eventType = 'US_SAVINGS_INTEREST_MONTHLY';

  constructor({ accountKey = 'usSavingsAccount', interestRate = 0.03 } = {}) {
    super(null, 'Monthly US Savings Interest');
    this.accountKey   = accountKey;
    this.interestRate = interestRate;
  }

  call({ state }) {
    const balance = state[this.accountKey]?.balance ?? 0;
    const amount  = +(balance * this.interestRate / 12).toFixed(2);
    if (amount <= 0) return [new RecordBalanceAction()];
    return [
      { type: 'US_SAVINGS_INTEREST_CREDIT', amount },
      new RecordMetricAction('us_savings_interest', amount),
      new RecordBalanceAction(),
    ];
  }
}
