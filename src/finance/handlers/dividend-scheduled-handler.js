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
import { RecordBalanceAction } from '../../simulation-framework/actions.js';
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
 * data.reinvest overrides the configured reinvest param for one-off events, and
 * `state[stateKey].reinvestDividends` — the account's own election (design 106) —
 * overrides the configured param for every event on that account.
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

  constructor({ stateRegistry, role, ownerId = null, stateKey = null, dividendRate = null, reinvest = false, rateKey = null } = {}) {
    super(null, 'Dividend Scheduled');
    this.stateRegistry   = stateRegistry;
    this.role            = role;
    this.ownerId         = ownerId;
    this._stateKeyFixed  = stateKey;
    this.dividendRate    = dividendRate;
    this.reinvest        = reinvest;
    this.rateKey         = rateKey ?? new.target.rateKey;
    // Declares both branches; actual type chosen at runtime based on reinvest flag
    this.generatedActionTypes = ['STOCK_DIVIDEND_APPLY', 'STOCK_DIVIDEND_CASH_APPLY', 'RECORD_BALANCE'];
  }

  static fromJSON(d, { stateRegistry }) {
    const h = new this({ stateRegistry, role: d.role, ownerId: d.ownerId ?? null, stateKey: d.stateKey ?? null, dividendRate: d.dividendRate ?? null, reinvest: d.reinvest ?? false, rateKey: d.rateKey ?? null });
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
    const { amount, bySecurity } = computeHoldingsDividends({
      state, stateKey,
      fallbackYield:   this.dividendRate,
      fallbackRateKey: this.rateKey,
    });
    if (amount <= 0) return [new RecordBalanceAction(`${stateKey}.balance`, stateKey)];

    const account    = state[stateKey];
    // Design 106 §4 — precedence: a one-off event's own `data.reinvest`, then THIS
    // ACCOUNT's election (a broker's DRIP setting, projected into state from the account
    // record), then the household default this handler was built with. Read from state
    // rather than captured at construction so a scenario loaded from a save — whose
    // handlers come back from JSON, not from the toolset — honours the account's
    // election without a Rebuild.
    const accountElection = data?.reinvest ?? account?.reinvestDividends ?? this.reinvest;
    const residency  = account?.ownerId
      ? (state.people?.[account.ownerId]?.residency ?? null)
      : null;

    // Design 106 §5 (step 2b) — the election is per (account × security). The account's
    // answer is the default; `reinvestDividendsBySecurity` overrides it for the
    // instruments it names, which is how a broker's DRIP setting actually works. A one-off
    // event's `data.reinvest` still outranks everything: it is an instruction about THIS
    // payment, not a standing election.
    const bySec = (data?.reinvest == null ? account?.reinvestDividendsBySecurity : null) ?? null;
    const electionFor = (securityId) => {
      const v = bySec?.[securityId];
      return typeof v === 'boolean' ? v : accountElection;
    };

    // Partition the payment. `bySecurity` is empty only when the account has no lots —
    // the whole-account fallback — in which case the account election decides all of it.
    const reinvested = [];
    let reinvestAmount = 0, cashAmount = 0;
    if (bySecurity.length === 0) {
      if (accountElection) reinvestAmount = amount; else cashAmount = amount;
    } else {
      for (const slice of bySecurity) {
        if (electionFor(slice.securityId)) { reinvested.push(slice); reinvestAmount += slice.amount; }
        else cashAmount += slice.amount;
      }
      reinvestAmount = +reinvestAmount.toFixed(2);
      cashAmount     = +cashAmount.toFixed(2);
    }

    // Up to TWO apply actions for one economic event, which is new: before 2b a dividend
    // went one way or the other in its entirety. Both chain STOCK_DIVIDEND_TAX, so the
    // assessed total is unchanged by the split — `Σ tax == amount` is the invariant, and
    // any journal rollup over this event must filter on `entry.reducer` before summing or
    // it will count the payment twice (the AU_TAX_SETTLE_APPLY trap).
    const actions = [];
    if (reinvestAmount !== 0) {
      // `_bySecurity` tells the reducer which instrument each slice came from, so the
      // money buys more of that instrument (step 2a).
      actions.push({ type: 'STOCK_DIVIDEND_APPLY', amount: reinvestAmount, residency, stateKey,
                     ...(reinvested.length ? { _bySecurity: reinvested } : {}) });
    }
    if (cashAmount !== 0) {
      // The cash branch needs no breakdown — the money leaves the account.
      actions.push({ type: 'STOCK_DIVIDEND_CASH_APPLY', amount: cashAmount, residency, stateKey });
    }
    actions.push(new RecordBalanceAction(`${stateKey}.balance`, stateKey));
    return actions;
  }
}
