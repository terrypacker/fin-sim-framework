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
import { RATE_KEYS } from '../economic-regimes/rate-keys.js';
import { computeHoldingsGrowth, computeHoldingsDividends } from '../holdings/holdings-earnings.js';

/**
 * Handles INTL_ROTH_EARNINGS events.
 * Computes annual growth as: balance × growthRate, dispatches ROTH_EARNINGS_APPLY.
 */
export class IntlRothEarningsHandler extends HandlerEntry {
  static description = 'Computes annual growth on the Roth IRA (balance × growthRate) and dispatches ROTH_EARNINGS_APPLY.';
  static type        = 'IntlRothEarningsHandler';
  static eventType   = 'INTL_ROTH_EARNINGS';
  static rateKey     = RATE_KEYS.EQUITY_US;

  constructor({ stateRegistry, role, ownerId = null, stateKey = null, growthRate = 0.07, rateKey = null } = {}) {
    super(null, 'Roth IRA Earnings');
    this.stateRegistry   = stateRegistry;
    this.role            = role;
    this.ownerId         = ownerId;
    this._stateKeyFixed  = stateKey;
    this.growthRate      = growthRate;
    this.rateKey         = rateKey ?? new.target.rateKey;
    this.generatedActionTypes = ['ROTH_EARNINGS_APPLY', 'RECORD_METRIC', 'RECORD_BALANCE'];
  }

  static fromJSON(d, { stateRegistry }) {
    const h = new this({ stateRegistry, role: d.role, ownerId: d.ownerId ?? null, growthRate: d.growthRate ?? 0.07 });
    h.id = d.id;
    return h;
  }

  toJSON() {
    return { ...super.toJSON(), role: this.role, ownerId: this.ownerId, growthRate: this.growthRate };
  }

  call({ state }) {
    const stateKey = this._stateKeyFixed ?? this.stateRegistry.getStateKey(this.role, this.ownerId);
    const { amount, holdingActions } = computeHoldingsGrowth({
      state, stateKey,
      fallbackRate:    this.growthRate,
      fallbackRateKey: this.rateKey,
    });
    if (amount <= 0) return [new RecordBalanceAction(`${stateKey}.balance`, stateKey)];
    return [
      { type: 'ROTH_EARNINGS_APPLY', amount, stateKey },
      ...holdingActions,
      new RecordMetricAction('roth_earnings', amount),
      new RecordBalanceAction(`${stateKey}.balance`, stateKey),
    ];
  }
}

/**
 * Handles INTL_IRA_EARNINGS events.
 * Computes annual growth as: balance × growthRate, dispatches IRA_EARNINGS_APPLY.
 */
export class IntlIraEarningsHandler extends HandlerEntry {
  static description = 'Computes annual growth on the Traditional IRA (balance × growthRate) and dispatches IRA_EARNINGS_APPLY.';
  static type        = 'IntlIraEarningsHandler';
  static eventType   = 'INTL_IRA_EARNINGS';
  static rateKey     = RATE_KEYS.EQUITY_US;

  constructor({ stateRegistry, role, ownerId = null, stateKey = null, growthRate = 0.07, rateKey = null } = {}) {
    super(null, 'IRA Earnings');
    this.stateRegistry   = stateRegistry;
    this.role            = role;
    this.ownerId         = ownerId;
    this._stateKeyFixed  = stateKey;
    this.growthRate      = growthRate;
    this.rateKey         = rateKey ?? new.target.rateKey;
    this.generatedActionTypes = ['IRA_EARNINGS_APPLY', 'RECORD_METRIC', 'RECORD_BALANCE'];
  }

  static fromJSON(d, { stateRegistry }) {
    const h = new this({ stateRegistry, role: d.role, ownerId: d.ownerId ?? null, growthRate: d.growthRate ?? 0.07 });
    h.id = d.id;
    return h;
  }

  toJSON() {
    return { ...super.toJSON(), role: this.role, ownerId: this.ownerId, growthRate: this.growthRate };
  }

