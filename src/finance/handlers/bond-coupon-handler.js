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
 * Handles INTL_BOND_COUPON events (design 59).
 *
 * Computes coupon interest on the account's BOND holdings as:
 *   Σ holding.marketValue × (holding.couponRate ?? couponRate)
 * (a fixed contractual coupon — NOT regime-adjusted, design 53 §4). Branches on
 * the reinvest flag:
 *
 *   reinvest=true  → BOND_COUPON_APPLY      (credits the account balance + holdings,
 *                                            chains BOND_COUPON_TAX)
 *   reinvest=false → BOND_COUPON_CASH_APPLY (credits the US savings account,
 *                                            chains BOND_COUPON_TAX)
 *
 * The action carries BOTH `amount` (full coupon → federal ordinary income) and
 * `stateTaxableAmount` (coupon excluding `treasury` holdings → US state ordinary
 * income), since direct U.S. Treasury interest is federally taxable but
 * state-exempt (31 U.S.C. § 3124).
 *
 * data.reinvest overrides the configured reinvest param for one-off events.
 *
 * @param {object} [opts]
 * @param {import('../services/state-registry.js').StateRegistry} opts.stateRegistry
 * @param {string} opts.role         - ACCOUNT_ROLES value for the (us-stock) account
 * @param {string} [opts.ownerId]    - Person id (null = any owner)
 * @param {string} [opts.stateKey]   - Specific account this handler accrues to
 * @param {number} [opts.couponRate=0.04] - Fallback coupon used when a BOND holding has none
 * @param {boolean} [opts.reinvest=false]
 * @param {string} [opts.rateKey]
 */
export class BondCouponScheduledHandler extends HandlerEntry {
  static description = 'Computes coupon interest on an account\'s BOND holdings (Σ marketValue × couponRate) and routes to BOND_COUPON_APPLY (reinvest) or BOND_COUPON_CASH_APPLY (cash payout), carrying the full (federal) and state-taxable (non-Treasury) amounts.';
  static type        = 'BondCouponScheduledHandler';
  static eventType   = 'INTL_BOND_COUPON';
  // Carried for serialization symmetry only — coupons use holding.couponRate
  // directly and are NOT regime-rate-keyed (design 53 §4), so this is not consulted.
  static rateKey     = RATE_KEYS.FIXED_INCOME_US;

  constructor({ stateRegistry, role, ownerId = null, stateKey = null, couponRate = 0.04, reinvest = false, rateKey = null } = {}) {
    super(null, 'Bond Coupon');
    this.stateRegistry   = stateRegistry;
    this.role            = role;
    this.ownerId         = ownerId;
    this._stateKeyFixed  = stateKey;
    this.couponRate      = couponRate;
    this.reinvest        = reinvest;
    this.rateKey         = rateKey ?? new.target.rateKey;
    // Declares both branches; actual type chosen at runtime based on reinvest flag.
    this.generatedActionTypes = ['BOND_COUPON_APPLY', 'BOND_COUPON_CASH_APPLY', 'RECORD_METRIC', 'RECORD_BALANCE'];
  }

  static fromJSON(d, { stateRegistry }) {
    const h = new this({
      stateRegistry, role: d.role, ownerId: d.ownerId ?? null, stateKey: d.stateKey ?? null,
      couponRate: d.couponRate ?? 0.04, reinvest: d.reinvest ?? false, rateKey: d.rateKey ?? null,
    });
    h.id = d.id;
    return h;
  }

  toJSON() {
    return {
      ...super.toJSON(), role: this.role, ownerId: this.ownerId, stateKey: this._stateKeyFixed,
      couponRate: this.couponRate, reinvest: this.reinvest, rateKey: this.rateKey,
    };
  }

  call({ data, state }) {
    const stateKey = this._stateKeyFixed ?? this.stateRegistry.getStateKey(this.role, this.ownerId);
    const { amount, stateTaxableAmount } = computeHoldingsCoupons({
      state, stateKey, fallbackRate: this.couponRate,
    });
    if (amount <= 0) return [new RecordBalanceAction(`${stateKey}.balance`, stateKey)];

    const reinvest   = data?.reinvest ?? this.reinvest;
    const account    = state[stateKey];
    const residency  = account?.ownerId
      ? (state.people?.[account.ownerId]?.residency ?? null)
      : null;
    const actionType = reinvest ? 'BOND_COUPON_APPLY' : 'BOND_COUPON_CASH_APPLY';

    return [
      { type: actionType, amount, stateTaxableAmount, residency, stateKey },
      new RecordMetricAction('bond_coupons', amount),
      new RecordBalanceAction(`${stateKey}.balance`, stateKey),
    ];
  }
}
