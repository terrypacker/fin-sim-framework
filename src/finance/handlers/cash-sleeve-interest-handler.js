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
import { computeHoldingsCashInterest } from '../holdings/holdings-earnings.js';

/**
 * Handles CASH_SLEEVE_INTEREST events (design 60) — money-market yield on the
 * CASH sleeve of an *equity-served* account (brokerage / retirement / super).
 *
 * These accounts are driven by the equity-growth earnings handler, which (post
 * design-59 follow-up) applies no return to CASH. This monthly stream credits the
 * cash sleeve at the account's country savings rate (reused from
 * `effectiveInterestRates`, so it responds to regimes + per-account overrides),
 * compounding it via reinvestment. Savings/offset/fixed-income accounts already
 * have their own interest handlers and are NOT wired here (no double-count).
 *
 * Emits CASH_SLEEVE_INTEREST_APPLY (credit + reinvest) carrying a `taxMode`:
 *   - 'us'       → US ordinary income (federal + state), AU-FITO aware when AU-resident
 *   - 'au'       → AU ordinary income (chains AU_SAVINGS_EARNINGS_TAX)
 *   - 'deferred' → tax-deferred/free wrapper (401k/IRA/Roth/super): balance only, no tax
 *
 * @param {object} opts
 * @param {import('../services/state-registry.js').StateRegistry} opts.stateRegistry
 * @param {string} opts.role          - ACCOUNT_ROLES value for the account
 * @param {string} [opts.ownerId]     - Person id (null = any owner)
 * @param {string} [opts.stateKey]    - Specific account this handler accrues to
 * @param {number} [opts.interestRate=0.03] - Fallback annual rate when the map has no entry
 * @param {string} [opts.rateKey]     - SAVINGS_US / SAVINGS_AU key into effectiveInterestRates
 * @param {'us'|'au'|'deferred'} [opts.taxMode='us'] - Tax treatment of the interest
 */
export class CashSleeveInterestHandler extends HandlerEntry {
  static description = 'Computes monthly money-market interest on an equity-served account\'s CASH sleeve (Σ marketValue × savings rate ÷ 12) and dispatches CASH_SLEEVE_INTEREST_APPLY with the account\'s taxMode (us / au / deferred).';
  static type        = 'CashSleeveInterestHandler';
  static eventType   = 'CASH_SLEEVE_INTEREST';
  static rateKey     = RATE_KEYS.SAVINGS_US;

  constructor({ stateRegistry, role, ownerId = null, stateKey = null, interestRate = 0.03, rateKey = null, taxMode = 'us' } = {}) {
    super(null, 'Cash Sleeve Interest');
    this.stateRegistry  = stateRegistry;
    this.role           = role;
    this.ownerId        = ownerId;
    this._stateKeyFixed = stateKey;
    this.interestRate   = interestRate;
    this.rateKey        = rateKey ?? new.target.rateKey;
    this.taxMode        = taxMode;
    this.generatedActionTypes = ['CASH_SLEEVE_INTEREST_APPLY', 'RECORD_METRIC', 'RECORD_BALANCE'];
  }

  static fromJSON(d, { stateRegistry }) {
    const h = new this({
      stateRegistry, role: d.role, ownerId: d.ownerId ?? null, stateKey: d.stateKey ?? null,
      interestRate: d.interestRate ?? 0.03, rateKey: d.rateKey ?? null, taxMode: d.taxMode ?? 'us',
    });
    h.id = d.id;
    return h;
  }

  toJSON() {
    return {
      ...super.toJSON(), role: this.role, ownerId: this.ownerId, stateKey: this._stateKeyFixed,
      interestRate: this.interestRate, rateKey: this.rateKey, taxMode: this.taxMode,
    };
  }

  call({ state }) {
    const stateKey = this._stateKeyFixed ?? this.stateRegistry.getStateKey(this.role, this.ownerId);
    const { amount, holdingActions } = computeHoldingsCashInterest({
      state, stateKey, rateKey: this.rateKey, fallbackRate: this.interestRate, factor: 1 / 12,
    });
    if (amount <= 0) return [new RecordBalanceAction(`${stateKey}.balance`, stateKey)];

    const account   = state[stateKey];
    const residency = account?.ownerId
      ? (state.people?.[account.ownerId]?.residency ?? null)
      : (state.people?.[Object.keys(state.people ?? {})[0]]?.residency ?? null);

    return [
      { type: 'CASH_SLEEVE_INTEREST_APPLY', amount, stateKey, taxMode: this.taxMode, residency },
      ...holdingActions,
      new RecordMetricAction('cash_sleeve_interest', amount),
      new RecordBalanceAction(`${stateKey}.balance`, stateKey),
    ];
  }
}
