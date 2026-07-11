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
import { stepsUpCostBaseOnResidency } from '../tax/residency-cost-base-policy.js';

/**
 * Handles CHANGE_RESIDENCY_APPLY actions.
 *
 * Executes the state mutations that accompany a move from the US to AU:
 *
 *   1. Snapshots balanceAtResidencyChange on each configured investment account
 *      via AccountService.recordResidencyChange (one-time capture; no-op on
 *      plain Account objects that lack the field).
 *
 *   2. Sets residency = 'AU' on every person in state.people.
 *      Citizen arrays are NOT modified — moving countries does not change citizenship.
 *
 * Runs at PRIORITY.PRE_PROCESS — before any CASH_FLOW reducers that may
 * read person.residency or balanceAtResidencyChange in the same event cycle.
 *
 * @param {object} opts
 * @param {import('../../finance/services/account-service.js').AccountService} opts.accountService
 * @param {import('../../finance/services/state-registry.js').StateRegistry} opts.stateRegistry
 */
export class ChangeResidencyApplyReducer extends Reducer {
  static description = 'Flips residency to AU on all people, snapshots investment account balances at residency change; does NOT modify citizen arrays.';
  static type        = 'ChangeResidencyApplyReducer';
  static actionType  = 'CHANGE_RESIDENCY_APPLY';

  constructor({ accountService, stateRegistry } = {}) {
    super('Change Residency Apply', PRIORITY.PRE_PROCESS);
    this.accountService  = accountService;
    this.stateRegistry   = stateRegistry;
    this.reducedActionTypes = ['CHANGE_RESIDENCY_APPLY'];
  }

  static fromJSON(d, { accountService, stateRegistry }) {
    const r = new this({ accountService, stateRegistry });
    r.id = d.id;
    return r;
  }

  reduce(state, action, date) {
    // Destination of the move (matches the residency flip below). When the
    // destination country steps up the cost base on becoming resident (AU
    // ITAA97 s855-45, design 36 §12.2), recordResidencyChange resets the AU
    // cost base for non-TAP CGT assets. Policy-driven — no hardcoded country.
    const country = 'AU';
    const stepUp  = stepsUpCostBaseOnResidency(country);

    // 1. Snapshot balanceAtResidencyChange on all registered accounts (and the
    //    residency cost-base step-up where the destination country applies one).
    for (const account of this.stateRegistry.getAccounts(state)) {
      this.accountService.recordResidencyChange(account, { country, stepUp });
    }

    // 2. Flip residency to 'AU' for every person; citizen arrays unchanged.
    //    Stamp residencySinceMs (the move date) so the FEIE full-qualifying-year
    //    gate can suppress the exclusion for the partial move-in year (design 52
    //    §4.2). Only stamp when not already resident, so a re-entry doesn't reset
    //    an existing qualifying period; leave prior stamps intact.
    const moveMs = date instanceof Date ? date.getTime() : (typeof date === 'number' ? date : null);
    const updatedPeople = {};
    if (state.people) {
      for (const [personKey, person] of Object.entries(state.people)) {
        const residencySinceMs = person.residency === 'AU'
          ? (person.residencySinceMs ?? moveMs)
          : moveMs;
        updatedPeople[personKey] = { ...person, residency: 'AU', residencySinceMs };
      }
    }

    return this.newState({
      ...state,
      people: Object.keys(updatedPeople).length > 0 ? updatedPeople : state.people,
    });
  }
}
