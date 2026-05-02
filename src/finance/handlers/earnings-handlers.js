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
 * Handles INTL_AU_SAVINGS_INTEREST events.
 *
 * Computes annual interest as: balance × interestRate, rounded to 2 dp.
 * Emits AU_SAVINGS_EARNINGS_APPLY (registered by AuAccountModule) which
 * credits the account and chains AU_SAVINGS_EARNINGS_TAX.
 *
 * Uses the INTL_ prefix to avoid colliding with the account module's own
 * AU_SAVINGS_EARNINGS event handler (which expects data.amount to be provided
 * by the caller rather than computed from balance × rate).
 *
 * @param {object} [opts]
 * @param {string} [opts.accountKey='auSavingsAccount']
 * @param {number} [opts.interestRate=0.045] Annual interest rate (e.g. 0.045 = 4.5%)
 */
export class AuSavingsInterestHandler extends HandlerEntry {
  static description = 'Computes annual interest on the AU savings account and emits AU_SAVINGS_EARNINGS_APPLY (credited by AuAccountModule).';

  static eventType = 'INTL_AU_SAVINGS_INTEREST';

  constructor({ accountKey = 'auSavingsAccount', interestRate = 0.045 } = {}) {
    super(null, 'AU Savings Interest');
    this.accountKey   = accountKey;
    this.interestRate = interestRate;
  }

  call({ state }) {
    const balance = state[this.accountKey]?.balance ?? 0;
    const amount  = +(balance * this.interestRate).toFixed(2);
    if (amount <= 0) return [new RecordBalanceAction()];
    return [
      { type: 'AU_SAVINGS_EARNINGS_APPLY', amount, isAuResident: state.isAuResident },
      new RecordMetricAction('au_savings_interest', amount),
      new RecordBalanceAction(),
    ];
  }
}

/**
 * Handles INTL_FIXED_INCOME_INTEREST events.
 *
 * Computes annual interest as: balance × interestRate, rounded to 2 dp.
 * Emits FIXED_INCOME_EARNINGS_APPLY (registered by UsAccountModule) which
 * credits the account and chains FIXED_INCOME_EARNINGS_TAX.
 *
 * Uses the INTL_ prefix to avoid colliding with the account module's own
 * FIXED_INCOME_EARNINGS handler.
 *
 * @param {object} [opts]
 * @param {string} [opts.accountKey='fixedIncomeAccount']
 * @param {number} [opts.interestRate=0.04] Annual interest rate (e.g. 0.04 = 4%)
 */
export class FixedIncomeInterestHandler extends HandlerEntry {
  static description = 'Computes annual interest on the fixed income account and emits FIXED_INCOME_EARNINGS_APPLY (credited by UsAccountModule).';

  static eventType = 'INTL_FIXED_INCOME_INTEREST';

  constructor({ accountKey = 'fixedIncomeAccount', interestRate = 0.04 } = {}) {
    super(null, 'Fixed Income Interest');
    this.accountKey   = accountKey;
    this.interestRate = interestRate;
  }

  call({ state }) {
    const balance = state[this.accountKey]?.balance ?? 0;
    const amount  = +(balance * this.interestRate).toFixed(2);
    if (amount <= 0) return [new RecordBalanceAction()];
    return [
      { type: 'FIXED_INCOME_EARNINGS_APPLY', amount, isAuResident: state.isAuResident },
      new RecordMetricAction('fixed_income_interest', amount),
      new RecordBalanceAction(),
    ];
  }
}

/**
 * Handles INTL_SUPER_EARNINGS events.
 *
 * Computes annual earnings as: balance × rate, rounded to 2 dp.
 * data.rate overrides the configured defaultRate for one-off adjustments.
 * Emits SUPER_EARNINGS_APPLY (registered by AuAccountModule) which credits
 * both balance and earningsBasis, then chains SUPER_EARNINGS_TAX (15%).
 *
 * Uses the INTL_ prefix to avoid colliding with the account module's own
 * SUPER_EARNINGS handler.
 *
 * @param {object} [opts]
 * @param {string} [opts.accountKey='superAccount']
 * @param {number} [opts.defaultRate=0.07] Default annual growth rate (e.g. 0.07 = 7%)
 */
export class SuperEarningsHandler extends HandlerEntry {
  static description = 'Computes annual earnings on the superannuation account and emits SUPER_EARNINGS_APPLY (credited by AuAccountModule).';

  static eventType = 'INTL_SUPER_EARNINGS';

  constructor({ accountKey = 'superAccount', defaultRate = 0.07 } = {}) {
    super(null, 'Super Earnings');
    this.accountKey  = accountKey;
    this.defaultRate = defaultRate;
  }

  call({ data, state }) {
    const rate    = data?.rate ?? this.defaultRate;
    const balance = state[this.accountKey]?.balance ?? 0;
    const amount  = +(balance * rate).toFixed(2);
    if (amount <= 0) return [new RecordBalanceAction()];
    return [
      { type: 'SUPER_EARNINGS_APPLY', amount },
      new RecordMetricAction('super_earnings', amount),
      new RecordBalanceAction(),
    ];
  }
}
