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
  static type        = 'UsSavingsInterestMonthlyHandler';
  static eventType   = 'US_SAVINGS_INTEREST_MONTHLY';
  static rateKey     = RATE_KEYS.SAVINGS_US;

  constructor({ stateRegistry, role, ownerId = null, interestRate = 0.03, rateKey = null } = {}) {
    super(null, 'Monthly US Savings Interest');
    this.stateRegistry = stateRegistry;
    this.role          = role;
    this.ownerId       = ownerId;
    this.interestRate  = interestRate;
    this.rateKey       = rateKey ?? new.target.rateKey;
    this.generatedActionTypes = ['US_SAVINGS_INTEREST_CREDIT', 'RECORD_METRIC', 'RECORD_BALANCE'];
  }

  static fromJSON(d, { stateRegistry }) {
    const h = new this({ stateRegistry, role: d.role, ownerId: d.ownerId ?? null, interestRate: d.interestRate ?? 0.03 });
    h.id = d.id;
    return h;
  }

  toJSON() {
    return { ...super.toJSON(), role: this.role, ownerId: this.ownerId, interestRate: this.interestRate };
  }

  call({ state }) {
    const stateKey = this.stateRegistry.getStateKey(this.role, this.ownerId);
    const balance  = this.stateRegistry.getAccount(state, this.role, this.ownerId)?.balance ?? 0;
    const rate     = state.effectiveInterestRates?.[this.rateKey] ?? this.interestRate;
    const amount   = +(balance * rate / 12).toFixed(2);
    if (amount <= 0) return [new RecordBalanceAction(`${stateKey}.balance`, stateKey)];
    // US_SAVINGS_INTEREST_CREDIT is reduced via UsSavingsInterestCreditReducer
    // which calls accountService.transaction(). The transaction helper itself
    // maintains the §4.4 holdings invariant for single-holding accounts —
    // emitting HOLDING_TRANSACT here would double-count.
    return [
      { type: 'US_SAVINGS_INTEREST_CREDIT', amount },
      new RecordMetricAction('us_savings_interest', amount),
      new RecordBalanceAction(`${stateKey}.balance`, stateKey),
    ];
  }
}
