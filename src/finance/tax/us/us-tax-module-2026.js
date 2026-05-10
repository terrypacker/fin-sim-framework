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
      ...this._incomeReducerFns(),
      ...this._collectibleReducerFns(),
      ...this._iraRolloverReducerFns(),
      ...this._rothRolloverReducerFns(),
    ]);
  }

  _rothReducerFns() {
    return [
      // EVT-3: Roth withdrawal of earnings — penalty only (no US income tax),
      //        AU ordinary income if resident
      ['ROTH_WITHDRAWAL_EARNINGS_TAX', (state, action) => {
        const { amount, penaltyAmount, isAuResident } = action;
        let next = { ...state, usPenaltyYTD: state.usPenaltyYTD + penaltyAmount };
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
        const { amount, penaltyAmount, isAuResident } = action;
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
    ];
  }

  _usBrokerageReducerFns() {
    return [
      // EVT-11: fixed income earnings — US ordinary income, AU ordinary income if resident
      ['FIXED_INCOME_EARNINGS_TAX', (state, action) => {
        const { amount, isAuResident } = action;
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
        const { amount, isAuResident } = action;
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

      // EVT-15: stock withdrawal (sale) — US capital gain, AU capital gain if resident
      ['STOCK_WITHDRAWAL_TAX', (state, action) => {
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
      // EVT-34: US house sale — US capital gain after $500K exemption
      ['US_HOUSE_SALE_TAX', (state, action) => ({
        ...state,
        usCapitalGainsYTD: state.usCapitalGainsYTD + action.taxableGain,
      })],
    ];
  }

  _incomeReducerFns() {
    return [
      // EVT-37: SS income — 85% taxable as US ordinary income; AU ordinary income if resident
      ['SS_INCOME_TAX', (state, action) => {
        const { amount, isAuResident } = action;
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

      // EVT-38: wages — US ordinary income; AU ordinary income if resident
      ['WAGES_INCOME_TAX', (state, action) => {
        const { amount, isAuResident } = action;
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

      // EVT-48: US self-employment income — US ordinary income; AU ordinary income if resident
      ['SE_INCOME_US_TAX', (state, action) => {
        const { amount, isAuResident } = action;
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
        const { amount, isAuResident } = action;
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
        const { gain, isAuResident } = action;
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
        const { gain, isAuResident } = action;
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
        const { amount, isAuResident } = action;
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
        const { amount, isAuResident } = action;
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
      // EVT-44: Roth rollover earnings withdrawal — no US tax or penalty;
      //         AU ordinary income if resident
      ['ROTH_ROLLOVER_WITHDRAWAL_EARNINGS_TAX', (state, action) => {
        const { amount, isAuResident } = action;
        if (!isAuResident) return state;
        return {
          ...state,
          auOrdinaryIncomeYTD: state.auOrdinaryIncomeYTD + amount,
          ftcYTD:              state.ftcYTD              + amount,
        };
      }],
    ];
  }
}
