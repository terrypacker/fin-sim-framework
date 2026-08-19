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
import { computeHoldingsDividends } from '../holdings/holdings-earnings.js';

/**
 * Handles DIVIDEND_SCHEDULED events.
 *
 * Computes the dividend amount per holding as:
 *   Σ holding.marketValue × (holding.dividendYield ?? dividendRate)
 *           × (1 + state.effectiveDividendAdjustments[holding.rateKey])
 * (single-holding accounts collapse to balance × dividendRate × (1 + adj)).
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
 * @param {string} [opts.rateKey]  - Rate key for regime dividend adjustment lookup
 */
export class DividendScheduledHandler extends HandlerEntry {
  static description = 'Computes stock dividends from balance × dividendRate (scaled by any active regime dividend adjustment) and routes to STOCK_DIVIDEND_APPLY (reinvest) or STOCK_DIVIDEND_CASH_APPLY (cash payout).';
  static type        = 'DividendScheduledHandler';
  static eventType   = 'DIVIDEND_SCHEDULED';
  static rateKey     = RATE_KEYS.EQUITY_US;

  constructor({ stateRegistry, role, ownerId = null, stateKey = null, dividendRate = 0.02, reinvest = false, rateKey = null } = {}) {
    super(null, 'Dividend Scheduled');
    this.stateRegistry   = stateRegistry;
    this.role            = role;
    this.ownerId         = ownerId;
    this._stateKeyFixed  = stateKey;
    this.dividendRate    = dividendRate;
    this.reinvest        = reinvest;
    this.rateKey         = rateKey ?? new.target.rateKey;
    // Declares both branches; actual type chosen at runtime based on reinvest flag
    this.generatedActionTypes = ['STOCK_DIVIDEND_APPLY', 'STOCK_DIVIDEND_CASH_APPLY', 'RECORD_METRIC', 'RECORD_BALANCE'];
  }

  static fromJSON(d, { stateRegistry }) {
    const h = new this({ stateRegistry, role: d.role, ownerId: d.ownerId ?? null, stateKey: d.stateKey ?? null, dividendRate: d.dividendRate ?? 0.02, reinvest: d.reinvest ?? false, rateKey: d.rateKey ?? null });
    h.id = d.id;
    return h;
  }

  toJSON() {
    // stateKey pins the account (see earnings-handlers.js): without it in the
    // serialized form, a saved scenario reloads resolving by role+owner again.
    return { ...super.toJSON(), role: this.role, ownerId: this.ownerId, stateKey: this._stateKeyFixed, dividendRate: this.dividendRate, reinvest: this.reinvest, rateKey: this.rateKey };
  }

  call({ data, state }) {
    const stateKey = this._stateKeyFixed ?? this.stateRegistry.getStateKey(this.role, this.ownerId);
    // Per-holding dividends: each sleeve pays holding.dividendYield (falling back
    // to the account-level dividendRate), scaled by the active regime's dividend
    // adjustment for its rate key (design 28 §7).
    const { amount } = computeHoldingsDividends({
      state, stateKey,
      fallbackYield:   this.dividendRate,
      fallbackRateKey: this.rateKey,
    });
    if (amount <= 0) return [new RecordBalanceAction(`${stateKey}.balance`, stateKey)];

    const reinvest   = data?.reinvest ?? this.reinvest;
    const account    = state[stateKey];
    const residency  = account?.ownerId
      ? (state.people?.[account.ownerId]?.residency ?? null)
      : null;
    const actionType = reinvest ? 'STOCK_DIVIDEND_APPLY' : 'STOCK_DIVIDEND_CASH_APPLY';

    return [
      { type: actionType, amount, residency, stateKey },
      new RecordMetricAction('dividends', amount),
      new RecordBalanceAction(`${stateKey}.balance`, stateKey),
    ];
  }
}
