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
import { ACCOUNT_ROLES } from '../state/account-roles.js';

/**
 * Handles the US_SAVINGS_INTEREST_CREDIT action.
 *
 * Credits action.amount to the US savings account (resolved via StateRegistry)
 * then increments usOrdinaryIncomeYTD. When the person is already an AU
 * resident, the same amount is also added to auOrdinaryIncomeYTD (worldwide) and
 * to the FITO removal set (usSourceOrdinary{Usd,Aud}YTD) — US-source interest is
 * relieved on the AU return via FITO, not by a US FTC (design 52).
 *
 * @param {object} opts
 * @param {import('../../finance/services/account-service.js').AccountService} opts.accountService
 * @param {import('../services/state-registry.js').StateRegistry} opts.stateRegistry
 * @param {string} [opts.role=ACCOUNT_ROLES.US_SAVINGS]
 * @param {string|null} [opts.ownerId=null]
 */
export class UsSavingsInterestCreditReducer extends Reducer {
  static description = 'Credits interest to a US savings account and increments usOrdinaryIncomeYTD (plus auOrdinaryIncomeYTD + the FITO removal set when AU-resident).';
  static type        = 'UsSavingsInterestCreditReducer';
  static actionType  = 'US_SAVINGS_INTEREST_CREDIT';

  constructor({ accountService, stateRegistry, role = ACCOUNT_ROLES.US_SAVINGS, ownerId = null } = {}) {
    super('US Savings Interest Credit', PRIORITY.CASH_FLOW);
    this.accountService = accountService;
    this.stateRegistry  = stateRegistry;
    this.role           = role;
    this.ownerId        = ownerId;
    this.reducedActionTypes = ['US_SAVINGS_INTEREST_CREDIT'];
  }

  static fromJSON(d, { accountService, stateRegistry }) {
    const r = new this({ accountService, stateRegistry, role: d.role ?? ACCOUNT_ROLES.US_SAVINGS, ownerId: d.ownerId ?? null });
    r.id = d.id;
    return r;
  }

  toJSON() {
    return { ...super.toJSON(), role: this.role, ownerId: this.ownerId };
  }

  reduce(state, action, date) {
    // Per-account (design 55 §7): credit the account the handler stamped, so a
    // single reducer routes each account's interest correctly (a spouse's credit
    // no longer lands on the primary's account). Fall back to role+owner lookup
    // for pre-stateKey saved actions.
    const key = action.stateKey ?? this.stateRegistry.getStateKey(this.role, this.ownerId);
    this.accountService.transaction(state[key], action.amount, date);

    const usNext = (state.usOrdinaryIncomeYTD ?? 0) + action.amount;
    // Savings interest is net investment income (IRC §1411(c)(1)(A)(i)) → NIIT base.
    const base   = {
      ...state,
      usOrdinaryIncomeYTD:       usNext,
      usNetInvestmentIncomeYTD: (state.usNetInvestmentIncomeYTD ?? 0) + action.amount,
    };

    const personKey = this.ownerId ?? Object.keys(state.people ?? {})[0];
    if (state.people?.[personKey]?.residency === 'AU') {
      // US-source interest booked while AU-resident: AU taxes it (worldwide) and
      // relieves the US tax via FITO (design 52). Record the FITO removal set to
      // match exactly what landed in each bucket (usOrdinaryIncomeYTD USD and
      // auOrdinaryIncomeYTD as-written) so the §4.5/§4.6 with/without passes stay
      // self-consistent. (auOrdinaryIncomeYTD is added unconverted here, a
      // pre-existing quirk independent of design 52 — preserved as-is.)
      // Design 76 Gap B/D: attribute both the assessable income and its US-source
      // removal slice to the account's owner. They must move together — a person
      // holding 100% of the income but half the removal slice gets a FITO limit
      // sized off the wrong base.
      const share = accumulateByOwnership({}, { ownershipType: 'sole', ownerId: personKey }, action.amount, state.people);
      const add = (map, delta) => {
        const out = { ...(map ?? {}) };
        for (const [k, v] of Object.entries(delta)) out[k] = (out[k] ?? 0) + v;
        return out;
      };
      return this.newState({
        ...base,
        auPersonOrdinaryIncomeYTD:      add(state.auPersonOrdinaryIncomeYTD, share),
        auPersonUsSourceOrdinaryAudYTD: add(state.auPersonUsSourceOrdinaryAudYTD, share),
        usSourceOrdinaryUsdYTD: (state.usSourceOrdinaryUsdYTD ?? 0) + action.amount,
        usSourcePassiveUsdYTD: (state.usSourcePassiveUsdYTD ?? 0) + action.amount,
        // Design 83 G10 part 2 — subset tag: Art. 11(2) caps the US tax Australia
        // may credit under Art. 22(2) at 10% of the gross interest.
        usSourceInterestUsdYTD: (state.usSourceInterestUsdYTD ?? 0) + action.amount,
      });
    }
    return this.newState(base);
  }
}
