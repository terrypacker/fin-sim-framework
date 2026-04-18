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
import { PRIORITY } from '../../../simulation-framework/reducers.js';

/**
 * UsTaxModule2026 — US tax classification rules for 2026.
 *
 * Registers Stage-2 (TAX_CALC priority) reducers for all _TAX child actions
 * emitted by the US account module's Stage-1 reducers.  Handles cross-border
 * effects for US accounts when the person is also an AU resident.
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

  registerReducers(pipeline) {
    this._registerRothTax(pipeline);
    this._registerIraTax(pipeline);
    this._register401kTax(pipeline);
    this._registerUsBrokerageTax(pipeline);
    this._registerRealPropertyTax(pipeline);
  }

  _registerRothTax(pipeline) {
    // EVT-3: Roth withdrawal of earnings — penalty only (no US income tax), AU ordinary income if resident
    pipeline.register('ROTH_WITHDRAWAL_EARNINGS_TAX', (state, action) => {
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
    }, PRIORITY.TAX_CALC, 'Roth Withdrawal Earnings Tax');
  }

  _registerIraTax(pipeline) {
    // EVT-5: IRA contribution — US negative income (pre-tax deduction)
    pipeline.register('IRA_CONTRIBUTION_TAX', (state, action) => ({
      ...state,
      usNegativeIncomeYTD: state.usNegativeIncomeYTD + action.amount,
    }), PRIORITY.TAX_CALC, 'IRA Contribution Tax');

    // EVT-6: IRA withdrawal of contributions — US ordinary income + optional penalty, no AU tax
    pipeline.register('IRA_WITHDRAWAL_CONTRIB_TAX', (state, action) => ({
      ...state,
      usOrdinaryIncomeYTD: state.usOrdinaryIncomeYTD + action.amount,
      usPenaltyYTD:        state.usPenaltyYTD        + action.penaltyAmount,
    }), PRIORITY.TAX_CALC, 'IRA Contribution Withdrawal Tax');

    // EVT-7: IRA withdrawal of earnings — US ordinary income + optional penalty, AU ordinary income if resident
    pipeline.register('IRA_WITHDRAWAL_EARNINGS_TAX', (state, action) => {
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
    }, PRIORITY.TAX_CALC, 'IRA Withdrawal Earnings Tax');
  }

  _register401kTax(pipeline) {
    // EVT-24: 401k contribution — US negative income (pre-tax deduction)
    pipeline.register('K401_CONTRIBUTION_TAX', (state, action) => ({
      ...state,
      usNegativeIncomeYTD: state.usNegativeIncomeYTD + action.amount,
    }), PRIORITY.TAX_CALC, '401k Contribution Tax');

    // EVT-25 (withdrawal): US ordinary income + optional early withdrawal penalty
    pipeline.register('K401_WITHDRAWAL_TAX', (state, action) => ({
      ...state,
      usOrdinaryIncomeYTD: state.usOrdinaryIncomeYTD + action.amount,
      usPenaltyYTD:        state.usPenaltyYTD        + action.penaltyAmount,
    }), PRIORITY.TAX_CALC, '401k Withdrawal Tax');
  }

  _registerUsBrokerageTax(pipeline) {
    // EVT-11: fixed income earnings — US ordinary income, AU ordinary income if resident
    pipeline.register('FIXED_INCOME_EARNINGS_TAX', (state, action) => {
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
    }, PRIORITY.TAX_CALC, 'Fixed Income Earnings Tax');

    // EVT-13: stock dividend — US ordinary income, AU ordinary income if resident
    pipeline.register('STOCK_DIVIDEND_TAX', (state, action) => {
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
    }, PRIORITY.TAX_CALC, 'Stock Dividend Tax');

    // EVT-15: stock withdrawal (sale) — US capital gain, AU capital gain if resident
    pipeline.register('STOCK_WITHDRAWAL_TAX', (state, action) => {
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
    }, PRIORITY.TAX_CALC, 'Stock Withdrawal Tax');
  }

  _registerRealPropertyTax(pipeline) {
    // EVT-34: US house sale — US capital gain after $500K exemption
    // AU tax treatment unresolved (TODO: CSV "??") — no AU field updated
    pipeline.register('US_HOUSE_SALE_TAX', (state, action) => ({
      ...state,
      usCapitalGainsYTD: state.usCapitalGainsYTD + action.taxableGain,
    }), PRIORITY.TAX_CALC, 'US House Sale Tax');
  }
}
