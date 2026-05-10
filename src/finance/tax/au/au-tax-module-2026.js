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
import { accumulateByOwnership } from '../../ownership-utils.js';

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
      ...this._auIncomeReducerFns(),
    ]);
  }

  _auSavingsReducerFns() {
    return [
      // EVT-18/19: AU savings earnings — always US ordinary income;
      //   AU ordinary income for residents, AU NR withholding for non-residents
      ['AU_SAVINGS_EARNINGS_TAX', (state, action) => {
        const { amount, isAuResident } = action;
        const perPerson = state.people != null && state.auSavingsAccount != null;
        let next = { ...state, usOrdinaryIncomeYTD: state.usOrdinaryIncomeYTD + amount };
        if (isAuResident) {
          next = {
            ...next,
            ...(perPerson
              ? { auPersonOrdinaryIncomeYTD: accumulateByOwnership(state.auPersonOrdinaryIncomeYTD ?? {}, state.auSavingsAccount, amount, state.people) }
              : { auOrdinaryIncomeYTD: state.auOrdinaryIncomeYTD + amount }),
            ftcYTD: state.ftcYTD + amount,
          };
        } else {
          next = {
            ...next,
            ...(perPerson
              ? { auPersonNonResidentWithholdingYTD: accumulateByOwnership(state.auPersonNonResidentWithholdingYTD ?? {}, state.auSavingsAccount, amount, state.people) }
              : { auNonResidentWithholdingYTD: state.auNonResidentWithholdingYTD + amount }),
            ftcYTD: state.ftcYTD + amount,
          };
        }
        return next;
      }],
    ];
  }

  _superReducerFns() {
    return [
      // EVT-20: super contribution — AU super tax at 15%, no US tax
      ['SUPER_CONTRIBUTION_TAX', (state, action) => {
        const superTax = action.amount * SUPER_TAX_RATE;
        const perPerson = state.people != null && state.superAccount != null;
        return {
          ...state,
          ...(perPerson
            ? { auPersonSuperTaxYTD: accumulateByOwnership(state.auPersonSuperTaxYTD ?? {}, state.superAccount, superTax, state.people) }
            : { auSuperTaxYTD: state.auSuperTaxYTD + superTax }),
        };
      }],

      // EVT-22: super withdrawal of earnings — US ordinary income, no AU tax
      ['SUPER_WITHDRAWAL_EARNINGS_TAX', (state, action) => ({
        ...state,
        usOrdinaryIncomeYTD: state.usOrdinaryIncomeYTD + action.amount,
      })],

      // EVT-23: super earnings — AU super tax at 15%, no US tax
      ['SUPER_EARNINGS_TAX', (state, action) => {
        const superTax = action.amount * SUPER_TAX_RATE;
        const perPerson = state.people != null && state.superAccount != null;
        return {
          ...state,
          ...(perPerson
            ? { auPersonSuperTaxYTD: accumulateByOwnership(state.auPersonSuperTaxYTD ?? {}, state.superAccount, superTax, state.people) }
            : { auSuperTaxYTD: state.auSuperTaxYTD + superTax }),
        };
      }],
    ];
  }

  _auBrokerageReducerFns() {
    return [
      // EVT-26: franked dividend (resident) — US ordinary income, AU franking credit, FTC
      ['AU_DIVIDEND_FRANKED_RESIDENT_TAX', (state, action) => {
        const perPerson = state.people != null && state.auStockAccount != null;
        return {
          ...state,
          usOrdinaryIncomeYTD: state.usOrdinaryIncomeYTD + action.amount,
          ...(perPerson
            ? { auPersonFrankingCreditYTD: accumulateByOwnership(state.auPersonFrankingCreditYTD ?? {}, state.auStockAccount, action.amount, state.people) }
            : { auFrankingCreditYTD: state.auFrankingCreditYTD + action.amount }),
          ftcYTD: state.ftcYTD + action.amount,
        };
      }],

      // EVT-28: unfranked dividend (resident) — US ordinary income, AU ordinary income, FTC
      ['AU_DIVIDEND_UNFRANKED_RESIDENT_TAX', (state, action) => {
        const perPerson = state.people != null && state.auStockAccount != null;
        return {
          ...state,
          usOrdinaryIncomeYTD: state.usOrdinaryIncomeYTD + action.amount,
          ...(perPerson
            ? { auPersonOrdinaryIncomeYTD: accumulateByOwnership(state.auPersonOrdinaryIncomeYTD ?? {}, state.auStockAccount, action.amount, state.people) }
            : { auOrdinaryIncomeYTD: state.auOrdinaryIncomeYTD + action.amount }),
          ftcYTD: state.ftcYTD + action.amount,
        };
      }],

      // EVT-29: unfranked dividend (non-resident) — US ordinary income, AU NR withholding, FTC
      ['AU_DIVIDEND_UNFRANKED_NONRESIDENT_TAX', (state, action) => {
        const perPerson = state.people != null && state.auStockAccount != null;
        return {
          ...state,
          usOrdinaryIncomeYTD: state.usOrdinaryIncomeYTD + action.amount,
          ...(perPerson
            ? { auPersonNonResidentWithholdingYTD: accumulateByOwnership(state.auPersonNonResidentWithholdingYTD ?? {}, state.auStockAccount, action.amount, state.people) }
            : { auNonResidentWithholdingYTD: state.auNonResidentWithholdingYTD + action.amount }),
          ftcYTD: state.ftcYTD + action.amount,
        };
      }],

      // EVT-31/32: AU stock withdrawal — always US capital gain;
      //   AU capital gain + FTC for residents only
      ['AU_STOCK_WITHDRAWAL_TAX', (state, action) => {
        const { gain, isAuResident } = action;
        const perPerson = state.people != null && state.auStockAccount != null;
        let next = { ...state, usCapitalGainsYTD: state.usCapitalGainsYTD + gain };
        if (isAuResident) {
          next = {
            ...next,
            ...(perPerson
              ? { auPersonCapitalGainsYTD: accumulateByOwnership(state.auPersonCapitalGainsYTD ?? {}, state.auStockAccount, gain, state.people) }
              : { auCapitalGainsYTD: state.auCapitalGainsYTD + gain }),
            ftcYTD: state.ftcYTD + gain,
          };
        }
        return next;
      }],
    ];
  }

  _realPropertyReducerFns() {
    return [
      // EVT-33: AU house sale — always US capital gain;
      //   resident: AU capital gain + FTC; non-resident: AU NR withholding + FTC
      ['AU_HOUSE_SALE_TAX', (state, action) => {
        const { gain, isAuResident, ownershipType, ownerId, owners } = action;
        const perPerson = state.people != null;
        let next = { ...state, usCapitalGainsYTD: state.usCapitalGainsYTD + gain };
        if (perPerson) {
          const asset = { ownershipType, ownerId, owners };
          if (isAuResident) {
            next = {
              ...next,
              auPersonCapitalGainsYTD: accumulateByOwnership(state.auPersonCapitalGainsYTD ?? {}, asset, gain, state.people),
              ftcYTD: state.ftcYTD + gain,
            };
          } else {
            next = {
              ...next,
              auPersonNonResidentWithholdingYTD: accumulateByOwnership(state.auPersonNonResidentWithholdingYTD ?? {}, asset, gain, state.people),
              ftcYTD: state.ftcYTD + gain,
            };
          }
        } else {
          next = {
            ...next,
            ...(isAuResident
              ? { auCapitalGainsYTD: state.auCapitalGainsYTD + gain }
              : { auNonResidentWithholdingYTD: state.auNonResidentWithholdingYTD + gain }),
            ftcYTD: state.ftcYTD + gain,
          };
        }
        return next;
      }],
    ];
  }

  _auIncomeReducerFns() {
    return [
      // EVT-49: AU self-employment income — always US ordinary income; AU ordinary income if resident
      ['AU_SE_INCOME_TAX', (state, action) => {
        const { amount, isAuResident, personKey } = action;
        let next = { ...state, usOrdinaryIncomeYTD: state.usOrdinaryIncomeYTD + amount };
        if (isAuResident) {
          const usePerPerson = personKey != null && state.auPersonOrdinaryIncomeYTD != null;
          next = {
            ...next,
            ...(usePerPerson
              ? { auPersonOrdinaryIncomeYTD: { ...state.auPersonOrdinaryIncomeYTD, [personKey]: (state.auPersonOrdinaryIncomeYTD[personKey] ?? 0) + amount } }
              : { auOrdinaryIncomeYTD: state.auOrdinaryIncomeYTD + amount }),
            ftcYTD: state.ftcYTD + amount,
          };
        }
        return next;
      }],
    ];
  }
}
