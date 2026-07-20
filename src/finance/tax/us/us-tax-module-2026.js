/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { BaseTaxModule } from '../base-tax-module.js';
import { toAUD } from '../tax-fx.js';

/**
 * UsTaxModule2026 — US tax classification rules for 2026.
 *
 * Returns Stage-2 (TAX_CALC priority) reducer functions for all _TAX child
 * actions emitted by the US account module's Stage-1 reducers.  Handles
 * cross-border effects for US accounts when the person is also an AU resident.
 *
 * Covered events:
 *   EVT-1 to 4   Roth IRA
 *   EVT-5 to 8   Traditional IRA
 *   EVT-9 to 15  US Brokerage (fixed income + stocks)
 *   EVT-24/25    401k
 *   EVT-34       US House Sale
 *   EVT-52       Roth Conversion
 *
 * Design 52 — cross-border relief. US-source income booked while AU-resident is
 * relieved on the *AU* return via FITO (not by a US FTC — that was the old
 * `ftcYTD` over-relief hack). Each such dollar is now recorded into the FITO
 * "without" removal set, in both currencies:
 *   usSourceOrdinaryUsdYTD / usSourceCapGainsUsdYTD  (USD, §4.6 US marginal pass)
 *   usSourceOrdinaryAudYTD / usSourceCapGainsAudYTD  (AUD, §4.5 AU limit)
 */
export class UsTaxModule2026 extends BaseTaxModule {
  get countryCode() { return 'US'; }
  get year()        { return 2026; }

  getReducerFns() {
    return new Map([
      ...this._rothReducerFns(),
      ...this._iraReducerFns(),
      ...this._k401ReducerFns(),
      ...this._usBrokerageReducerFns(),
      ...this._realPropertyReducerFns(),
      ...this._rentalReducerFns(),
      ...this._incomeReducerFns(),
      ...this._collectibleReducerFns(),
      ...this._iraRolloverReducerFns(),
      ...this._rothRolloverReducerFns(),
      ...this._rothConversionReducerFns(),
      ...this._inheritanceReducerFns(),
    ]);
  }

  _rothReducerFns() {
    return [
      // EVT-3: Roth withdrawal of earnings.
      //   US:  A qualified Roth distribution is excluded from gross income —
      //        IRC §408A(d)(1). Earnings are never US ordinary income here; the
      //        only US-side charge is the IRC §72(t) 10% additional tax when the
      //        distribution is non-qualified (age < 59.5), computed upstream.
      //   AU:  The ATO treats a US Roth IRA as a foreign trust and does not
      //        recognise its US tax-free status. For an AU resident the earnings
      //        (i.e. trust income, not corpus) are assessable as ordinary income
      //        on distribution under s99B ITAA 1936.
      //   Relief: None. The US imposes no income tax on the earnings, so there is
      //        no US tax for AU to relieve via FITO. This is the well-documented
      //        Roth "double-tax with no relief" outcome for Australian residents.
      ['ROTH_WITHDRAWAL_EARNINGS_TAX', (state, action) => {
        const { amount, penaltyAmount, residency } = action;
        const isAuResident = residency === 'AU';
        let next = { ...state, usPenaltyYTD: state.usPenaltyYTD + penaltyAmount };
        if (isAuResident) {
          next = {
            ...next,
            auOrdinaryIncomeYTD: state.auOrdinaryIncomeYTD + toAUD(amount, 'USD', state),
          };
        }
        return next;
      }],
    ];
  }

