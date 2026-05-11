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
 * Handles INTL_ROTH_EARNINGS events.
 * Computes annual growth as: balance × growthRate, dispatches ROTH_EARNINGS_APPLY.
 */
export class IntlRothEarningsHandler extends HandlerEntry {
  static description = 'Computes annual growth on the Roth IRA (balance × growthRate) and dispatches ROTH_EARNINGS_APPLY.';
  static eventType = 'INTL_ROTH_EARNINGS';

  constructor({ accountKey = 'rothAccount', growthRate = 0.07 } = {}) {
    super(null, 'Roth IRA Earnings');
    this.accountKey = accountKey;
    this.growthRate = growthRate;
    this.generatedActionTypes = ['ROTH_EARNINGS_APPLY', 'RECORD_METRIC', 'RECORD_BALANCE'];
  }

  call({ state }) {
    const balance = state[this.accountKey]?.balance ?? 0;
    const amount  = +(balance * this.growthRate).toFixed(2);
    if (amount <= 0) return [new RecordBalanceAction(`${this.accountKey}.balance`, this.accountKey)];
    return [
      { type: 'ROTH_EARNINGS_APPLY', amount },
      new RecordMetricAction('roth_earnings', amount),
      new RecordBalanceAction(`${this.accountKey}.balance`, this.accountKey),
    ];
  }
}

/**
 * Handles INTL_IRA_EARNINGS events.
 * Computes annual growth as: balance × growthRate, dispatches IRA_EARNINGS_APPLY.
 */
export class IntlIraEarningsHandler extends HandlerEntry {
  static description = 'Computes annual growth on the Traditional IRA (balance × growthRate) and dispatches IRA_EARNINGS_APPLY.';
  static eventType = 'INTL_IRA_EARNINGS';

  constructor({ accountKey = 'iraAccount', growthRate = 0.07 } = {}) {
    super(null, 'IRA Earnings');
    this.accountKey = accountKey;
    this.growthRate = growthRate;
    this.generatedActionTypes = ['IRA_EARNINGS_APPLY', 'RECORD_METRIC', 'RECORD_BALANCE'];
  }

  call({ state }) {
    const balance = state[this.accountKey]?.balance ?? 0;
    const amount  = +(balance * this.growthRate).toFixed(2);
    if (amount <= 0) return [new RecordBalanceAction(`${this.accountKey}.balance`, this.accountKey)];
    return [
      { type: 'IRA_EARNINGS_APPLY', amount },
      new RecordMetricAction('ira_earnings', amount),
      new RecordBalanceAction(`${this.accountKey}.balance`, this.accountKey),
    ];
  }
}

/**
 * Handles INTL_K401_EARNINGS events.
 * Computes annual growth as: balance × growthRate, dispatches K401_EARNINGS_APPLY.
 */
export class IntlK401EarningsHandler extends HandlerEntry {
  static description = 'Computes annual growth on the 401k (balance × growthRate) and dispatches K401_EARNINGS_APPLY.';
  static eventType = 'INTL_K401_EARNINGS';

  constructor({ accountKey = 'k401Account', growthRate = 0.07 } = {}) {
    super(null, '401k Earnings');
    this.accountKey = accountKey;
    this.growthRate = growthRate;
    this.generatedActionTypes = ['K401_EARNINGS_APPLY', 'RECORD_METRIC', 'RECORD_BALANCE'];
  }

  call({ state }) {
    const balance = state[this.accountKey]?.balance ?? 0;
    const amount  = +(balance * this.growthRate).toFixed(2);
    if (amount <= 0) return [new RecordBalanceAction(`${this.accountKey}.balance`, this.accountKey)];
    return [
      { type: 'K401_EARNINGS_APPLY', amount },
      new RecordMetricAction('k401_earnings', amount),
      new RecordBalanceAction(`${this.accountKey}.balance`, this.accountKey),
    ];
  }
}

/**
 * Handles INTL_STOCK_EARNINGS events.
 * Computes annual unrealized capital appreciation as: balance × growthRate.
 * Dispatches STOCK_EARNINGS_APPLY (no tax — unrealized gain stays in account).
 */
export class IntlUsStockEarningsHandler extends HandlerEntry {
  static description = 'Computes annual unrealized appreciation on the US stock account (balance × growthRate) and dispatches STOCK_EARNINGS_APPLY.';
  static eventType = 'INTL_STOCK_EARNINGS';

  constructor({ accountKey = 'usStockAccount', growthRate = 0.05 } = {}) {
    super(null, 'US Stock Earnings');
    this.accountKey = accountKey;
    this.growthRate = growthRate;
    this.generatedActionTypes = ['STOCK_EARNINGS_APPLY', 'RECORD_METRIC', 'RECORD_BALANCE'];
  }

  call({ state }) {
    const balance = state[this.accountKey]?.balance ?? 0;
    const amount  = +(balance * this.growthRate).toFixed(2);
    if (amount <= 0) return [new RecordBalanceAction(`${this.accountKey}.balance`, this.accountKey)];
    return [
      { type: 'STOCK_EARNINGS_APPLY', amount },
      new RecordMetricAction('us_stock_earnings', amount),
      new RecordBalanceAction(`${this.accountKey}.balance`, this.accountKey),
    ];
  }
}

/**
 * Handles INTL_AU_STOCK_EARNINGS events.
 * Computes annual unrealized capital appreciation as: balance × growthRate.
 * Dispatches AU_STOCK_EARNINGS_APPLY (no tax — unrealized gain stays in account).
 */
