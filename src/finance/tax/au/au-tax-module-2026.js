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
import { toUSD } from '../tax-fx.js';

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
 *
 * Design 52 — cross-border relief. Each AU-source dollar (taxed by the US on a
 * citizen's worldwide return) is now tagged into a §904 basket numerator, in USD:
 *   General  — AU wages / self-employment (also FEIE-earned; per-person cap)
 *   Passive  — AU rental, interest, dividends, brokerage/property capital gains
 * These numerators feed the per-basket §904 FTC on the US return (design 52 §4.3).
 */
export class AuTaxModule2026 extends BaseTaxModule {
  get countryCode() { return 'AU'; }
  get year()        { return 2026; }

  getReducerFns() {
    return new Map([
      ...this._auSavingsReducerFns(),
      ...this._auFixedIncomeReducerFns(),
      ...this._superReducerFns(),
      ...this._auBrokerageReducerFns(),
      ...this._realPropertyReducerFns(),
      ...this._rentalReducerFns(),
      ...this._auIncomeReducerFns(),
      ...this._auWagesReducerFns(),
    ]);
  }

  _auWagesReducerFns() {
    return [
      // Design 50: AU-source wages — always US ordinary income (worldwide).
      // Earner is AU resident → AU ordinary income + FTC; earner is a non-resident
      // (e.g. a US-resident spouse paid in AUD) → AU non-resident withholding + FTC.
      // Attributed to the *earner* via personKey (like AU_SE_INCOME_TAX), not to
      // the AU account's owner — the wage belongs to the person who earned it.
      // Design 52: AU-source earned income → §904 General numerator; the resident
      // earner's slice also feeds the per-person FEIE cap accumulator.
      ['AU_WAGES_INCOME_TAX', (state, action) => {
        const { amount, residency, personKey } = action;
        const isAuResident = residency === 'AU';
        const usd = toUSD(amount, 'AUD', state);
        let next = {
          ...state,
          usOrdinaryIncomeYTD:      state.usOrdinaryIncomeYTD + usd,
          foreignGeneralIncomeYTD:  (state.foreignGeneralIncomeYTD ?? 0) + usd,
        };
        if (isAuResident) {
          const usePerPerson = personKey != null && state.auPersonOrdinaryIncomeYTD != null;
          next = {
            ...next,
            ...(usePerPerson
              ? {
                  auPersonOrdinaryIncomeYTD: { ...state.auPersonOrdinaryIncomeYTD, [personKey]: (state.auPersonOrdinaryIncomeYTD[personKey] ?? 0) + amount },
                  auPersonEarnedIncomeYTD:   { ...(state.auPersonEarnedIncomeYTD ?? {}), [personKey]: ((state.auPersonEarnedIncomeYTD?.[personKey]) ?? 0) + amount },
                }
              : { auOrdinaryIncomeYTD: state.auOrdinaryIncomeYTD + amount }),
          };
        } else {
          const usePerPerson = personKey != null && state.auPersonNonResidentWithholdingYTD != null;
          next = {
            ...next,
            ...(usePerPerson
              ? { auPersonNonResidentWithholdingYTD: { ...state.auPersonNonResidentWithholdingYTD, [personKey]: (state.auPersonNonResidentWithholdingYTD[personKey] ?? 0) + amount } }
              : { auNonResidentWithholdingYTD: state.auNonResidentWithholdingYTD + amount }),
          };
        }
        return next;
      }],
    ];
  }

  _rentalReducerFns() {
    return [
      // Design 48: AU rental income — net rental income (may be negative) is
      // AU-sourced; always US ordinary income (worldwide), and AU ordinary income
      // with an FTC when the owner is an AU resident. FTC never goes negative.
      // Design 52: AU-source → §904 Passive numerator (loss years contribute 0).
      ['AU_RENTAL_INCOME_TAX', (state, action) => {
        const { amount, residency } = action;
        const isAuResident = residency === 'AU';
        let next = { ...state, usOrdinaryIncomeYTD: state.usOrdinaryIncomeYTD + toUSD(amount, 'AUD', state) };
        if (isAuResident) {
          next = {
            ...next,
            auOrdinaryIncomeYTD:      state.auOrdinaryIncomeYTD + amount,
            foreignPassiveIncomeYTD:  (state.foreignPassiveIncomeYTD ?? 0) + toUSD(Math.max(0, amount), 'AUD', state),
          };
        }
        return next;
      }],
    ];
  }

  _auSavingsReducerFns() {
    return [
      // EVT-18/19: AU savings earnings — always US ordinary income;
      //   AU ordinary income for residents, AU NR withholding for non-residents.
      // Design 52: AU-source interest → §904 Passive numerator.
      ['AU_SAVINGS_EARNINGS_TAX', (state, action) => {
        const { amount, residency } = action;
        const isAuResident = residency === 'AU';
        const perPerson = state.people != null && state.auSavingsAccount != null;
        const usd = toUSD(amount, 'AUD', state);
        let next = {
          ...state,
          usOrdinaryIncomeYTD:     state.usOrdinaryIncomeYTD + usd,
          foreignPassiveIncomeYTD: (state.foreignPassiveIncomeYTD ?? 0) + usd,
        };
        if (isAuResident) {
          next = {
            ...next,
            ...(perPerson
              ? { auPersonOrdinaryIncomeYTD: accumulateByOwnership(state.auPersonOrdinaryIncomeYTD ?? {}, state.auSavingsAccount, amount, state.people) }
              : { auOrdinaryIncomeYTD: state.auOrdinaryIncomeYTD + amount }),
          };
        } else {
          next = {
            ...next,
            ...(perPerson
              ? { auPersonNonResidentWithholdingYTD: accumulateByOwnership(state.auPersonNonResidentWithholdingYTD ?? {}, state.auSavingsAccount, amount, state.people) }
              : { auNonResidentWithholdingYTD: state.auNonResidentWithholdingYTD + amount }),
          };
        }
        return next;
      }],
    ];
  }

  _auFixedIncomeReducerFns() {
    return [
      // AU fixed income interest — always US ordinary income;
      //   AU ordinary income for residents, AU NR withholding for non-residents.
      // Design 52: AU-source interest → §904 Passive numerator.
      ['AU_FIXED_INCOME_EARNINGS_TAX', (state, action) => {
        const { amount, residency } = action;
        const isAuResident = residency === 'AU';
        const perPerson = state.people != null && state.auFixedIncomeAccount != null;
        const usd = toUSD(amount, 'AUD', state);
        let next = {
          ...state,
          usOrdinaryIncomeYTD:     state.usOrdinaryIncomeYTD + usd,
          foreignPassiveIncomeYTD: (state.foreignPassiveIncomeYTD ?? 0) + usd,
        };
        if (isAuResident) {
          next = {
            ...next,
            ...(perPerson
              ? { auPersonOrdinaryIncomeYTD: accumulateByOwnership(state.auPersonOrdinaryIncomeYTD ?? {}, state.auFixedIncomeAccount, amount, state.people) }
              : { auOrdinaryIncomeYTD: state.auOrdinaryIncomeYTD + amount }),
          };
        } else {
          next = {
            ...next,
            ...(perPerson
              ? { auPersonNonResidentWithholdingYTD: accumulateByOwnership(state.auPersonNonResidentWithholdingYTD ?? {}, state.auFixedIncomeAccount, amount, state.people) }
              : { auNonResidentWithholdingYTD: state.auNonResidentWithholdingYTD + amount }),
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
        usOrdinaryIncomeYTD: state.usOrdinaryIncomeYTD + toUSD(action.amount, 'AUD', state),
      })],

      // EVT-23: super earnings — AU super tax at 15% in accumulation phase;
      //   0% in pension/retirement phase (member ≥ 60), signalled by action.taxRate.
      ['SUPER_EARNINGS_TAX', (state, action) => {
        const superTax = action.amount * (action.taxRate ?? SUPER_TAX_RATE);
        const accountKey = action.stateKey ?? 'superAccount';
        const account = state[accountKey];
        const perPerson = state.people != null && account != null;
        return {
          ...state,
          ...(perPerson
            ? { auPersonSuperTaxYTD: accumulateByOwnership(state.auPersonSuperTaxYTD ?? {}, account, superTax, state.people) }
            : { auSuperTaxYTD: state.auSuperTaxYTD + superTax }),
        };
      }],
    ];
  }

  _auBrokerageReducerFns() {
    return [
      // EVT-26: franked dividend (resident) — US ordinary income, AU franking credit, FTC.
      // Design 52: AU-source dividend → §904 Passive numerator.
      ['AU_DIVIDEND_FRANKED_RESIDENT_TAX', (state, action) => {
        const perPerson = state.people != null && state.auStockAccount != null;
        const usd = toUSD(action.amount, 'AUD', state);
        return {
          ...state,
          usOrdinaryIncomeYTD:     state.usOrdinaryIncomeYTD + usd,
          foreignPassiveIncomeYTD: (state.foreignPassiveIncomeYTD ?? 0) + usd,
          ...(perPerson
            ? { auPersonFrankingCreditYTD: accumulateByOwnership(state.auPersonFrankingCreditYTD ?? {}, state.auStockAccount, action.amount, state.people) }
            : { auFrankingCreditYTD: state.auFrankingCreditYTD + action.amount }),
        };
      }],

      // EVT-28: unfranked dividend (resident) — US ordinary income, AU ordinary income, FTC.
      // Design 52: AU-source dividend → §904 Passive numerator.
      ['AU_DIVIDEND_UNFRANKED_RESIDENT_TAX', (state, action) => {
        const perPerson = state.people != null && state.auStockAccount != null;
        const usd = toUSD(action.amount, 'AUD', state);
        return {
          ...state,
          usOrdinaryIncomeYTD:     state.usOrdinaryIncomeYTD + usd,
          foreignPassiveIncomeYTD: (state.foreignPassiveIncomeYTD ?? 0) + usd,
          ...(perPerson
            ? { auPersonOrdinaryIncomeYTD: accumulateByOwnership(state.auPersonOrdinaryIncomeYTD ?? {}, state.auStockAccount, action.amount, state.people) }
            : { auOrdinaryIncomeYTD: state.auOrdinaryIncomeYTD + action.amount }),
        };
      }],

      // EVT-29: unfranked dividend (non-resident) — US ordinary income, AU NR withholding, FTC.
      // Design 52: AU-source dividend → §904 Passive numerator.
      ['AU_DIVIDEND_UNFRANKED_NONRESIDENT_TAX', (state, action) => {
        const perPerson = state.people != null && state.auStockAccount != null;
        const usd = toUSD(action.amount, 'AUD', state);
        return {
          ...state,
          usOrdinaryIncomeYTD:     state.usOrdinaryIncomeYTD + usd,
          foreignPassiveIncomeYTD: (state.foreignPassiveIncomeYTD ?? 0) + usd,
          ...(perPerson
            ? { auPersonNonResidentWithholdingYTD: accumulateByOwnership(state.auPersonNonResidentWithholdingYTD ?? {}, state.auStockAccount, action.amount, state.people) }
            : { auNonResidentWithholdingYTD: state.auNonResidentWithholdingYTD + action.amount }),
        };
      }],

      // EVT-31/32: AU stock withdrawal — always US capital gain;
      //   AU capital gain + FTC for residents only. AU measures the gain from its
      //   stepped-up (s855-45) cost base, so auGain ≤ gain (design 36 §12.2); the
      //   pre-move appreciation is US-only and earns no FTC (only auGain feeds the
      //   §904 Passive numerator).
      // Design 52: AU-source capital gain → §904 Passive numerator (auGain, USD).
      ['AU_STOCK_WITHDRAWAL_TAX', (state, action) => {
        const { gain, residency } = action;
        const auGain = action.auGain ?? gain;
        // CGT 50%-discount-eligible slice (design 62 §4): the portion of auGain from
        // lots held ≥12 months from the AU deemed-acquisition date. Defaults to the
        // full auGain when absent (old actions ⇒ current full-discount behavior).
        const auDiscountableGain = action.auDiscountableGain ?? auGain;
        const isAuResident = residency === 'AU';
        const perPerson = state.people != null && state.auStockAccount != null;
        let next = { ...state, usCapitalGainsYTD: state.usCapitalGainsYTD + toUSD(gain, 'AUD', state) };
        if (isAuResident) {
          next = {
            ...next,
            ...(perPerson
              ? {
                  auPersonCapitalGainsYTD:      accumulateByOwnership(state.auPersonCapitalGainsYTD ?? {}, state.auStockAccount, auGain, state.people),
                  auPersonDiscountableGainsYTD: accumulateByOwnership(state.auPersonDiscountableGainsYTD ?? {}, state.auStockAccount, auDiscountableGain, state.people),
                }
              : {
                  auCapitalGainsYTD:      state.auCapitalGainsYTD + auGain,
                  auDiscountableGainsYTD: (state.auDiscountableGainsYTD ?? 0) + auDiscountableGain,
                }),
            foreignPassiveIncomeYTD: (state.foreignPassiveIncomeYTD ?? 0) + toUSD(auGain, 'AUD', state),
          };
        }
        return next;
      }],
    ];
  }

  _realPropertyReducerFns() {
    return [
      // EVT-33: AU house sale — always US capital gain;
      //   resident: AU capital gain + FTC; non-resident: AU NR withholding + FTC.
      // Design 52: AU-source capital gain → §904 Passive numerator.
      ['AU_HOUSE_SALE_TAX', (state, action) => {
        const { gain, residency, ownershipType, ownerId, owners } = action;
        const isAuResident = residency === 'AU';
        const perPerson = state.people != null;
        const usdGain = toUSD(gain, 'AUD', state);
        let next = {
          ...state,
          usCapitalGainsYTD:       state.usCapitalGainsYTD + usdGain,
          foreignPassiveIncomeYTD: (state.foreignPassiveIncomeYTD ?? 0) + usdGain,
        };
        if (perPerson) {
          const asset = { ownershipType, ownerId, owners };
          if (isAuResident) {
            next = {
              ...next,
              auPersonCapitalGainsYTD: accumulateByOwnership(state.auPersonCapitalGainsYTD ?? {}, asset, gain, state.people),
              // TAP real property: no per-lot 12-month tracking here, so the whole
              // gain stays discount-eligible (design 62 §4 — property holding-period
              // gating is out of Gap 1's scope; the residency gate targets brokerage).
              auPersonDiscountableGainsYTD: accumulateByOwnership(state.auPersonDiscountableGainsYTD ?? {}, asset, gain, state.people),
            };
          } else {
            next = {
              ...next,
              auPersonNonResidentWithholdingYTD: accumulateByOwnership(state.auPersonNonResidentWithholdingYTD ?? {}, asset, gain, state.people),
            };
          }
        } else {
          next = {
            ...next,
            ...(isAuResident
              ? { auCapitalGainsYTD: state.auCapitalGainsYTD + gain, auDiscountableGainsYTD: (state.auDiscountableGainsYTD ?? 0) + gain }
              : { auNonResidentWithholdingYTD: state.auNonResidentWithholdingYTD + gain }),
          };
        }
        return next;
      }],
    ];
  }

  _auIncomeReducerFns() {
    return [
      // EVT-49: AU self-employment income — always US ordinary income; AU ordinary income if resident.
      // Design 52: AU-source earned income → §904 General numerator + per-person FEIE cap.
      ['AU_SE_INCOME_TAX', (state, action) => {
        const { amount, residency, personKey } = action;
        const isAuResident = residency === 'AU';
        const usd = toUSD(amount, 'AUD', state);
        let next = { ...state, usOrdinaryIncomeYTD: state.usOrdinaryIncomeYTD + usd };
        if (isAuResident) {
          // §904 General numerator only when AU taxes it (resident) — a
          // non-resident's AU-source SE income is not AU-assessed in this model,
          // so there is no foreign tax to credit (matches the pre-52 ftcYTD gate).
          const usePerPerson = personKey != null && state.auPersonOrdinaryIncomeYTD != null;
          next = {
            ...next,
            foreignGeneralIncomeYTD: (state.foreignGeneralIncomeYTD ?? 0) + usd,
            ...(usePerPerson
              ? {
                  auPersonOrdinaryIncomeYTD: { ...state.auPersonOrdinaryIncomeYTD, [personKey]: (state.auPersonOrdinaryIncomeYTD[personKey] ?? 0) + amount },
                  auPersonEarnedIncomeYTD:   { ...(state.auPersonEarnedIncomeYTD ?? {}), [personKey]: ((state.auPersonEarnedIncomeYTD?.[personKey]) ?? 0) + amount },
                }
              : { auOrdinaryIncomeYTD: state.auOrdinaryIncomeYTD + amount }),
          };
        }
        return next;
      }],
    ];
  }
}