  _iraReducerFns() {
    return [
      // EVT-5: IRA contribution — US negative income (pre-tax deduction)
      ['IRA_CONTRIBUTION_TAX', (state, action) => ({
        ...state,
        usNegativeIncomeYTD: state.usNegativeIncomeYTD + action.amount,
      })],

      // EVT-6: IRA withdrawal of contributions — US ordinary income + optional penalty, no AU tax
      ['IRA_WITHDRAWAL_CONTRIB_TAX', (state, action) => ({
        ...state,
        usOrdinaryIncomeYTD: state.usOrdinaryIncomeYTD + action.amount,
        usPenaltyYTD:        state.usPenaltyYTD        + action.penaltyAmount,
      })],

      // EVT-7: IRA withdrawal of earnings — US-source ordinary income + optional
      //        penalty; AU ordinary income (worldwide) if resident, relieved by FITO.
      ['IRA_WITHDRAWAL_EARNINGS_TAX', (state, action) => {
        const { amount, penaltyAmount, residency } = action;
        const isAuResident = residency === 'AU';
        let next = {
          ...state,
          usOrdinaryIncomeYTD: state.usOrdinaryIncomeYTD + amount,
          usPenaltyYTD:        state.usPenaltyYTD        + penaltyAmount,
        };
        if (isAuResident) {
          const aud = toAUD(amount, 'USD', state);
          next = {
            ...next,
            auOrdinaryIncomeYTD:    state.auOrdinaryIncomeYTD + aud,
            usSourceOrdinaryUsdYTD: (state.usSourceOrdinaryUsdYTD ?? 0) + amount,
            usSourceOrdinaryAudYTD: (state.usSourceOrdinaryAudYTD ?? 0) + aud,
          };
        }
        return next;
      }],
    ];
  }

  _k401ReducerFns() {
    return [
      // EVT-24: 401k contribution — US negative income (pre-tax deduction)
      ['K401_CONTRIBUTION_TAX', (state, action) => ({
        ...state,
        usNegativeIncomeYTD: state.usNegativeIncomeYTD + action.amount,
      })],

      // EVT-25 (withdrawal): US ordinary income + optional early withdrawal penalty
      ['K401_WITHDRAWAL_TAX', (state, action) => ({
        ...state,
        usOrdinaryIncomeYTD: state.usOrdinaryIncomeYTD + action.amount,
        usPenaltyYTD:        state.usPenaltyYTD        + action.penaltyAmount,
      })],

      // EVT-40 (401k RMD): US-source ordinary income, no penalty; AU ordinary
      //        income (worldwide) if resident, relieved by FITO.
      ['K401_RMD_TAX', (state, action) => {
        const { amount, residency } = action;
        const isAuResident = residency === 'AU';
        let next = { ...state, usOrdinaryIncomeYTD: state.usOrdinaryIncomeYTD + amount };
        if (isAuResident) {
          const aud = toAUD(amount, 'USD', state);
          next = {
            ...next,
            auOrdinaryIncomeYTD:    state.auOrdinaryIncomeYTD + aud,
            usSourceOrdinaryUsdYTD: (state.usSourceOrdinaryUsdYTD ?? 0) + amount,
            usSourceOrdinaryAudYTD: (state.usSourceOrdinaryAudYTD ?? 0) + aud,
          };
        }
        return next;
      }],
    ];
  }

