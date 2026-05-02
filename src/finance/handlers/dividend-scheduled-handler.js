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
 * @param {string} [opts.accountKey='stockAccount']
 *   State key for the stock account whose balance drives the calculation.
 * @param {number} [opts.dividendRate=0.02]
 *   Annual dividend yield (e.g. 0.02 = 2%).
 * @param {boolean} [opts.reinvest=false]
 *   Default reinvestment flag; data.reinvest overrides per event.
 */
export class DividendScheduledHandler extends HandlerEntry {
  static description = 'Computes stock dividends from balance × dividendRate and routes to STOCK_DIVIDEND_APPLY (reinvest) or STOCK_DIVIDEND_CASH_APPLY (cash payout).';

  static eventType = 'DIVIDEND_SCHEDULED';

  constructor({ accountKey = 'stockAccount', dividendRate = 0.02, reinvest = false } = {}) {
    super(null, 'Dividend Scheduled');
    this.accountKey   = accountKey;
    this.dividendRate = dividendRate;
    this.reinvest     = reinvest;
  }

  call({ data, state }) {
    const balance = state[this.accountKey]?.balance ?? 0;
    const amount  = +(balance * this.dividendRate).toFixed(2);
    if (amount <= 0) return [new RecordBalanceAction()];

    const reinvest     = data?.reinvest ?? this.reinvest;
    const isAuResident = state.isAuResident;
    const actionType   = reinvest ? 'STOCK_DIVIDEND_APPLY' : 'STOCK_DIVIDEND_CASH_APPLY';

    return [
      { type: actionType, amount, isAuResident },
      new RecordMetricAction('dividends', amount),
      new RecordBalanceAction(),
    ];
  }
}
