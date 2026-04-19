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

const SUPER_TAX_RATE = 0.15;

/**
 * AuTaxModule2026 — AU tax classification rules for FY starting July 2026.
 *
 * Returns Stage-2 (TAX_CALC priority) reducer functions for all _TAX child
 * actions emitted by the AU account module's Stage-1 reducers.  Also handles
 * US tax effects that originate from AU account events.
 *
 * Covered events:
 *   EVT-16 to 19  AU Savings
 *   EVT-20 to 23  Superannuation
 *   EVT-26 to 32  AU Brokerage
 *   EVT-33        AU House Sale
 */
export class AuTaxModule2026 extends BaseTaxModule {
  get countryCode() { return 'AU'; }
  get year()        { return 2026; }

  getReducerFns() {
    return new Map([
      ...this._auSavingsReducerFns(),
      ...this._superReducerFns(),
      ...this._auBrokerageReducerFns(),
      ...this._realPropertyReducerFns(),
    ]);
  }

  _auSavingsReducerFns() {
    return [
      // EVT-18/19: AU savings earnings — always US ordinary income;
      //   AU ordinary income for residents, AU NR withholding for non-residents
      ['AU_SAVINGS_EARNINGS_TAX', (state, action) => {
        const { amount, isAuResident } = action;
        let next = { ...state, usOrdinaryIncomeYTD: state.usOrdinaryIncomeYTD + amount };
        if (isAuResident) {
          next = {
            ...next,
            auOrdinaryIncomeYTD: state.auOrdinaryIncomeYTD + amount,
            ftcYTD:              state.ftcYTD              + amount,
          };
        } else {
          next = {
            ...next,
            auNonResidentWithholdingYTD: state.auNonResidentWithholdingYTD + amount,
            ftcYTD:                      state.ftcYTD                      + amount,
          };
        }
        return next;
      }],
    ];
  }

  _superReducerFns() {
    return [
      // EVT-20: super contribution — AU super tax at 15%, no US tax
      ['SUPER_CONTRIBUTION_TAX', (state, action) => ({
        ...state,
        auSuperTaxYTD: state.auSuperTaxYTD + action.amount * SUPER_TAX_RATE,
      })],

      // EVT-22: super withdrawal of earnings — US ordinary income, no AU tax
      ['SUPER_WITHDRAWAL_EARNINGS_TAX', (state, action) => ({
        ...state,
        usOrdinaryIncomeYTD: state.usOrdinaryIncomeYTD + action.amount,
      })],

      // EVT-23: super earnings — AU super tax at 15%, no US tax
      ['SUPER_EARNINGS_TAX', (state, action) => ({
        ...state,
        auSuperTaxYTD: state.auSuperTaxYTD + action.amount * SUPER_TAX_RATE,
      })],
    ];
  }

  _auBrokerageReducerFns() {
    return [
      // EVT-26: franked dividend (resident) — US ordinary income, AU franking credit, FTC
      ['AU_DIVIDEND_FRANKED_RESIDENT_TAX', (state, action) => ({
        ...state,
        usOrdinaryIncomeYTD:  state.usOrdinaryIncomeYTD  + action.amount,
        auFrankingCreditYTD:  state.auFrankingCreditYTD  + action.amount,
        ftcYTD:               state.ftcYTD               + action.amount,
      })],

      // EVT-28: unfranked dividend (resident) — US ordinary income, AU ordinary income, FTC
      ['AU_DIVIDEND_UNFRANKED_RESIDENT_TAX', (state, action) => ({
        ...state,
        usOrdinaryIncomeYTD: state.usOrdinaryIncomeYTD + action.amount,
        auOrdinaryIncomeYTD: state.auOrdinaryIncomeYTD + action.amount,
        ftcYTD:              state.ftcYTD              + action.amount,
      })],

      // EVT-29: unfranked dividend (non-resident) — US ordinary income, AU NR withholding, FTC
      ['AU_DIVIDEND_UNFRANKED_NONRESIDENT_TAX', (state, action) => ({
        ...state,
        usOrdinaryIncomeYTD:         state.usOrdinaryIncomeYTD         + action.amount,
        auNonResidentWithholdingYTD: state.auNonResidentWithholdingYTD + action.amount,
        ftcYTD:                      state.ftcYTD                      + action.amount,
      })],

      // EVT-31/32: AU stock withdrawal — always US capital gain;
      //   AU capital gain + FTC for residents only
      ['AU_STOCK_WITHDRAWAL_TAX', (state, action) => {
        const { gain, isAuResident } = action;
        let next = { ...state, usCapitalGainsYTD: state.usCapitalGainsYTD + gain };
        if (isAuResident) {
          next = {
            ...next,
            auCapitalGainsYTD: state.auCapitalGainsYTD + gain,
            ftcYTD:            state.ftcYTD            + gain,
          };
        }
        return next;
      }],
    ];
  }

  _realPropertyReducerFns() {
    return [
      // EVT-33: AU house sale — always US capital gain, AU NR withholding, FTC
      ['AU_HOUSE_SALE_TAX', (state, action) => ({
        ...state,
        usCapitalGainsYTD:           state.usCapitalGainsYTD           + action.gain,
        auNonResidentWithholdingYTD: state.auNonResidentWithholdingYTD + action.gain,
        ftcYTD:                      state.ftcYTD                      + action.gain,
      })],
    ];
  }
}