  _usBrokerageReducerFns() {
    return [
      // EVT-11: fixed income earnings — US-source ordinary income; AU ordinary
      //         income if resident, relieved by FITO.
      ['FIXED_INCOME_EARNINGS_TAX', (state, action) => {
        const { amount, residency } = action;
        const isAuResident = residency === 'AU';
        // Interest is net investment income (IRC §1411(c)(1)(A)(i)) → NIIT base.
        let next = {
          ...state,
          usOrdinaryIncomeYTD:       state.usOrdinaryIncomeYTD + amount,
          usNetInvestmentIncomeYTD: (state.usNetInvestmentIncomeYTD ?? 0) + amount,
        };
        if (isAuResident) {
          const aud = toAUD(amount, 'USD', state);
          next = {
            ...next,
            auOrdinaryIncomeYTD:    state.auOrdinaryIncomeYTD + aud,
            usSourceOrdinaryUsdYTD: (state.usSourceOrdinaryUsdYTD ?? 0) + amount,
            usSourceOrdinaryAudYTD: (state.usSourceOrdinaryAudYTD ?? 0) + aud,
          };
        }
        return next;
      }],

      // EVT-13: stock dividend — US-source ordinary income; AU ordinary income if
      //         resident, relieved by FITO.
      ['STOCK_DIVIDEND_TAX', (state, action) => {
        const { amount, residency } = action;
        const isAuResident = residency === 'AU';
        // Dividends are net investment income (IRC §1411(c)(1)(A)(i)) → NIIT base.
        let next = {
          ...state,
          usOrdinaryIncomeYTD:       state.usOrdinaryIncomeYTD + amount,
          usNetInvestmentIncomeYTD: (state.usNetInvestmentIncomeYTD ?? 0) + amount,
        };
        if (isAuResident) {
          const aud = toAUD(amount, 'USD', state);
          next = {
            ...next,
            auOrdinaryIncomeYTD:    state.auOrdinaryIncomeYTD + aud,
            usSourceOrdinaryUsdYTD: (state.usSourceOrdinaryUsdYTD ?? 0) + amount,
            usSourceOrdinaryAudYTD: (state.usSourceOrdinaryAudYTD ?? 0) + aud,
          };
        }
        return next;
      }],

      // Bond coupon interest (design 59, 66 §G2) — US-source ordinary income; AU
      // ordinary income if resident, relieved by FITO. Two carve-outs:
      //   - Treasury holdings: the FULL coupon is federally taxable — the Treasury
      //     exemption is state-only (31 U.S.C. § 3124); it lives in state classification.
      //   - Municipal holdings: the coupon is federally EXEMPT. `federalTaxableAmount`
      //     is the coupon excluding munis; it (not the full `amount`) drives the federal
      //     ordinary-income + NIIT base and the FITO relievable slice. Muni interest is
      //     NIIT-exempt, which follows automatically from taxing federalTaxableAmount.
      // For an AU resident the FULL coupon (including muni) is AU-assessable foreign
      // income; only the US-taxed slice is FITO-relievable, so the FITO removal set
      // records `federalTaxableAmount`, not the full coupon.
      ['BOND_COUPON_TAX', (state, action) => {
        const { amount, residency } = action;
        const fedAmount = action.federalTaxableAmount ?? amount;   // full coupon when unsplit (legacy)
        const isAuResident = residency === 'AU';
        let next = {
          ...state,
          usOrdinaryIncomeYTD:       state.usOrdinaryIncomeYTD + fedAmount,
          usNetInvestmentIncomeYTD: (state.usNetInvestmentIncomeYTD ?? 0) + fedAmount,
        };
        if (isAuResident) {
          const audFull = toAUD(amount, 'USD', state);
          const audFed  = toAUD(fedAmount, 'USD', state);
          next = {
            ...next,
            auOrdinaryIncomeYTD:    state.auOrdinaryIncomeYTD + audFull,
            usSourceOrdinaryUsdYTD: (state.usSourceOrdinaryUsdYTD ?? 0) + fedAmount,
            usSourceOrdinaryAudYTD: (state.usSourceOrdinaryAudYTD ?? 0) + audFed,
          };
        }
        return next;
      }],

      // EVT-15: stock withdrawal (sale) — US-source capital gain; AU capital gain
      // if resident (relieved by FITO). AU measures the gain from its stepped-up
      // (s855-45) cost base, so auGain ≤ gain (design 36 §12.2). The pre-move
      // appreciation (gain − auGain) is US-only. The FITO removal set records the
      // full US gain (USD) and the AU-taxed slice (AUD).
      ['STOCK_WITHDRAWAL_TAX', (state, action) => {
        const { gain, residency } = action;
        const auGain = action.auGain ?? gain;
        // CGT 50%-discount-eligible slice (design 62 §4): lots held ≥12 months from
        // the AU deemed-acquisition date. Defaults to the full auGain when absent.
        const auDiscountableGain = action.auDiscountableGain ?? auGain;
        const isAuResident = residency === 'AU';
        let next = { ...state, usCapitalGainsYTD: state.usCapitalGainsYTD + gain };
        if (isAuResident) {
          const audGain = toAUD(auGain, 'USD', state);
          const audDiscountableGain = toAUD(auDiscountableGain, 'USD', state);
          next = {
            ...next,
            auCapitalGainsYTD:      state.auCapitalGainsYTD + audGain,
            auDiscountableGainsYTD: (state.auDiscountableGainsYTD ?? 0) + audDiscountableGain,
            usSourceCapGainsUsdYTD: (state.usSourceCapGainsUsdYTD ?? 0) + gain,
            usSourceCapGainsAudYTD: (state.usSourceCapGainsAudYTD ?? 0) + audGain,
          };
        }
        return next;
      }],
    ];
  }

