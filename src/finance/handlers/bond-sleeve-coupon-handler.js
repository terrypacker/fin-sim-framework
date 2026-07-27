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
import { computeHoldingsCoupons } from '../holdings/holdings-earnings.js';

/**
 * Handles BOND_SLEEVE_COUPON events — coupon interest on the BOND sleeve of an
 * *equity-served* account (IRA / 401k / Roth / super / au-stock).
 *
 * Sibling of {@link CashSleeveInterestHandler} (design 60), which closed the same
 * gap for CASH sleeves. These accounts are driven by the equity-growth earnings
 * handler, which (design 53 §4 / design 59 follow-up) applies NO return to BOND
 * holdings — a bond's return is its coupon, not equity appreciation. The dedicated
 * coupon stream `INTL_BOND_COUPON` (BondCouponScheduledHandler) is wired for
 * US_STOCK brokerage accounts only, so a BOND sleeve established in any other
 * equity-served account (routinely, via the design-61 allocation lever) earned
 * nothing. This stream credits those sleeves their coupon, always REINVESTING it
 * into the sleeve (a deferred/foreign wrapper's coupon must stay inside the
 * wrapper — it never pays out to a taxable cash account).
 *
 * Coupon per holding is `marketValue × (couponRate ?? fallbackRate)` — a fixed
 * contractual coupon, NOT regime-rate-adjusted (design 53 §4); design-61 sleeves
 * carry a null `couponRate` and fall back to this handler's per-account rate.
 *
 * Emits BOND_SLEEVE_COUPON_APPLY (credit + reinvest) carrying a `taxMode`:
 *   - 'us'       → US ordinary income (federal + state, Treasury-exempt split),
 *                  AU-FITO aware when AU-resident — via the shared BOND_COUPON_TAX
 *                  chain. Present for symmetry/completeness; no account is wired
 *                  with it today (US_STOCK bonds use INTL_BOND_COUPON instead).
 *   - 'au'       → AU ordinary income (chains AU_SAVINGS_EARNINGS_TAX)
 *   - 'deferred' → tax-deferred/free wrapper (401k/IRA/Roth/super): balance only,
 *                  taxed (or not, for Roth) on the eventual withdrawal.
 *
 * @param {object} opts
 * @param {import('../services/state-registry.js').StateRegistry} opts.stateRegistry
 * @param {string} opts.role          - ACCOUNT_ROLES value for the account
 * @param {string} [opts.ownerId]     - Person id (null = any owner)
 * @param {string} [opts.stateKey]    - Specific account this handler accrues to
 * @param {number} [opts.couponRate=0.04] - Fallback coupon used when a BOND holding has none
 * @param {'us'|'au'|'deferred'} [opts.taxMode='deferred'] - Tax treatment of the coupon
 */
export class BondSleeveCouponHandler extends HandlerEntry {
  static description = 'Computes coupon interest on an equity-served account\'s BOND sleeve (Σ marketValue × couponRate), reinvests it, and dispatches BOND_SLEEVE_COUPON_APPLY with the account\'s taxMode (us / au / deferred).';
  static type        = 'BondSleeveCouponHandler';
  static eventType   = 'BOND_SLEEVE_COUPON';
  // Carried for serialization symmetry only — coupons use holding.couponRate (or the
  // per-account fallback) directly and are NOT regime-rate-keyed (design 53 §4).
  static rateKey     = RATE_KEYS.FIXED_INCOME_US;

  constructor({ stateRegistry, role, ownerId = null, stateKey = null, couponRate = 0.04, rateKey = null, taxMode = 'deferred' } = {}) {
    super(null, 'Bond Sleeve Coupon');
    this.stateRegistry  = stateRegistry;
    this.role           = role;
    this.ownerId        = ownerId;
    this._stateKeyFixed = stateKey;
    this.couponRate     = couponRate;
    this.rateKey        = rateKey ?? new.target.rateKey;
    this.taxMode        = taxMode;
    this.generatedActionTypes = ['BOND_SLEEVE_COUPON_APPLY', 'RECORD_METRIC', 'RECORD_BALANCE'];
  }

  static fromJSON(d, { stateRegistry }) {
    const h = new this({
      stateRegistry, role: d.role, ownerId: d.ownerId ?? null, stateKey: d.stateKey ?? null,
      couponRate: d.couponRate ?? 0.04, rateKey: d.rateKey ?? null, taxMode: d.taxMode ?? 'deferred',
    });
    h.id = d.id;
    return h;
  }

  toJSON() {
    return {
      ...super.toJSON(), role: this.role, ownerId: this.ownerId, stateKey: this._stateKeyFixed,
      couponRate: this.couponRate, rateKey: this.rateKey, taxMode: this.taxMode,
    };
  }

  call({ state }) {
    const stateKey = this._stateKeyFixed ?? this.stateRegistry.getStateKey(this.role, this.ownerId);
    const { amount, stateTaxableAmount, holdingActions } = computeHoldingsCoupons({
      state, stateKey, fallbackRate: this.couponRate,
    });
    if (amount <= 0) return [new RecordBalanceAction(`${stateKey}.balance`, stateKey)];

    const account   = state[stateKey];
    const residency = account?.ownerId
      ? (state.people?.[account.ownerId]?.residency ?? null)
      : (state.people?.[Object.keys(state.people ?? {})[0]]?.residency ?? null);

    return [
      { type: 'BOND_SLEEVE_COUPON_APPLY', amount, stateTaxableAmount, stateKey, taxMode: this.taxMode, residency },
      ...holdingActions,
      new RecordMetricAction('bond_coupons', amount),
      new RecordBalanceAction(`${stateKey}.balance`, stateKey),
    ];
  }
}