export class IntlAuStockEarningsHandler extends HandlerEntry {
  static description = 'Computes annual unrealized appreciation on the AU stock account (balance × growthRate) and dispatches AU_STOCK_EARNINGS_APPLY.';
  static eventType = 'INTL_AU_STOCK_EARNINGS';

  constructor({ accountKey = 'auStockAccount', growthRate = 0.06 } = {}) {
    super(null, 'AU Stock Earnings');
    this.accountKey = accountKey;
    this.growthRate = growthRate;
    this.generatedActionTypes = ['AU_STOCK_EARNINGS_APPLY', 'RECORD_METRIC', 'RECORD_BALANCE'];
  }

  call({ state }) {
    const balance = state[this.accountKey]?.balance ?? 0;
    const amount  = +(balance * this.growthRate).toFixed(2);
    if (amount <= 0) return [new RecordBalanceAction(`${this.accountKey}.balance`, this.accountKey)];
    return [
      { type: 'AU_STOCK_EARNINGS_APPLY', amount },
      new RecordMetricAction('au_stock_earnings', amount),
      new RecordBalanceAction(`${this.accountKey}.balance`, this.accountKey),
    ];
  }
}

/**
 * Handles INTL_AU_STOCK_DIVIDEND events.
 * Computes annual AU stock dividends as: balance × dividendRate.
 * Routes to AU_DIVIDEND_FRANKED_RESIDENT_APPLY (AU resident) or
 * AU_DIVIDEND_FRANKED_NONRESIDENT_APPLY (non-resident) based on state.isAuResident.
 * Assumes fully franked dividends, which is typical for Australian equities.
 */
export class IntlAuStockDividendHandler extends HandlerEntry {
  static description = 'Computes annual AU stock dividends (balance × dividendRate) and routes to the franked-resident or franked-non-resident apply action based on residency.';
  static eventType = 'INTL_AU_STOCK_DIVIDEND';

  constructor({ accountKey = 'auStockAccount', dividendRate = 0.04 } = {}) {
    super(null, 'AU Stock Dividend');
    this.accountKey   = accountKey;
    this.dividendRate = dividendRate;
    this.generatedActionTypes = [
      'AU_DIVIDEND_FRANKED_RESIDENT_APPLY',
      'AU_DIVIDEND_FRANKED_NONRESIDENT_APPLY',
      'RECORD_METRIC',
      'RECORD_BALANCE',
    ];
  }

  call({ state }) {
    const balance = state[this.accountKey]?.balance ?? 0;
    const amount  = +(balance * this.dividendRate).toFixed(2);
    if (amount <= 0) return [new RecordBalanceAction(`${this.accountKey}.balance`, this.accountKey)];

    const actionType = state.isAuResident
      ? 'AU_DIVIDEND_FRANKED_RESIDENT_APPLY'
      : 'AU_DIVIDEND_FRANKED_NONRESIDENT_APPLY';

    return [
      { type: actionType, amount },
      new RecordMetricAction('au_stock_dividend', amount),
      new RecordBalanceAction(`${this.accountKey}.balance`, this.accountKey),
    ];
  }
}

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
    this.generatedActionTypes = ['AU_SAVINGS_EARNINGS_APPLY', 'RECORD_METRIC', 'RECORD_BALANCE'];
  }

  call({ state }) {
    const balance = state[this.accountKey]?.balance ?? 0;
    const amount  = +(balance * this.interestRate).toFixed(2);
    if (amount <= 0) return [new RecordBalanceAction(`${this.accountKey}.balance`, `${this.accountKey}`)];
    return [
      { type: 'AU_SAVINGS_EARNINGS_APPLY', amount, isAuResident: state.isAuResident },
      new RecordMetricAction('au_savings_interest', amount),
      new RecordBalanceAction(`${this.accountKey}.balance`, `${this.accountKey}`),
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
    this.generatedActionTypes = ['FIXED_INCOME_EARNINGS_APPLY', 'RECORD_METRIC', 'RECORD_BALANCE'];
  }

  call({ state }) {
    const balance = state[this.accountKey]?.balance ?? 0;
    const amount  = +(balance * this.interestRate).toFixed(2);
    if (amount <= 0) return [new RecordBalanceAction(`${this.accountKey}.balance`, `${this.accountKey}`)];
    return [
      { type: 'FIXED_INCOME_EARNINGS_APPLY', amount, isAuResident: state.isAuResident },
      new RecordMetricAction('fixed_income_interest', amount),
      new RecordBalanceAction(`${this.accountKey}.balance`, `${this.accountKey}`),
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
    this.generatedActionTypes = ['SUPER_EARNINGS_APPLY', 'RECORD_METRIC', 'RECORD_BALANCE'];
  }

  call({ data, state }) {
    const rate    = data?.rate ?? this.defaultRate;
    const balance = state[this.accountKey]?.balance ?? 0;
    const amount  = +(balance * rate).toFixed(2);
    if (amount <= 0) return [new RecordBalanceAction(`${this.accountKey}.balance`, `${this.accountKey}`)];
    return [
      { type: 'SUPER_EARNINGS_APPLY', amount },
      new RecordMetricAction('super_earnings', amount),
      new RecordBalanceAction(`${this.accountKey}.balance`, `${this.accountKey}`),
    ];
  }
}