  _realPropertyReducerFns() {
    return [
      // EVT-34: US house sale — US capital gain after $500K exemption. US-source.
      // For an AU resident the foreign house is also AU-assessable (design 62 §5):
      // the AU gain (from the s855-45 stepped-up basis, net of the AU main-residence
      // exemption) is added in AUD and recorded in the FITO removal set (US tax on
      // this US-source gain is relievable). Mirrors STOCK_WITHDRAWAL_TAX; no foreign-
      // passive basket entry (US-source income is not foreign for the US return).
      ['US_HOUSE_SALE_TAX', (state, action) => {
        let next = { ...state, usCapitalGainsYTD: state.usCapitalGainsYTD + action.gain };
        if (action.residency === 'AU' && (action.auGain ?? 0) > 0) {
          const audGain         = toAUD(action.auGain, 'USD', state);
          const audDiscountable = toAUD(action.auDiscountableGain ?? action.auGain, 'USD', state);
          next = {
            ...next,
            auCapitalGainsYTD:      (state.auCapitalGainsYTD ?? 0) + audGain,
            auDiscountableGainsYTD: (state.auDiscountableGainsYTD ?? 0) + audDiscountable,
            usSourceCapGainsUsdYTD: (state.usSourceCapGainsUsdYTD ?? 0) + action.auGain,
            usSourceCapGainsAudYTD: (state.usSourceCapGainsAudYTD ?? 0) + audGain,
          };
        }
        return next;
      }],
    ];
  }

  _rentalReducerFns() {
    return [
      // Design 48: US rental income — net rental income (may be negative) is
      // US-source ordinary income. For an AU resident it is also AU ordinary
      // income (worldwide), relieved by FITO. The FITO removal set records the
      // actual (possibly negative) income so the with/without marginal pass is exact.
      ['US_RENTAL_INCOME_TAX', (state, action) => {
        const { amount, residency } = action;
        const isAuResident = residency === 'AU';
        // Net rental income is net investment income (IRC §1411(c)(1)(A)(i)) →
        // NIIT base. `amount` may be negative (a rental loss), which correctly
        // reduces the aggregate NII pool before it is floored at 0 in computeTax.
        let next = {
          ...state,
          usOrdinaryIncomeYTD:       state.usOrdinaryIncomeYTD + amount,
          usNetInvestmentIncomeYTD: (state.usNetInvestmentIncomeYTD ?? 0) + amount,
        };
        if (isAuResident) {
          const aud = toAUD(amount, 'USD', state);
          next = {
            ...next,
            auOrdinaryIncomeYTD:    state.auOrdinaryIncomeYTD + aud,
            usSourceOrdinaryUsdYTD: (state.usSourceOrdinaryUsdYTD ?? 0) + amount,
            usSourceOrdinaryAudYTD: (state.usSourceOrdinaryAudYTD ?? 0) + aud,
          };
        }
        return next;
      }],
    ];
  }

