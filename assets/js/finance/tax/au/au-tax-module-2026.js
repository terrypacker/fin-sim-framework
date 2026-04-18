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

const SUPER_TAX_RATE = 0.15;

/**
 * AuTaxModule2026 — AU tax classification rules for 2026.
 *
 * Registers Stage-2 (TAX_CALC priority) reducers for all _TAX child actions
 * emitted by the AU account module's Stage-1 reducers.  Also handles US tax
 * effects that originate from AU account events (e.g., super withdrawal earnings
 * are US ordinary income; AU savings earnings are always US ordinary income).
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

  registerReducers(pipeline) {
    this._registerAuSavingsTax(pipeline);
    this._registerSuperTax(pipeline);
    this._registerAuBrokerageTax(pipeline);
    this._registerRealPropertyTax(pipeline);
  }

  _registerAuSavingsTax(pipeline) {
    // EVT-18 (resident) / EVT-19 (non-resident): earnings
    //   always US ordinary income;
    //   AU ordinary income for residents, AU NR withholding for non-residents
    pipeline.register('AU_SAVINGS_EARNINGS_TAX', (state, action) => {
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
    }, PRIORITY.TAX_CALC, 'AU Savings Earnings Tax');
  }

  _registerSuperTax(pipeline) {
    // EVT-20: super contribution — AU super tax at 15%, no US tax
    pipeline.register('SUPER_CONTRIBUTION_TAX', (state, action) => ({
      ...state,
      auSuperTaxYTD: state.auSuperTaxYTD + action.amount * SUPER_TAX_RATE,
    }), PRIORITY.TAX_CALC, 'Super Contribution Tax');

    // EVT-22: super withdrawal of earnings — US ordinary income, no AU tax
    pipeline.register('SUPER_WITHDRAWAL_EARNINGS_TAX', (state, action) => ({
      ...state,
      usOrdinaryIncomeYTD: state.usOrdinaryIncomeYTD + action.amount,
    }), PRIORITY.TAX_CALC, 'Super Withdrawal Earnings Tax');

    // EVT-23: super earnings — AU super tax at 15%, no US tax
    pipeline.register('SUPER_EARNINGS_TAX', (state, action) => ({
      ...state,
      auSuperTaxYTD: state.auSuperTaxYTD + action.amount * SUPER_TAX_RATE,
    }), PRIORITY.TAX_CALC, 'Super Earnings Tax');
  }

  _registerAuBrokerageTax(pipeline) {
    // EVT-26: franked dividend — AU resident: US ordinary income, AU franking credit, FTC
    pipeline.register('AU_DIVIDEND_FRANKED_RESIDENT_TAX', (state, action) => ({
      ...state,
      usOrdinaryIncomeYTD:  state.usOrdinaryIncomeYTD  + action.amount,
      auFrankingCreditYTD:  state.auFrankingCreditYTD  + action.amount,
      ftcYTD:               state.ftcYTD               + action.amount,
    }), PRIORITY.TAX_CALC, 'AU Franked Dividend Resident Tax');

    // EVT-27: franked dividend — non-resident: no AU tax
    // TODO: US treatment is unresolved (CSV: "Ordinary Income??") — no _TAX action chained

    // EVT-28: unfranked dividend — AU resident: US ordinary income, AU ordinary income, FTC
    pipeline.register('AU_DIVIDEND_UNFRANKED_RESIDENT_TAX', (state, action) => ({
      ...state,
      usOrdinaryIncomeYTD: state.usOrdinaryIncomeYTD + action.amount,
      auOrdinaryIncomeYTD: state.auOrdinaryIncomeYTD + action.amount,
      ftcYTD:              state.ftcYTD              + action.amount,
    }), PRIORITY.TAX_CALC, 'AU Unfranked Dividend Resident Tax');

    // EVT-29: unfranked dividend — non-resident: US ordinary income, AU NR withholding, FTC
    pipeline.register('AU_DIVIDEND_UNFRANKED_NONRESIDENT_TAX', (state, action) => ({
      ...state,
      usOrdinaryIncomeYTD:         state.usOrdinaryIncomeYTD         + action.amount,
      auNonResidentWithholdingYTD: state.auNonResidentWithholdingYTD + action.amount,
      ftcYTD:                      state.ftcYTD                      + action.amount,
    }), PRIORITY.TAX_CALC, 'AU Unfranked Dividend Non-Resident Tax');

    // EVT-31 (resident) / EVT-32 (non-resident): AU stock withdrawal
    //   always US capital gain; AU capital gain + FTC for residents only
    pipeline.register('AU_STOCK_WITHDRAWAL_TAX', (state, action) => {
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
    }, PRIORITY.TAX_CALC, 'AU Stock Withdrawal Tax');
  }

  _registerRealPropertyTax(pipeline) {
    // EVT-33: AU house sale — always US capital gain, always AU NR withholding, FTC
    pipeline.register('AU_HOUSE_SALE_TAX', (state, action) => ({
      ...state,
      usCapitalGainsYTD:           state.usCapitalGainsYTD           + action.gain,
      auNonResidentWithholdingYTD: state.auNonResidentWithholdingYTD + action.gain,
      ftcYTD:                      state.ftcYTD                      + action.gain,
    }), PRIORITY.TAX_CALC, 'AU House Sale Tax');
  }
}
