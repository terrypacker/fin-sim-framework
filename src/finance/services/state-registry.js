/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * StateRegistry — query facade for resolving simulation state objects by
 * semantic role rather than hard-coded state key strings.
 *
 * Holds a reference to AccountService (populated at scenario build time).
 * Every registered account has a `stateKey` stamped by SimulationState
 * `_assignAccount`, so lookups bridge the service registry to the live state.
 *
 * Usage:
 *   const account = stateRegistry.getAccount(state, ACCOUNT_ROLES.ROTH, primary.id);
 *   const auAccounts = stateRegistry.getAccounts(state, { country: 'AU' });
 *
 * Designed for extension: future methods can cover people, assets, etc.
 */
export class StateRegistry {
  /**
   * @param {object} opts
   * @param {import('./account-service.js').AccountService} opts.accountService
   */
  constructor({ accountService }) {
    this._accountService = accountService;
  }

  /**
   * Returns the live state object for the first account matching role + ownerId.
   *
   * @param {object}      state   - Current simulation state
   * @param {string}      role    - ACCOUNT_ROLES value (e.g. 'roth-ira')
   * @param {string|null} [ownerId=null] - Person id; null matches any owner
   * @returns {object|null}
   */
  getAccount(state, role, ownerId = null) {
    for (const account of this._accountService.getAll()) {
      if (account.role !== role) continue;
      if (ownerId !== null && account.ownerId !== ownerId) continue;
      return state[account.stateKey] ?? null;
    }
    return null;
  }

  /**
   * Returns the stateKey for the first account matching role + ownerId.
   * Useful for building RecordBalanceAction paths without holding a state reference.
   *
   * @param {string}      role    - ACCOUNT_ROLES value
   * @param {string|null} [ownerId=null] - Person id; null matches any owner
   * @returns {string|null}
   */
  getStateKey(role, ownerId = null) {
    for (const account of this._accountService.getAll()) {
      if (account.role !== role) continue;
      if (ownerId !== null && account.ownerId !== ownerId) continue;
      return account.stateKey ?? null;
    }
    return null;
  }

  /**
   * Returns all live state account objects matching all provided filters.
   * Omit a filter key to match all values for that field.
   *
   * @param {object} state
   * @param {object} [filters]
   * @param {string} [filters.role]        - ACCOUNT_ROLES value
   * @param {string} [filters.ownerId]     - Person id
   * @param {string} [filters.country]     - ISO country code ('US', 'AU')
   * @param {string} [filters.accountType] - ACCOUNT_TYPE value
   * @returns {object[]}
   */
  getAccounts(state, { role, ownerId, country, accountType } = {}) {
    const results = [];
    for (const account of this._accountService.getAll()) {
      if (role        !== undefined && account.role    !== role)        continue;
      if (ownerId     !== undefined && account.ownerId !== ownerId)     continue;
      if (country     !== undefined && account.country !== country)     continue;
      if (accountType !== undefined && account.type    !== accountType) continue;
      const stateAccount = state[account.stateKey];
      if (stateAccount != null) results.push(stateAccount);
    }
    return results;
  }
}