  _incomeReducerFns() {
    return [
      // EVT-37: SS income — 85% taxable as US-source ordinary income; AU ordinary
      // income (full amount) if resident, relieved by FITO. US slice = taxable
      // (85%); AU slice = full amount — each removal set matches its own bucket.
      ['SS_INCOME_TAX', (state, action) => {
        const { amount, residency } = action;
        const isAuResident = residency === 'AU';
        const taxable = amount * 0.85;
        let next = { ...state, usOrdinaryIncomeYTD: state.usOrdinaryIncomeYTD + taxable };
        if (isAuResident) {
          const aud = toAUD(amount, 'USD', state);
          next = {
            ...next,
            auOrdinaryIncomeYTD:    state.auOrdinaryIncomeYTD + aud,
            usSourceOrdinaryUsdYTD: (state.usSourceOrdinaryUsdYTD ?? 0) + taxable,
            usSourceOrdinaryAudYTD: (state.usSourceOrdinaryAudYTD ?? 0) + aud,
          };
        }
        return next;
      }],

      // EVT-38: US wages — US-source ordinary income; AU per-person income if
      //         resident + personKey, else AU shared income. Relieved by FITO.
      ['WAGES_INCOME_TAX', (state, action) => {
        const { amount, residency, personKey } = action;
        const isAuResident = residency === 'AU';
        // Design 69: US wages are Social-Security-covered wages that fill the SS
        // wage base ahead of any self-employment income (SECA coordination).
        let next = {
          ...state,
          usOrdinaryIncomeYTD: state.usOrdinaryIncomeYTD + amount,
          usSsWagesYTD:        (state.usSsWagesYTD ?? 0) + amount,
        };
        if (isAuResident) {
          const audAmount = toAUD(amount, 'USD', state);
          const removal = {
            usSourceOrdinaryUsdYTD: (state.usSourceOrdinaryUsdYTD ?? 0) + amount,
            usSourceOrdinaryAudYTD: (state.usSourceOrdinaryAudYTD ?? 0) + audAmount,
          };
          if (personKey && state.auPersonOrdinaryIncomeYTD) {
            const personMap = { ...state.auPersonOrdinaryIncomeYTD };
            personMap[personKey] = (personMap[personKey] ?? 0) + audAmount;
            next = { ...next, auPersonOrdinaryIncomeYTD: personMap, ...removal };
          } else {
            next = { ...next, auOrdinaryIncomeYTD: state.auOrdinaryIncomeYTD + audAmount, ...removal };
          }
        }
        return next;
      }],

      // EVT-48 / design 69: US self-employment income — US-source ordinary income
      //         AND US self-employment tax base (SECA); AU ordinary income if
      //         resident, relieved by FITO. usSeEarningsYTD is the net SE earnings
      //         accumulator consumed by computeTax()'s SECA computation. AU per-
      //         person attribution mirrors WAGES_INCOME_TAX.
      ['SE_INCOME_US_TAX', (state, action) => {
        const { amount, residency, personKey } = action;
        const isAuResident = residency === 'AU';
        let next = {
          ...state,
          usOrdinaryIncomeYTD: state.usOrdinaryIncomeYTD + amount,
          usSeEarningsYTD:     (state.usSeEarningsYTD ?? 0) + amount,
        };
        if (isAuResident) {
          const aud = toAUD(amount, 'USD', state);
          const removal = {
            usSourceOrdinaryUsdYTD: (state.usSourceOrdinaryUsdYTD ?? 0) + amount,
            usSourceOrdinaryAudYTD: (state.usSourceOrdinaryAudYTD ?? 0) + aud,
          };
          if (personKey && state.auPersonOrdinaryIncomeYTD) {
            const personMap = { ...state.auPersonOrdinaryIncomeYTD };
            personMap[personKey] = (personMap[personKey] ?? 0) + aud;
            next = { ...next, auPersonOrdinaryIncomeYTD: personMap, ...removal };
          } else {
            next = { ...next, auOrdinaryIncomeYTD: state.auOrdinaryIncomeYTD + aud, ...removal };
          }
        }
        return next;
      }],

      // EVT-50: bonus — US-source ordinary income; AU ordinary income if resident,
      //         relieved by FITO.
      ['BONUS_TAX', (state, action) => {
        const { amount, residency } = action;
        const isAuResident = residency === 'AU';
        // Design 69: a bonus is W-2 wages — Social-Security-covered, fills the base.
        let next = {
          ...state,
          usOrdinaryIncomeYTD: state.usOrdinaryIncomeYTD + amount,
          usSsWagesYTD:        (state.usSsWagesYTD ?? 0) + amount,
        };
        if (isAuResident) {
          const aud = toAUD(amount, 'USD', state);
          next = {
            ...next,
            auOrdinaryIncomeYTD:    state.auOrdinaryIncomeYTD + aud,
            usSourceOrdinaryUsdYTD: (state.usSourceOrdinaryUsdYTD ?? 0) + amount,
            usSourceOrdinaryAudYTD: (state.usSourceOrdinaryAudYTD ?? 0) + aud,
          };
        }
        return next;
      }],

      // EVT-51: company sale — US-source capital gain; AU capital gain if resident,
      //         relieved by FITO.
      ['COMPANY_SALE_TAX', (state, action) => {
        const { gain, residency } = action;
        const isAuResident = residency === 'AU';
        let next = { ...state, usCapitalGainsYTD: state.usCapitalGainsYTD + gain };
        if (isAuResident) {
          // AU assesses from the s855-45 stepped-up basis (design 72 §3) — only
          // post-arrival appreciation — while the US taxes the full gain from the
          // original basis. Falls back to `gain` when no step-up was stamped.
          const auGainUsd = action.auGain ?? gain;
          const audGain = toAUD(auGainUsd, 'USD', state);
          next = {
            ...next,
            auCapitalGainsYTD:      (state.auCapitalGainsYTD ?? 0) + audGain,
            // Company shares carry no per-lot 12-month tracking here, so the whole
            // gain stays discount-eligible (design 62 §4 — the residency holding-
            // period gate targets brokerage lots; company/collectible/property
            // holding-period gating is out of Gap 1's scope).
            auDiscountableGainsYTD: (state.auDiscountableGainsYTD ?? 0) + audGain,
            usSourceCapGainsUsdYTD: (state.usSourceCapGainsUsdYTD ?? 0) + gain,
            usSourceCapGainsAudYTD: (state.usSourceCapGainsAudYTD ?? 0) + audGain,
          };
        }
        return next;
      }],
    ];
  }

