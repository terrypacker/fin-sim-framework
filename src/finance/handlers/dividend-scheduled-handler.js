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
 * Handles DIVIDEND_SCHEDULED events.
 *
 * Computes the dividend amount as: stockAccount.balance × dividendRate.
 * Branches on the reinvest flag:
 *
 *   reinvest=true  → STOCK_DIVIDEND_APPLY (handled by UsAccountModule:
 *                    credits balance + contributionBasis + earningsBasis,
 *                    chains STOCK_DIVIDEND_TAX)
 *
 *   reinvest=false → STOCK_DIVIDEND_CASH_APPLY (handled by
 *                    StockDividendCashApplyReducer: credits usSavingsAccount,
 *                    chains STOCK_DIVIDEND_TAX)
 *
 * data.reinvest overrides the configured reinvest param for one-off events.
 *
 * @param {object} [opts]
 * @param {import('../services/state-registry.js').StateRegistry} opts.stateRegistry
 * @param {string} opts.role       - ACCOUNT_ROLES value for the stock account
 * @param {string} [opts.ownerId]  - Person id (null = any owner)
 * @param {number} [opts.dividendRate=0.02]
 * @param {boolean} [opts.reinvest=false]
 */
export class DividendScheduledHandler extends HandlerEntry {
  static description = 'Computes stock dividends from balance × dividendRate and routes to STOCK_DIVIDEND_APPLY (reinvest) or STOCK_DIVIDEND_CASH_APPLY (cash payout).';

  static eventType = 'DIVIDEND_SCHEDULED';

  constructor({ stateRegistry, role, ownerId = null, dividendRate = 0.02, reinvest = false } = {}) {
    super(null, 'Dividend Scheduled');
    this.stateRegistry = stateRegistry;
    this.role          = role;
    this.ownerId       = ownerId;
    this.dividendRate  = dividendRate;
    this.reinvest      = reinvest;
    // Declares both branches; actual type chosen at runtime based on reinvest flag
    this.generatedActionTypes = ['STOCK_DIVIDEND_APPLY', 'STOCK_DIVIDEND_CASH_APPLY', 'RECORD_METRIC', 'RECORD_BALANCE'];
  }

  call({ data, state }) {
    const stateKey = this.stateRegistry.getStateKey(this.role, this.ownerId);
    const balance  = this.stateRegistry.getAccount(state, this.role, this.ownerId)?.balance ?? 0;
    const amount   = +(balance * this.dividendRate).toFixed(2);
    if (amount <= 0) return [new RecordBalanceAction(`${stateKey}.balance`, stateKey)];

    const reinvest     = data?.reinvest ?? this.reinvest;
    const isAuResident = state.isAuResident;
    const actionType   = reinvest ? 'STOCK_DIVIDEND_APPLY' : 'STOCK_DIVIDEND_CASH_APPLY';

    return [
      { type: actionType, amount, isAuResident },
      new RecordMetricAction('dividends', amount),
      new RecordBalanceAction(`${stateKey}.balance`, stateKey),
    ];
  }
}