  call({ state }) {
    const stateKey = this._stateKeyFixed ?? this.stateRegistry.getStateKey(this.role, this.ownerId);
    const { amount, holdingActions } = computeHoldingsGrowth({
      state, stateKey,
      fallbackRate:    this.growthRate,
      fallbackRateKey: this.rateKey,
    });
    if (amount <= 0) return [new RecordBalanceAction(`${stateKey}.balance`, stateKey)];
    return [
      { type: 'IRA_EARNINGS_APPLY', amount, stateKey },
      ...holdingActions,
      new RecordMetricAction('ira_earnings', amount),
      new RecordBalanceAction(`${stateKey}.balance`, stateKey),
    ];
  }
}

/**
 * Handles INTL_K401_EARNINGS events.
 * Computes annual growth as: balance × growthRate, dispatches K401_EARNINGS_APPLY.
 */
export class IntlK401EarningsHandler extends HandlerEntry {
  static description = 'Computes annual growth on the 401k (balance × growthRate) and dispatches K401_EARNINGS_APPLY.';
  static type        = 'IntlK401EarningsHandler';
  static eventType   = 'INTL_K401_EARNINGS';
  static rateKey     = RATE_KEYS.EQUITY_US;

  constructor({ stateRegistry, role, ownerId = null, stateKey = null, growthRate = 0.07, rateKey = null } = {}) {
    super(null, '401k Earnings');
    this.stateRegistry   = stateRegistry;
    this.role            = role;
    this.ownerId         = ownerId;
    this._stateKeyFixed  = stateKey;
    this.growthRate      = growthRate;
    this.rateKey         = rateKey ?? new.target.rateKey;
    this.generatedActionTypes = ['K401_EARNINGS_APPLY', 'RECORD_METRIC', 'RECORD_BALANCE'];
  }

  static fromJSON(d, { stateRegistry }) {
    const h = new this({ stateRegistry, role: d.role, ownerId: d.ownerId ?? null, growthRate: d.growthRate ?? 0.07 });
    h.id = d.id;
    return h;
  }

  toJSON() {
    return { ...super.toJSON(), role: this.role, ownerId: this.ownerId, growthRate: this.growthRate };
  }