  _collectibleReducerFns() {
    return [
      // EVT-36/46: collectible sale — US-source collectible gain (28% rate); AU
      // capital gain if resident, relieved by FITO. The US collectible bucket is
      // separate from usCapitalGainsYTD, but the design's FITO removal set carries
      // only ordinary/capGains pairs; the collectible slice is folded into the
      // capGains removal set (the AU-side FITO limit is exact — AU taxes it as a
      // capital gain; the US §4.6 marginal pass is a conservative approximation for
      // this rare AU-resident-collectible-sale case).
      ['COLLECTIBLE_SALE_TAX', (state, action) => {
        const { gain, residency } = action;
        const isAuResident = residency === 'AU';
        let next = {
          ...state,
          usCollectibleGainsYTD: (state.usCollectibleGainsYTD ?? 0) + gain,
        };
        if (isAuResident) {
          const audGain = toAUD(gain, 'USD', state);
          next = {
            ...next,
            auCapitalGainsYTD:      (state.auCapitalGainsYTD ?? 0) + audGain,
            // Collectibles carry no per-lot 12-month tracking here (design 62 §4).
            auDiscountableGainsYTD: (state.auDiscountableGainsYTD ?? 0) + audGain,
            usSourceCapGainsUsdYTD: (state.usSourceCapGainsUsdYTD ?? 0) + gain,
            usSourceCapGainsAudYTD: (state.usSourceCapGainsAudYTD ?? 0) + audGain,
          };
        }
        return next;
      }],
    ];
  }

