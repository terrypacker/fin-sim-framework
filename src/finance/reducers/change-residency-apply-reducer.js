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

/**
 * Handles CHANGE_RESIDENCY_APPLY actions.
 *
 * Executes the state mutations that accompany a move from the US to AU:
 *
 *   1. Snapshots balanceAtResidencyChange on each configured investment account
 *      via AccountService.recordResidencyChange (one-time capture; no-op on
 *      plain Account objects that lack the field).
 *
 *   2. Adds 'AUS' to the citizen array of every person entry in state.people,
 *      deduplicating with a Set so repeated residency events are idempotent.
 *
 *   3. Sets state.isAuResident = true.
 *
 * Runs at PRIORITY.PRE_PROCESS — before any CASH_FLOW reducers that may
 * read isAuResident or balanceAtResidencyChange in the same event cycle.
 *
 * @param {object} opts
 * @param {import('../../finance/services/account-service.js').AccountService} opts.accountService
 * @param {string[]} [opts.investmentKeys]
 *   State keys of InvestmentAccount instances that should have their
 *   balanceAtResidencyChange snapshotted. Defaults to the standard set used
 *   in the international retirement scenario.
 */
export class ChangeResidencyApplyReducer extends Reducer {
  static description = 'Flips isAuResident, snapshots investment account balances at residency change, and adds AU citizenship to all people in state.';

  static actionType = 'CHANGE_RESIDENCY_APPLY';

  static DEFAULT_INVESTMENT_KEYS = [
    'rothAccount', 'iraAccount', 'k401Account',
    'stockAccount', 'superAccount', 'auStockAccount',
  ];

  constructor({ accountService, investmentKeys = ChangeResidencyApplyReducer.DEFAULT_INVESTMENT_KEYS } = {}) {
    super('Change Residency Apply', PRIORITY.PRE_PROCESS);
    this.accountService  = accountService;
    this.investmentKeys  = investmentKeys;
  }

  reduce(state) {
    // 1. Snapshot balanceAtResidencyChange on investment accounts
    for (const key of this.investmentKeys) {
      if (state[key]) this.accountService.recordResidencyChange(state[key]);
    }

    // 2. Add AU citizenship to every person in state.people
    const updatedPeople = {};
    if (state.people) {
      for (const [personKey, person] of Object.entries(state.people)) {
        if (person && Array.isArray(person.citizen)) {
          updatedPeople[personKey] = {
            ...person,
            citizen: [...new Set([...person.citizen, 'AUS'])],
          };
        } else {
          updatedPeople[personKey] = person;
        }
      }
    }

    // 3. Set isAuResident flag
    return this.newState({
      ...state,
      people:       Object.keys(updatedPeople).length > 0 ? updatedPeople : state.people,
      isAuResident: true,
    });
  }
}
