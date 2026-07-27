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
import { accumulateByOwnership } from '../ownership-utils.js';

/**
 * Handles CASH_SLEEVE_INTEREST_APPLY actions (design 60) — money-market interest
 * on the CASH sleeve of an equity-served account (brokerage / retirement / super).
 *
 * Credits `amount` to the account balance (the paired HoldingTransactActions the
 * handler emits reinvest it into the CASH holding and re-sync the balance to the
 * same value, so this reducer only bumps the scalar — mirroring
 * StockEarningsApplyReducer). Then applies tax by `taxMode`:
 *
 *   - 'us'       → increments usOrdinaryIncomeYTD; when AU-resident, also mirrors
 *                  into auOrdinaryIncomeYTD (worldwide) + the FITO removal set
 *                  (usSourceOrdinary{Usd,Aud}YTD), exactly like
 *                  UsSavingsInterestCreditReducer (design 52).
 *   - 'au'       → chains AU_SAVINGS_EARNINGS_TAX { amount, residency } so the AU
 *                  tax module folds it into auOrdinaryIncomeYTD (+ state routing).
 *   - 'deferred' → tax-deferred/free wrapper (401k/IRA/Roth/super): balance only,
 *                  no immediate tax; the eventual withdrawal taxes the grown balance.
 */
export class CashSleeveInterestApplyReducer extends Reducer {
  static description = 'Credits money-market interest to an equity-served account\'s cash sleeve and applies tax per the action\'s taxMode (us ordinary + FITO / au ordinary / deferred).';
  static type        = 'CashSleeveInterestApplyReducer';
  static actionType  = 'CASH_SLEEVE_INTEREST_APPLY';

  constructor({ accountService, stateRegistry } = {}) {  // deps accepted for API symmetry
    super('Cash Sleeve Interest Apply', PRIORITY.CASH_FLOW);
    this.reducedActionTypes   = ['CASH_SLEEVE_INTEREST_APPLY'];
    this.generatedActionTypes = ['AU_SAVINGS_EARNINGS_TAX'];
  }

  reduce(state, action) {
    const { amount, taxMode = 'us', residency } = action;
    const key  = action.stateKey;
    const acct = state[key];
    if (!acct || !(amount > 0)) return this.newState(state);

    const base = { ...state, [key]: { ...acct, balance: acct.balance + amount } };

    if (taxMode === 'deferred') {
      // 401k / IRA / Roth / super — no immediate tax; taxed (or not, for Roth) on withdrawal.
      return this.newState(base);
    }

    if (taxMode === 'au') {
      // AU-source cash interest → AU ordinary income via the shared AU tax path.
      return this.newState(base, {}, [{ type: 'AU_SAVINGS_EARNINGS_TAX', amount, residency, stateKey: key }]);
    }

    // taxMode === 'us' — US ordinary income (federal + state). When AU-resident,
    // AU taxes it worldwide and relieves the US tax via FITO (design 52).
    // Money-market interest is net investment income (IRC §1411(c)(1)(A)(i)) →
    // NIIT base. Only the 'us' taxMode books US ordinary income; 'deferred'
    // (401k/IRA/Roth/super) and 'au' returned earlier, so they never reach here.
    const withUs = {
      ...base,
      usOrdinaryIncomeYTD:       (state.usOrdinaryIncomeYTD ?? 0) + amount,
      usNetInvestmentIncomeYTD: (state.usNetInvestmentIncomeYTD ?? 0) + amount,
    };
    if (residency === 'AU') {
      // Design 76 Gap B/D: attribute the assessable income and its US-source removal
      // slice to the owner(s) of the account whose cash sleeve earned it. Both must
      // move together, or the FITO limit is sized off a mismatched base.
      const owner = state.people != null ? acct : null;
      const patch = owner
        ? {
            auPersonOrdinaryIncomeYTD:      accumulateByOwnership(state.auPersonOrdinaryIncomeYTD ?? {},      owner, amount, state.people),
            auPersonUsSourceOrdinaryAudYTD: accumulateByOwnership(state.auPersonUsSourceOrdinaryAudYTD ?? {}, owner, amount, state.people),
          }
        : {
            auOrdinaryIncomeYTD:    (state.auOrdinaryIncomeYTD ?? 0) + amount,
            usSourceOrdinaryAudYTD: (state.usSourceOrdinaryAudYTD ?? 0) + amount,
          };
      return this.newState({
        ...withUs,
        ...patch,
        usSourceOrdinaryUsdYTD: (state.usSourceOrdinaryUsdYTD ?? 0) + amount,
      });
    }
    return this.newState(withUs);
  }
}