  _iraRolloverReducerFns() {
    return [
      // EVT-35: IRA rollover withdrawal — US-source ordinary income (no penalty);
      //         AU ordinary income if resident, relieved by FITO.
      ['IRA_ROLLOVER_WITHDRAWAL_TAX', (state, action) => {
        const { amount, residency } = action;
        const isAuResident = residency === 'AU';
        let next = { ...state, usOrdinaryIncomeYTD: state.usOrdinaryIncomeYTD + amount };
        if (isAuResident) {
          const aud = toAUD(amount, 'USD', state);
          next = {
            ...next,
            auOrdinaryIncomeYTD:    state.auOrdinaryIncomeYTD + aud,
            usSourceOrdinaryUsdYTD: (state.usSourceOrdinaryUsdYTD ?? 0) + amount,
            usSourceOrdinaryAudYTD: (state.usSourceOrdinaryAudYTD ?? 0) + aud,
          };
        }
        return next;
      }],

      // EVT-40: IRA RMD — US-source ordinary income (no penalty); AU ordinary
      //         income if resident, relieved by FITO.
      ['IRA_RMD_TAX', (state, action) => {
        const { amount, residency } = action;
        const isAuResident = residency === 'AU';
        let next = { ...state, usOrdinaryIncomeYTD: state.usOrdinaryIncomeYTD + amount };
        if (isAuResident) {
          const aud = toAUD(amount, 'USD', state);
          next = {
            ...next,
            auOrdinaryIncomeYTD:    state.auOrdinaryIncomeYTD + aud,
            usSourceOrdinaryUsdYTD: (state.usSourceOrdinaryUsdYTD ?? 0) + amount,
            usSourceOrdinaryAudYTD: (state.usSourceOrdinaryAudYTD ?? 0) + aud,
          };
        }
        return next;
      }],
    ];
  }

  _rothRolloverReducerFns() {
    return [
      // EVT-43: Roth rollover (converted) principal withdrawal.
      //   US:  No income tax — the US taxed the conversion at EVT-52. The only
      //        US charge is the IRC §408A(d)(3)(F) 5-year recapture: a
      //        distribution of converted dollars within the 5-taxable-year window
      //        (from Jan 1 of the conversion year) incurs the IRC §72(t) 10%
      //        additional tax when the owner is under 59½.
      //   AU:  The IRA-contribution-sourced portion is corpus (s99B-exempt), but
      //        the IRA-earnings-sourced portion (auAssessableAmount) is pre-tax
      //        money that would have been assessable if derived directly, so it
      //        does NOT qualify for the corpus exemption and is assessable as
      //        ordinary income under s99B ITAA 1936 when an AU resident draws it.
      //        This defers — rather than eliminates — AU tax on converted IRA
      //        earnings. The per-lot window test, penalty base, and AU-assessable
      //        share are computed upstream (roth-rollover-classes.js).
      //   Relief: None — no US income tax is levied on this distribution.
      ['ROTH_ROLLOVER_WITHDRAWAL_CONTRIB_TAX', (state, action) => {
        const { penaltyAmount = 0, auAssessableAmount = 0, residency } = action;
        let next = { ...state, usPenaltyYTD: state.usPenaltyYTD + penaltyAmount };
        if (residency === 'AU' && auAssessableAmount > 0) {
          next = { ...next, auOrdinaryIncomeYTD: state.auOrdinaryIncomeYTD + toAUD(auAssessableAmount, 'USD', state) };
        }
        return next;
      }],

      // EVT-44: Roth rollover earnings withdrawal — earnings that accrued inside
      //         the Roth on rolled-over (converted) principal.
      //   US:  Tax-free as a qualified Roth distribution (IRC §408A(d)(1)); the
      //        only US charge is the IRC §72(t) 10% additional tax on a
      //        non-qualified (age < 59½) distribution of earnings, computed
      //        upstream. The converted principal is corpus (EVT-43); only
      //        post-conversion growth is earnings.
      //   AU:  Assessable to an AU resident as ordinary income under s99B
      //        ITAA 1936 (foreign-trust earnings; corpus excluded).
      //   Relief: None — the US levies no income tax on the earnings, so there is
      //        no US tax to relieve via FITO. Matches the EVT-44 spec row.
      ['ROTH_ROLLOVER_WITHDRAWAL_EARNINGS_TAX', (state, action) => {
        const { amount, penaltyAmount = 0, residency } = action;
        let next = { ...state, usPenaltyYTD: state.usPenaltyYTD + penaltyAmount };
        if (residency === 'AU') {
          next = { ...next, auOrdinaryIncomeYTD: state.auOrdinaryIncomeYTD + toAUD(amount, 'USD', state) };
        }
        return next;
      }],
    ];
  }

