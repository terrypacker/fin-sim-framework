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
      //   FTC: None. Because the US imposes no income tax on the earnings, there
      //        is no foreign tax for AU to credit (and nothing to relieve on the
      //        US side). This is the well-documented Roth "double-tax with no
      //        relief" outcome for Australian residents — do NOT add to ftcYTD.
      ['ROTH_WITHDRAWAL_EARNINGS_TAX', (state, action) => {
        const { amount, penaltyAmount, residency } = action;
        const isAuResident = residency === 'AU';
        let next = { ...state, usPenaltyYTD: state.usPenaltyYTD + penaltyAmount };
        if (isAuResident) {
          next = {
            ...next,
            auOrdinaryIncomeYTD: state.auOrdinaryIncomeYTD + amount,
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

      // EVT-7: IRA withdrawal of earnings — US ordinary income + optional penalty,
      //        AU ordinary income if resident
      ['IRA_WITHDRAWAL_EARNINGS_TAX', (state, action) => {
        const { amount, penaltyAmount, residency } = action;
        const isAuResident = residency === 'AU';
        let next = {
          ...state,
          usOrdinaryIncomeYTD: state.usOrdinaryIncomeYTD + amount,
          usPenaltyYTD:        state.usPenaltyYTD        + penaltyAmount,
        };
        if (isAuResident) {
          next = {
            ...next,
            auOrdinaryIncomeYTD: state.auOrdinaryIncomeYTD + amount,
            ftcYTD:              state.ftcYTD              + amount,
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

      // EVT-40 (401k RMD): US ordinary income, no penalty; AU ordinary income if resident
      ['K401_RMD_TAX', (state, action) => {
        const { amount, residency } = action;
        const isAuResident = residency === 'AU';
        let next = { ...state, usOrdinaryIncomeYTD: state.usOrdinaryIncomeYTD + amount };
        if (isAuResident) {
          next = {
            ...next,
            auOrdinaryIncomeYTD: state.auOrdinaryIncomeYTD + amount,
            ftcYTD:              state.ftcYTD              + amount,
          };
        }
        return next;
      }],
    ];
  }

  _usBrokerageReducerFns() {
    return [
      // EVT-11: fixed income earnings — US ordinary income, AU ordinary income if resident
      ['FIXED_INCOME_EARNINGS_TAX', (state, action) => {
        const { amount, residency } = action;
        const isAuResident = residency === 'AU';
        let next = { ...state, usOrdinaryIncomeYTD: state.usOrdinaryIncomeYTD + amount };
        if (isAuResident) {
          next = {
            ...next,
            auOrdinaryIncomeYTD: state.auOrdinaryIncomeYTD + amount,
            ftcYTD:              state.ftcYTD              + amount,
          };
        }
        return next;
      }],

      // EVT-13: stock dividend — US ordinary income, AU ordinary income if resident
      ['STOCK_DIVIDEND_TAX', (state, action) => {
        const { amount, residency } = action;
        const isAuResident = residency === 'AU';
        let next = { ...state, usOrdinaryIncomeYTD: state.usOrdinaryIncomeYTD + amount };
        if (isAuResident) {
          next = {
            ...next,
            auOrdinaryIncomeYTD: state.auOrdinaryIncomeYTD + amount,
            ftcYTD:              state.ftcYTD              + amount,
          };
        }
        return next;
      }],

      // EVT-15: stock withdrawal (sale) — US capital gain, AU capital gain if resident.
      // AU measures the gain from its stepped-up (s855-45) cost base, so auGain ≤ gain
      // (design 36 §12.2). The pre-move appreciation (gain − auGain) is US-only — it is
      // not double-taxed, so it earns no FTC (ftcYTD tracks auGain, not gain).
      ['STOCK_WITHDRAWAL_TAX', (state, action) => {
        const { gain, residency } = action;
        const auGain = action.auGain ?? gain;
        const isAuResident = residency === 'AU';
        let next = { ...state, usCapitalGainsYTD: state.usCapitalGainsYTD + gain };
        if (isAuResident) {
          next = {
            ...next,
            auCapitalGainsYTD: state.auCapitalGainsYTD + auGain,
            ftcYTD:            state.ftcYTD            + auGain,
          };
        }
        return next;
      }],
    ];
  }

  _realPropertyReducerFns() {
    return [
      // EVT-34: US house sale — US capital gain after $500K exemption
      ['US_HOUSE_SALE_TAX', (state, action) => ({
        ...state,
        usCapitalGainsYTD: state.usCapitalGainsYTD + action.gain,
      })],
    ];
  }

  _rentalReducerFns() {
    return [
      // Design 48: US rental income — net rental income (may be negative) is US
      // ordinary income (US-sourced). For an AU resident it is also AU ordinary
      // income with an FTC for the US tax; FTC never goes negative in a loss year.
      ['US_RENTAL_INCOME_TAX', (state, action) => {
        const { amount, residency } = action;
        const isAuResident = residency === 'AU';
        let next = { ...state, usOrdinaryIncomeYTD: state.usOrdinaryIncomeYTD + amount };
        if (isAuResident) {
          next = {
            ...next,
            auOrdinaryIncomeYTD: state.auOrdinaryIncomeYTD + amount,
            ftcYTD:              state.ftcYTD              + Math.max(0, amount),
          };
        }
        return next;
      }],
    ];
  }

  _incomeReducerFns() {
    return [
      // EVT-37: SS income — 85% taxable as US ordinary income; AU ordinary income if resident
      ['SS_INCOME_TAX', (state, action) => {
        const { amount, residency } = action;
        const isAuResident = residency === 'AU';
        const taxable = amount * 0.85;
        let next = { ...state, usOrdinaryIncomeYTD: state.usOrdinaryIncomeYTD + taxable };
        if (isAuResident) {
          next = {
            ...next,
            auOrdinaryIncomeYTD: state.auOrdinaryIncomeYTD + amount,
            ftcYTD:              state.ftcYTD              + taxable,
          };
        }
        return next;
      }],

      // EVT-38: wages — US ordinary income; AU per-person income if resident + personKey,
      //         otherwise AU shared income (backward compat for non-monthly-wages events)
      ['WAGES_INCOME_TAX', (state, action) => {
        const { amount, residency, personKey } = action;
        const isAuResident = residency === 'AU';
        let next = { ...state, usOrdinaryIncomeYTD: state.usOrdinaryIncomeYTD + amount };
        if (isAuResident) {
          if (personKey && state.auPersonOrdinaryIncomeYTD) {
            const personMap = { ...state.auPersonOrdinaryIncomeYTD };
            personMap[personKey] = (personMap[personKey] ?? 0) + amount;
            next = { ...next, auPersonOrdinaryIncomeYTD: personMap, ftcYTD: state.ftcYTD + amount };
          } else {
            next = { ...next, auOrdinaryIncomeYTD: state.auOrdinaryIncomeYTD + amount, ftcYTD: state.ftcYTD + amount };
          }
        }
        return next;
      }],

      // EVT-48: US self-employment income — US ordinary income; AU ordinary income if resident
      ['SE_INCOME_US_TAX', (state, action) => {
        const { amount, residency } = action;
        const isAuResident = residency === 'AU';
        let next = { ...state, usOrdinaryIncomeYTD: state.usOrdinaryIncomeYTD + amount };
        if (isAuResident) {
          next = {
            ...next,
            auOrdinaryIncomeYTD: state.auOrdinaryIncomeYTD + amount,
            ftcYTD:              state.ftcYTD              + amount,
          };
        }
        return next;
      }],

      // EVT-50: bonus — US ordinary income; AU ordinary income if resident
      ['BONUS_TAX', (state, action) => {
        const { amount, residency } = action;
        const isAuResident = residency === 'AU';
        let next = { ...state, usOrdinaryIncomeYTD: state.usOrdinaryIncomeYTD + amount };
        if (isAuResident) {
          next = {
            ...next,
            auOrdinaryIncomeYTD: state.auOrdinaryIncomeYTD + amount,
            ftcYTD:              state.ftcYTD              + amount,
          };
        }
        return next;
      }],

      // EVT-51: company sale — US capital gain; AU capital gain if resident
      ['COMPANY_SALE_TAX', (state, action) => {
        const { gain, residency } = action;
        const isAuResident = residency === 'AU';
        let next = { ...state, usCapitalGainsYTD: state.usCapitalGainsYTD + gain };
        if (isAuResident) {
          next = {
            ...next,
            auCapitalGainsYTD: (state.auCapitalGainsYTD ?? 0) + gain,
            ftcYTD:            state.ftcYTD                   + gain,
          };
        }
        return next;
      }],
    ];
  }

  _collectibleReducerFns() {
    return [
      // EVT-36/46: collectible sale — US collectible gain (28% rate); AU capital gain if resident
      ['COLLECTIBLE_SALE_TAX', (state, action) => {
        const { gain, residency } = action;
        const isAuResident = residency === 'AU';
        let next = {
          ...state,
          usCollectibleGainsYTD: (state.usCollectibleGainsYTD ?? 0) + gain,
        };
        if (isAuResident) {
          next = {
            ...next,
            auCapitalGainsYTD: (state.auCapitalGainsYTD ?? 0) + gain,
            ftcYTD:            (state.ftcYTD ?? 0)            + gain,
          };
        }
        return next;
      }],
    ];
  }

  _iraRolloverReducerFns() {
    return [
      // EVT-35: IRA rollover withdrawal — US ordinary income (no penalty); AU ordinary income if resident
      ['IRA_ROLLOVER_WITHDRAWAL_TAX', (state, action) => {
        const { amount, residency } = action;
        const isAuResident = residency === 'AU';
        let next = { ...state, usOrdinaryIncomeYTD: state.usOrdinaryIncomeYTD + amount };
        if (isAuResident) {
          next = {
            ...next,
            auOrdinaryIncomeYTD: state.auOrdinaryIncomeYTD + amount,
            ftcYTD:              state.ftcYTD              + amount,
          };
        }
        return next;
      }],

      // EVT-40: IRA RMD — US ordinary income (no penalty); AU ordinary income if resident
      ['IRA_RMD_TAX', (state, action) => {
        const { amount, residency } = action;
        const isAuResident = residency === 'AU';
        let next = { ...state, usOrdinaryIncomeYTD: state.usOrdinaryIncomeYTD + amount };
        if (isAuResident) {
          next = {
            ...next,
            auOrdinaryIncomeYTD: state.auOrdinaryIncomeYTD + amount,
            ftcYTD:              state.ftcYTD              + amount,
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
      //   FTC: None — no US income tax is levied on this distribution.
      ['ROTH_ROLLOVER_WITHDRAWAL_CONTRIB_TAX', (state, action) => {
        const { penaltyAmount = 0, auAssessableAmount = 0, residency } = action;
        let next = { ...state, usPenaltyYTD: state.usPenaltyYTD + penaltyAmount };
        if (residency === 'AU' && auAssessableAmount > 0) {
          next = { ...next, auOrdinaryIncomeYTD: state.auOrdinaryIncomeYTD + auAssessableAmount };
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
      //   FTC: None — the US levies no income tax on the earnings, so there is no
      //        foreign tax to credit. Matches the EVT-44 spec row (FTC = N).
      ['ROTH_ROLLOVER_WITHDRAWAL_EARNINGS_TAX', (state, action) => {
        const { amount, penaltyAmount = 0, residency } = action;
        let next = { ...state, usPenaltyYTD: state.usPenaltyYTD + penaltyAmount };
        if (residency === 'AU') {
          next = { ...next, auOrdinaryIncomeYTD: state.auOrdinaryIncomeYTD + amount };
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
      //   FTC: None — no AU tax is levied at conversion, so do NOT add to ftcYTD.
      ['ROTH_CONVERSION_TAX', (state, action) => ({
        ...state,
        usOrdinaryIncomeYTD: state.usOrdinaryIncomeYTD + action.amount,
      })],
    ];
  }
}
