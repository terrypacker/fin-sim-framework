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
import { mergeCouponReinvestLots } from '../holdings/holdings-earnings.js';

/**
 * Handles BOND_SLEEVE_COUPON_APPLY actions — coupon interest on the BOND sleeve of
 * an equity-served account (IRA / 401k / Roth / super / au-stock).
 *
 * Sibling of {@link CashSleeveInterestApplyReducer} (design 60). Credits `amount`
 * to the account balance (the paired HoldingTransactActions the handler emits
 * reinvest the coupon into the BOND holding and re-sync the balance to the same
 * value, so this reducer only bumps the scalar — mirroring StockEarningsApplyReducer).
 * Then applies tax by `taxMode`:
 *
 *   - 'deferred' → tax-deferred/free wrapper (401k/IRA/Roth/super): balance only,
 *                  no immediate tax; the eventual withdrawal taxes the grown balance.
 *   - 'au'       → chains AU_SAVINGS_EARNINGS_TAX { amount, residency } so the AU
 *                  tax module folds the coupon into auOrdinaryIncomeYTD (interest is
 *                  AU ordinary income), matching cash-sleeve interest.
 *   - 'us'       → chains BOND_COUPON_TAX { amount, stateTaxableAmount, residency },
 *                  reusing the design-59 tax path: full coupon is federal ordinary
 *                  income (+NIIT) and, when AU-resident, AU-worldwide relieved by
 *                  FITO; `stateTaxableAmount` (coupon excluding Treasury holdings)
 *                  is the state-taxable portion (31 U.S.C. § 3124). No wired account
 *                  uses 'us' today (US_STOCK bonds use INTL_BOND_COUPON); present for
 *                  symmetry/completeness.
 */
export class BondSleeveCouponApplyReducer extends Reducer {
  static description = 'Credits bond-sleeve coupon interest to an equity-served account and applies tax per the action\'s taxMode (deferred: none / au: AU ordinary / us: BOND_COUPON_TAX federal+state+FITO).';
  static type        = 'BondSleeveCouponApplyReducer';
  static actionType  = 'BOND_SLEEVE_COUPON_APPLY';

  constructor({ accountService, stateRegistry } = {}) {  // deps accepted for API symmetry
    super('Bond Sleeve Coupon Apply', PRIORITY.CASH_FLOW);
    this.reducedActionTypes   = ['BOND_SLEEVE_COUPON_APPLY'];
    this.generatedActionTypes = ['AU_SAVINGS_EARNINGS_TAX', 'BOND_COUPON_TAX'];
  }

  reduce(state, action) {
    const { amount, federalTaxableAmount, stateTaxableAmount, taxMode = 'deferred', residency } = action;
    const key  = action.stateKey;
    const acct = state[key];
    if (!acct || !(amount > 0)) return this.newState(state);

    // §G10b reinvestment risk: reinvest the coupon into a new-vintage BOND lot at the
    // prevailing yield (the handler no longer emits per-source reinvest actions). Sync
    // the balance to Σ marketValue so §4.4 holds. Absent buckets (direct-reduce unit
    // tests / pre-G10b callers) ⇒ credit the scalar balance only (holdings synced
    // elsewhere by the handler's HoldingTransactActions).
    const buckets = action._reinvestBuckets;
    let nextAcct;
    if (Array.isArray(buckets) && buckets.length) {
      const holdings = mergeCouponReinvestLots(acct.holdings ?? [], {
        stateKey: key, buckets, prevailingRate: action._prevailingRate,
        year: action._reinvestYear, purchaseMs: action._reinvestPurchaseMs,
      });
      const balance = +holdings.reduce((s, h) => s + (h?.marketValue ?? 0), 0).toFixed(2);
      nextAcct = { ...acct, holdings, balance };
    } else {
      nextAcct = { ...acct, balance: acct.balance + amount };
    }
    const base = { ...state, [key]: nextAcct };

    if (taxMode === 'deferred') {
      // 401k / IRA / Roth / super — no immediate tax; taxed (or not, for Roth) on withdrawal.
      return this.newState(base);
    }

    if (taxMode === 'au') {
      // AU-source coupon interest → AU ordinary income via the shared AU tax path.
      return this.newState(base, {}, [{ type: 'AU_SAVINGS_EARNINGS_TAX', amount, residency, stateKey: key }]);
    }

    // taxMode === 'us' — route through the design-59 bond-coupon tax classification
    // so the Treasury state-exemption split and FITO relief are applied consistently.
    return this.newState(base, {}, [{ type: 'BOND_COUPON_TAX', amount, federalTaxableAmount, stateTaxableAmount, residency }]);
  }
}