  _rothConversionReducerFns() {
    return [
      // EVT-52: IRA→Roth conversion.
      //   US:  Ordinary income at conversion — the converted pre-tax amount is
      //        included in gross income (IRC §408A(d)(3)(A); §408(d)(1)). This is
      //        a US event for the account owner regardless of AU residency.
      //   AU:  No tax at conversion. s99B ITAA 1936 assesses only amounts "paid
      //        to, or applied for the benefit of" an Australian-resident
      //        beneficiary — i.e. an actual distribution received by the person.
      //        A conversion merely moves funds within the US retirement system
      //        (IRA trust → Roth trust); nothing is paid to or made available to
      //        the individual, so there is no s99B receipt and no assessable
      //        amount. AU tax arises only on later distribution from the Roth
      //        (corpus EVT-43 = not assessable; earnings EVT-44 = s99B income).
      //   Relief: None — no AU tax is levied at conversion; the US tax on the
      //        conversion is not US-source-vs-AU double taxation to relieve.
      ['ROTH_CONVERSION_TAX', (state, action) => ({
        ...state,
        usOrdinaryIncomeYTD: state.usOrdinaryIncomeYTD + action.amount,
      })],
    ];
  }

  _inheritanceReducerFns() {
    return [
      // Design 63 §6.5: Nebraska inheritance tax — heir-paid STATE liability keyed
      // to the decedent's NE situs (the handler computed the class-based amount).
      // Recorded in neInheritanceTaxYTD; the cash is debited immediately by
      // InheritanceNeTaxApplyReducer. Not federal, not marginal.
      ['NE_INHERITANCE_TAX', (state, action) => ({
        ...state,
        neInheritanceTaxYTD: (state.neInheritanceTaxYTD ?? 0) + (action.amount ?? 0),
      })],

      // Design 63 §6.2: SECURE 10-year inherited traditional IRA/401(k)
      // distribution — IRD, taxed as US ordinary income to the heir (no basis,
      // no penalty). AU ordinary income (worldwide) if the heir is AU-resident,
      // relieved by FITO — mirrors the RMD classifiers. Inherited Roth emits no
      // tax action (tax-free), so it never reaches this classifier.
      ['INHERITED_RA_DISTRIBUTION_TAX', (state, action) => {
        const { amount, residency } = action;
        const isAuResident = residency === 'AU';
        let next = { ...state, usOrdinaryIncomeYTD: state.usOrdinaryIncomeYTD + amount };
        if (isAuResident) {
          const aud = toAUD(amount, 'USD', state);
          next = {
            ...next,
            auOrdinaryIncomeYTD:    state.auOrdinaryIncomeYTD + aud,
            usSourceOrdinaryUsdYTD: (state.usSourceOrdinaryUsdYTD ?? 0) + amount,
            usSourceOrdinaryAudYTD: (state.usSourceOrdinaryAudYTD ?? 0) + aud,
          };
        }
        return next;
      }],
    ];
  }
}