  call({ state }) {
    const stateKey = this._stateKeyFixed ?? this.stateRegistry.getStateKey(this.role, this.ownerId);
    const { amount, holdingActions } = computeHoldingsGrowth({
      state, stateKey,
      fallbackRate:    this.growthRate,
      fallbackRateKey: this.rateKey,
    });
    if (amount <= 0) return [new RecordBalanceAction(`${stateKey}.balance`, stateKey)];
    return [
      { type: 'K401_EARNINGS_APPLY', amount, stateKey },
      ...holdingActions,
      new RecordMetricAction('k401_earnings', amount),
      new RecordBalanceAction(`${stateKey}.balance`, stateKey),
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
  static type        = 'IntlUsStockEarningsHandler';
  static eventType   = 'INTL_STOCK_EARNINGS';
  static rateKey     = RATE_KEYS.EQUITY_US;

  constructor({ stateRegistry, role, ownerId = null, stateKey = null, growthRate = 0.05, rateKey = null } = {}) {
    super(null, 'US Stock Earnings');
    this.stateRegistry   = stateRegistry;
    this.role            = role;
    this.ownerId         = ownerId;
    this._stateKeyFixed  = stateKey;
    this.growthRate      = growthRate;
    this.rateKey         = rateKey ?? new.target.rateKey;
    this.generatedActionTypes = ['STOCK_EARNINGS_APPLY', 'RECORD_METRIC', 'RECORD_BALANCE'];
  }

  static fromJSON(d, { stateRegistry }) {
    const h = new this({ stateRegistry, role: d.role, ownerId: d.ownerId ?? null, growthRate: d.growthRate ?? 0.05 });
    h.id = d.id;
    return h;
  }

  toJSON() {
    return { ...super.toJSON(), role: this.role, ownerId: this.ownerId, growthRate: this.growthRate };
  }

  call({ state }) {
    const stateKey = this._stateKeyFixed ?? this.stateRegistry.getStateKey(this.role, this.ownerId);
    const { amount, holdingActions } = computeHoldingsGrowth({
      state, stateKey,
      fallbackRate:    this.growthRate,
      fallbackRateKey: this.rateKey,
    });
    if (amount <= 0) return [new RecordBalanceAction(`${stateKey}.balance`, stateKey)];
    return [
      { type: 'STOCK_EARNINGS_APPLY', amount, stateKey },
      ...holdingActions,
      new RecordMetricAction('us_stock_earnings', amount),
      new RecordBalanceAction(`${stateKey}.balance`, stateKey),
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
  static type        = 'IntlAuStockEarningsHandler';
  static eventType   = 'INTL_AU_STOCK_EARNINGS';
  static rateKey     = RATE_KEYS.EQUITY_AU;

  constructor({ stateRegistry, role, ownerId = null, growthRate = 0.06, rateKey = null } = {}) {
    super(null, 'AU Stock Earnings');
    this.stateRegistry = stateRegistry;
    this.role          = role;
    this.ownerId       = ownerId;
    this.growthRate    = growthRate;
    this.rateKey       = rateKey ?? new.target.rateKey;
    this.generatedActionTypes = ['AU_STOCK_EARNINGS_APPLY', 'RECORD_METRIC', 'RECORD_BALANCE'];
  }

  static fromJSON(d, { stateRegistry }) {
    const h = new this({ stateRegistry, role: d.role, ownerId: d.ownerId ?? null, growthRate: d.growthRate ?? 0.06 });
    h.id = d.id;
    return h;
  }

  toJSON() {
    return { ...super.toJSON(), role: this.role, ownerId: this.ownerId, growthRate: this.growthRate };
  }

  call({ state }) {
    const stateKey = this.stateRegistry.getStateKey(this.role, this.ownerId);
    const { amount, holdingActions } = computeHoldingsGrowth({
      state, stateKey,
      fallbackRate:    this.growthRate,
      fallbackRateKey: this.rateKey,
    });
    if (amount <= 0) return [new RecordBalanceAction(`${stateKey}.balance`, stateKey)];
    return [
      { type: 'AU_STOCK_EARNINGS_APPLY', amount },
      ...holdingActions,
      new RecordMetricAction('au_stock_earnings', amount),
      new RecordBalanceAction(`${stateKey}.balance`, stateKey),
    ];
  }
}

/**
 * Handles INTL_AU_STOCK_DIVIDEND events.
 * Computes annual AU stock dividends as: balance × dividendRate.
 * Routes to AU_DIVIDEND_FRANKED_RESIDENT_APPLY (AU resident) or
 * AU_DIVIDEND_FRANKED_NONRESIDENT_APPLY (non-resident) based on the account owner's residency.
 * Assumes fully franked dividends, which is typical for Australian equities.
 */
export class IntlAuStockDividendHandler extends HandlerEntry {
  static description = 'Computes annual AU stock dividends per holding (marketValue × dividendYield, scaled by any active regime dividend adjustment) and routes to the franked-resident or franked-non-resident apply action based on residency.';
  static type        = 'IntlAuStockDividendHandler';
  static eventType   = 'INTL_AU_STOCK_DIVIDEND';
  static rateKey     = RATE_KEYS.EQUITY_AU;

  constructor({ stateRegistry, role, ownerId = null, dividendRate = 0.04, rateKey = null } = {}) {
    super(null, 'AU Stock Dividend');
    this.stateRegistry = stateRegistry;
    this.role          = role;
    this.ownerId       = ownerId;
    this.dividendRate  = dividendRate;
    this.rateKey       = rateKey ?? new.target.rateKey;
    this.generatedActionTypes = [
      'AU_DIVIDEND_FRANKED_RESIDENT_APPLY',
      'AU_DIVIDEND_FRANKED_NONRESIDENT_APPLY',
      'RECORD_METRIC',
      'RECORD_BALANCE',
    ];
  }

  static fromJSON(d, { stateRegistry }) {
    const h = new this({ stateRegistry, role: d.role, ownerId: d.ownerId ?? null, dividendRate: d.dividendRate ?? 0.04, rateKey: d.rateKey ?? null });
    h.id = d.id;
    return h;
  }

  toJSON() {
    return { ...super.toJSON(), role: this.role, ownerId: this.ownerId, dividendRate: this.dividendRate, rateKey: this.rateKey };
  }

  call({ state }) {
    const stateKey = this.stateRegistry.getStateKey(this.role, this.ownerId);
    // Per-holding dividends: each sleeve pays holding.dividendYield (falling back
    // to the account-level dividendRate), scaled by the active regime's dividend
    // adjustment for its rate key (design 28 §7). Reinvested into the sleeves via
    // holdingActions, matching the franked-apply reducers' account-level credit.
    const { amount, holdingActions } = computeHoldingsDividends({
      state, stateKey,
      fallbackYield:   this.dividendRate,
      fallbackRateKey: this.rateKey,
    });
    if (amount <= 0) return [new RecordBalanceAction(`${stateKey}.balance`, stateKey)];

    const personKey  = this.ownerId ?? Object.keys(state.people ?? {})[0];
    const residency  = state.people?.[personKey]?.residency ?? null;
    const actionType = residency === 'AUS'
      ? 'AU_DIVIDEND_FRANKED_RESIDENT_APPLY'
      : 'AU_DIVIDEND_FRANKED_NONRESIDENT_APPLY';

    return [
      { type: actionType, amount },
      ...holdingActions,
      new RecordMetricAction('au_stock_dividend', amount),
      new RecordBalanceAction(`${stateKey}.balance`, stateKey),
    ];
  }
}

/**
 * Handles INTL_AU_SAVINGS_INTEREST events (fires monthly).
 *
 * Computes monthly interest as: balance × interestRate ÷ 12, rounded to 2 dp.
 * Emits AU_SAVINGS_EARNINGS_APPLY (registered by AuAccountModule).
 *
 * @param {object} [opts]
 * @param {import('../services/state-registry.js').StateRegistry} opts.stateRegistry
 * @param {string} opts.role       - ACCOUNT_ROLES value for the AU savings account
 * @param {string} [opts.ownerId]  - Person id (null = any owner)
 * @param {number} [opts.interestRate=0.045]
 */
export class AuSavingsInterestHandler extends HandlerEntry {
  static description = 'Computes monthly interest on the AU savings account (balance × rate ÷ 12) and emits AU_SAVINGS_EARNINGS_APPLY (credited by AuAccountModule).';
  static type        = 'AuSavingsInterestHandler';
  static eventType   = 'INTL_AU_SAVINGS_INTEREST';
  static rateKey     = RATE_KEYS.SAVINGS_AU;

  constructor({ stateRegistry, role, ownerId = null, interestRate = 0.045, rateKey = null } = {}) {
    super(null, 'AU Savings Interest');
    this.stateRegistry = stateRegistry;
    this.role          = role;
    this.ownerId       = ownerId;
    this.interestRate  = interestRate;
    this.rateKey       = rateKey ?? new.target.rateKey;
    this.generatedActionTypes = ['AU_SAVINGS_EARNINGS_APPLY', 'RECORD_METRIC', 'RECORD_BALANCE'];
  }

  static fromJSON(d, { stateRegistry }) {
    const h = new this({ stateRegistry, role: d.role, ownerId: d.ownerId ?? null, interestRate: d.interestRate ?? 0.045 });
    h.id = d.id;
    return h;
  }

  toJSON() {
    return { ...super.toJSON(), role: this.role, ownerId: this.ownerId, interestRate: this.interestRate };
  }

  call({ state }) {
    const stateKey = this.stateRegistry.getStateKey(this.role, this.ownerId);
    const { amount, holdingActions } = computeHoldingsGrowth({
      state, stateKey,
      fallbackRate:    this.interestRate,
      fallbackRateKey: this.rateKey,
      rateSource:      'effectiveInterestRates',
      factor:          1 / 12,
    });
    if (amount <= 0) return [new RecordBalanceAction(`${stateKey}.balance`, stateKey)];
    return [
      { type: 'AU_SAVINGS_EARNINGS_APPLY', amount, residency: state.people?.[this.ownerId ?? Object.keys(state.people ?? {})[0]]?.residency ?? null },
      ...holdingActions,
      new RecordMetricAction('au_savings_interest', amount),
      new RecordBalanceAction(`${stateKey}.balance`, stateKey),
    ];
  }
}

/**
 * Handles INTL_AU_FIXED_INCOME_INTEREST events (fires monthly).
 *
 * Computes monthly interest as: balance × interestRate ÷ 12, rounded to 2 dp.
 * Emits AU_FIXED_INCOME_EARNINGS_APPLY.
 *
 * @param {object} [opts]
 * @param {import('../services/state-registry.js').StateRegistry} opts.stateRegistry
 * @param {string} opts.role       - ACCOUNT_ROLES value for the AU fixed income account
 * @param {string} [opts.ownerId]  - Person id (null = any owner)
 * @param {number} [opts.interestRate=0.04]
 */
export class AuFixedIncomeInterestMonthlyHandler extends HandlerEntry {
  static description = 'Computes monthly interest on the AU fixed income account (balance × rate ÷ 12) and emits AU_FIXED_INCOME_EARNINGS_APPLY.';
  static type        = 'AuFixedIncomeInterestMonthlyHandler';
  static eventType   = 'INTL_AU_FIXED_INCOME_INTEREST';
  static rateKey     = RATE_KEYS.FIXED_INCOME_AU;

  constructor({ stateRegistry, role, ownerId = null, interestRate = 0.04, rateKey = null } = {}) {
    super(null, 'AU Fixed Income Interest');
    this.stateRegistry = stateRegistry;
    this.role          = role;
    this.ownerId       = ownerId;
    this.interestRate  = interestRate;
    this.rateKey       = rateKey ?? new.target.rateKey;
    this.generatedActionTypes = ['AU_FIXED_INCOME_EARNINGS_APPLY', 'RECORD_METRIC', 'RECORD_BALANCE'];
  }

  static fromJSON(d, { stateRegistry }) {
    const h = new this({ stateRegistry, role: d.role, ownerId: d.ownerId ?? null, interestRate: d.interestRate ?? 0.04 });
    h.id = d.id;
    return h;
  }

  toJSON() {
    return { ...super.toJSON(), role: this.role, ownerId: this.ownerId, interestRate: this.interestRate };
  }

  call({ state }) {
    const stateKey = this.stateRegistry.getStateKey(this.role, this.ownerId);
    const { amount, holdingActions } = computeHoldingsGrowth({
      state, stateKey,
      fallbackRate:    this.interestRate,
      fallbackRateKey: this.rateKey,
      rateSource:      'effectiveInterestRates',
      factor:          1 / 12,
    });
    if (amount <= 0) return [new RecordBalanceAction(`${stateKey}.balance`, stateKey)];
    return [
      { type: 'AU_FIXED_INCOME_EARNINGS_APPLY', amount, residency: state.people?.[this.ownerId ?? Object.keys(state.people ?? {})[0]]?.residency ?? null },
      ...holdingActions,
      new RecordMetricAction('au_fixed_income_interest', amount),
      new RecordBalanceAction(`${stateKey}.balance`, stateKey),
    ];
  }
}

/**
 * Handles INTL_FIXED_INCOME_INTEREST events (fires monthly).
 *
 * Computes monthly interest as: balance × interestRate ÷ 12, rounded to 2 dp.
 * Emits FIXED_INCOME_EARNINGS_APPLY (registered by UsAccountModule).
 *
 * @param {object} [opts]
 * @param {import('../services/state-registry.js').StateRegistry} opts.stateRegistry
 * @param {string} opts.role       - ACCOUNT_ROLES value for the fixed income account
 * @param {string} [opts.ownerId]  - Person id (null = any owner)
 * @param {number} [opts.interestRate=0.04]
 */
export class FixedIncomeInterestHandler extends HandlerEntry {
  static description = 'Computes monthly interest on the fixed income account (balance × rate ÷ 12) and emits FIXED_INCOME_EARNINGS_APPLY (credited by UsAccountModule).';
  static type        = 'FixedIncomeInterestHandler';
  static eventType   = 'INTL_FIXED_INCOME_INTEREST';
  static rateKey     = RATE_KEYS.FIXED_INCOME_US;

  constructor({ stateRegistry, role, ownerId = null, interestRate = 0.04, rateKey = null } = {}) {
    super(null, 'Fixed Income Interest');
    this.stateRegistry = stateRegistry;
    this.role          = role;
    this.ownerId       = ownerId;
    this.interestRate  = interestRate;
    this.rateKey       = rateKey ?? new.target.rateKey;
    this.generatedActionTypes = ['FIXED_INCOME_EARNINGS_APPLY', 'RECORD_METRIC', 'RECORD_BALANCE'];
  }

  static fromJSON(d, { stateRegistry }) {
    const h = new this({ stateRegistry, role: d.role, ownerId: d.ownerId ?? null, interestRate: d.interestRate ?? 0.04 });
    h.id = d.id;
    return h;
  }

  toJSON() {
    return { ...super.toJSON(), role: this.role, ownerId: this.ownerId, interestRate: this.interestRate };
  }

  call({ state }) {
    const stateKey = this.stateRegistry.getStateKey(this.role, this.ownerId);
    const { amount, holdingActions } = computeHoldingsGrowth({
      state, stateKey,
      fallbackRate:    this.interestRate,
      fallbackRateKey: this.rateKey,
      rateSource:      'effectiveInterestRates',
      factor:          1 / 12,
    });
    if (amount <= 0) return [new RecordBalanceAction(`${stateKey}.balance`, stateKey)];
    return [
      { type: 'FIXED_INCOME_EARNINGS_APPLY', amount, residency: state.people?.[this.ownerId ?? Object.keys(state.people ?? {})[0]]?.residency ?? null },
      ...holdingActions,
      new RecordMetricAction('fixed_income_interest', amount),
      new RecordBalanceAction(`${stateKey}.balance`, stateKey),
    ];
  }
}

/**
 * Handles INTL_SUPER_EARNINGS events.
 *
 * Computes annual earnings as: balance × rate, rounded to 2 dp.
 * data.rate overrides the configured defaultRate for one-off adjustments.
 * Emits SUPER_EARNINGS_APPLY (registered by AuAccountModule).
 *
 * @param {object} [opts]
 * @param {import('../services/state-registry.js').StateRegistry} opts.stateRegistry
 * @param {string} opts.role       - ACCOUNT_ROLES value for the super account
 * @param {string} [opts.ownerId]  - Person id (null = any owner)
 * @param {number} [opts.defaultRate=0.07]
 */
export class SuperEarningsHandler extends HandlerEntry {
  static description = 'Computes annual earnings on the superannuation account and emits SUPER_EARNINGS_APPLY (credited by AuAccountModule).';
  static type        = 'SuperEarningsHandler';
  static eventType   = 'INTL_SUPER_EARNINGS';
  static rateKey     = RATE_KEYS.EQUITY_AU;

  constructor({ stateRegistry, role, ownerId = null, defaultRate = 0.07, rateKey = null } = {}) {
    super(null, 'Super Earnings');
    this.stateRegistry = stateRegistry;
    this.role          = role;
    this.ownerId       = ownerId;
    this.defaultRate   = defaultRate;
    this.rateKey       = rateKey ?? new.target.rateKey;
    this.generatedActionTypes = ['SUPER_EARNINGS_APPLY', 'RECORD_METRIC', 'RECORD_BALANCE'];
  }

  static fromJSON(d, { stateRegistry }) {
    const h = new this({ stateRegistry, role: d.role, ownerId: d.ownerId ?? null, defaultRate: d.defaultRate ?? 0.07 });
    h.id = d.id;
    return h;
  }

  toJSON() {
    return { ...super.toJSON(), role: this.role, ownerId: this.ownerId, defaultRate: this.defaultRate };
  }

  call({ data, state }) {
    const stateKey = this.stateRegistry.getStateKey(this.role, this.ownerId);
    const { amount, holdingActions } = computeHoldingsGrowth({
      state, stateKey,
      // data.rate is a one-off override that bypasses the effective-rate map.
      rateOverride:    data?.rate ?? null,
      fallbackRate:    this.defaultRate,
      fallbackRateKey: this.rateKey,
    });
    if (amount <= 0) return [new RecordBalanceAction(`${stateKey}.balance`, stateKey)];
    return [
      { type: 'SUPER_EARNINGS_APPLY', amount, stateKey },
      ...holdingActions,
      new RecordMetricAction('super_earnings', amount),
      new RecordBalanceAction(`${stateKey}.balance`, stateKey),
    ];
  }
}
