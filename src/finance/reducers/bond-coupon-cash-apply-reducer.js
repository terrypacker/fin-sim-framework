/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { Reducer, PRIORITY } from '../../simulation-framework/reducers.js';
import { ACCOUNT_ROLES } from '../state/account-roles.js';

/**
 * Handles BOND_COUPON_CASH_APPLY actions (cash payout path) — design 59.
 *
 * Credits the coupon amount to the US savings account (resolved via StateRegistry),
 * then chains BOND_COUPON_TAX { amount, stateTaxableAmount, residency } so the tax
 * modules can classify it: `amount` is the full coupon (federal ordinary income),
 * `stateTaxableAmount` is the coupon excluding Treasury holdings (US state ordinary
 * income), since direct U.S. Treasury interest is state-exempt (31 U.S.C. § 3124).
 *
 * The reinvest path (BOND_COUPON_APPLY) is handled by BondCouponApplyReducer and
 * does not pass through this reducer — it credits the account directly.
 *
 * @param {object} opts
 * @param {import('../../finance/services/account-service.js').AccountService} opts.accountService
 * @param {import('../services/state-registry.js').StateRegistry} opts.stateRegistry
 * @param {string} [opts.role=ACCOUNT_ROLES.US_SAVINGS]
 * @param {string|null} [opts.ownerId=null]
 */
export class BondCouponCashApplyReducer extends Reducer {
  static description = 'Credits bond coupon cash payout to the savings account and chains BOND_COUPON_TAX (federal + state, with the Treasury-exempt split).';
  static type        = 'BondCouponCashApplyReducer';
  static actionType  = 'BOND_COUPON_CASH_APPLY';

  constructor({ accountService, stateRegistry, role = ACCOUNT_ROLES.US_SAVINGS, ownerId = null } = {}) {
    super('Bond Coupon Cash Apply', PRIORITY.CASH_FLOW);
    this.accountService  = accountService;
    this.stateRegistry   = stateRegistry;
    this.role            = role;
    this.ownerId         = ownerId;
    this.reducedActionTypes   = ['BOND_COUPON_CASH_APPLY'];
    this.generatedActionTypes = ['BOND_COUPON_TAX'];
  }

  static fromJSON(d, { accountService, stateRegistry }) {
    const r = new this({ accountService, stateRegistry, role: d.role ?? ACCOUNT_ROLES.US_SAVINGS, ownerId: d.ownerId ?? null });
    r.id = d.id;
    return r;
  }

  toJSON() {
    return { ...super.toJSON(), role: this.role, ownerId: this.ownerId };
  }

  reduce(state, action, date) {
    const { amount, federalTaxableAmount, stateTaxableAmount, residency } = action;
    const key = this.stateRegistry.getStateKey(this.role, this.ownerId);
    this.accountService.transaction(state[key], amount, date);
    return this.newState(state, {}, [{ type: 'BOND_COUPON_TAX', amount, federalTaxableAmount, stateTaxableAmount, residency, stateKey: key }]);
  }
}
