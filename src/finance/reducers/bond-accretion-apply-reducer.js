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
import { creditDerivedIncome } from '../assets/investment-account.js';
import { scaleHoldings, lotVintage } from '../holdings/holding-utils.js';
import { superFundTaxRateOn } from '../account-rules/au/au-super-classes.js';

/**
 * Handles BOND_ACCRETION_APPLY actions — the imputed, non-cash principal growth of
 * a zero-coupon/OID bond or a TIPS (design 66 §G5 / §G6).
 *
 * Sibling of {@link BondSleeveCouponApplyReducer}. Credits `amount` (the accretion)
 * to the account balance; the paired HoldingTransactActions the handler emits step
 * up the accreting BOND holding's marketValue AND costBasis and re-sync the balance
 * to the same value, so this reducer only bumps the scalar. The basis step-up is
 * what keeps the accreted principal from being taxed a second time as a capital gain
 * when the bond is later redeemed at / sold above the discounted purchase price.
 *
 * Then applies tax by `taxMode`, exactly like the coupon path:
 *   - 'deferred' → 401k / IRA / Roth: balance only, no immediate tax;
 *   - 'super'    → an AU super fund: accretion is the fund's income as it accrues, taxed
 *                  in the fund at 15% (0% in pension phase) and withheld from its
 *                  holdings (design 105 §8);
 *   - 'au'       → chains AU_SAVINGS_EARNINGS_TAX (AU treats OID / indexation as
 *                  ordinary income on accrual);
 *   - 'us'       → chains BOND_COUPON_TAX so the federal (+ NIIT) ordinary-income
 *                  base, the Treasury/muni federal & state split, and FITO relief are
 *                  applied consistently with cash coupons.
 *
 * `amount` may be NEGATIVE — a TIPS principal can index DOWN under deflation, which
 * reduces the balance/basis and (on the 'us'/'au' paths) reduces ordinary income.
 * A zero-coupon OID accretion is always ≥ 0. A no-op accretion (amount 0) never
 * reaches here (the handler short-circuits).
 */
export class BondAccretionApplyReducer extends Reducer {
  static description = 'Credits non-cash bond accretion (zero-coupon OID / TIPS inflation indexation) to an account and applies tax per the action\'s taxMode (deferred: none / au: AU ordinary / us: BOND_COUPON_TAX federal+state+FITO).';
  static type        = 'BondAccretionApplyReducer';
  static actionType  = 'BOND_ACCRETION_APPLY';

  constructor({ accountService, stateRegistry } = {}) {  // deps accepted for API symmetry
    super('Bond Accretion Apply', PRIORITY.CASH_FLOW);
    this.reducedActionTypes   = ['BOND_ACCRETION_APPLY'];
    this.generatedActionTypes = ['AU_SAVINGS_EARNINGS_TAX', 'BOND_COUPON_TAX', 'SUPER_EARNINGS_TAX'];
  }

  reduce(state, action, date) {
    const { amount, federalTaxableAmount, stateTaxableAmount, taxMode = 'deferred', residency } = action;
    const key  = action.stateKey;
    const acct = state[key];
    if (!acct || !amount) return this.newState(state);

    if (taxMode === 'super') {
      // Design 105 §8 — accretion (a discount accruing, TIPS indexation) is the fund's
      // income as it accrues, taxed at 15% in accumulation and 0% in pension phase. It is
      // non-cash: the handler's HoldingTransactActions step the accreting lots up by the
      // full amount after this reducer runs, so the tax comes off the fund's existing
      // holdings here, pro rata, and the later resync lands on balance + amount − tax.
      // A negative accretion (TIPS deflation) refunds at the same rate.
      const fundRate = superFundTaxRateOn(state, acct, date);
      const tax      = +(amount * fundRate).toFixed(2);
      const afterTax = +(acct.balance - tax).toFixed(2);
      const next = {
        ...acct, ...creditDerivedIncome(acct, +(amount - tax).toFixed(2)),
        holdings: tax === 0 ? acct.holdings : scaleHoldings(acct.holdings, acct.balance, afterTax, lotVintage(state, acct)),
        balance:  +(afterTax + amount).toFixed(2),
      };
      return this.newState({ ...state, [key]: next }, {}, fundRate > 0
        ? [{ type: 'SUPER_EARNINGS_TAX', amount, stateKey: key, taxRate: fundRate }]
        : []);
    }

    // Design 84 G2 — accretion is DERIVED income; raise the ledger with the balance.
    const base = { ...state, [key]: { ...acct, ...creditDerivedIncome(acct, amount), balance: acct.balance + amount } };

    if (taxMode === 'deferred') {
      // 401k / IRA / Roth — no immediate tax; taxed (or not, for Roth) on withdrawal.
      return this.newState(base);
    }

    if (taxMode === 'au') {
      // AU-source accretion → AU ordinary income via the shared AU tax path.
      return this.newState(base, {}, [{ type: 'AU_SAVINGS_EARNINGS_TAX', amount, residency, stateKey: key }]);
    }

    // taxMode === 'us' — route through the design-59/66 bond-coupon tax classification
    // so the federal/state exemption split (Treasury STRIPS, muni zero) and FITO relief
    // are applied consistently with cash coupons.
    return this.newState(base, {}, [{ type: 'BOND_COUPON_TAX', amount, federalTaxableAmount, stateTaxableAmount, residency, stateKey: key }]);
  }
}
