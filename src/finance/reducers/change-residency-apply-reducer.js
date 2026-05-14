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
 * @param {import('../../finance/services/state-registry.js').StateRegistry} opts.stateRegistry
 */
export class ChangeResidencyApplyReducer extends Reducer {
  static description = 'Flips isAuResident, snapshots investment account balances at residency change, and adds AU citizenship to all people in state.';

  static actionType = 'CHANGE_RESIDENCY_APPLY';

  constructor({ accountService, stateRegistry } = {}) {
    super('Change Residency Apply', PRIORITY.PRE_PROCESS);
    this.accountService  = accountService;
    this.stateRegistry   = stateRegistry;
    this.reducedActionTypes = ['CHANGE_RESIDENCY_APPLY'];
  }

  reduce(state) {
    // 1. Snapshot balanceAtResidencyChange on all registered accounts
    for (const account of this.stateRegistry.getAccounts(state)) {
      this.accountService.recordResidencyChange(account);
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
