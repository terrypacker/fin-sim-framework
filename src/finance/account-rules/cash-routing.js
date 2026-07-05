/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { ACCOUNT_ROLES } from '../state/account-roles.js';

/**
 * Resolve the state key of the cash pool a country's debits/credits should hit
 * (design 55 Phase 6b). This is the single routing point that honors a flagged
 * "transaction account": every account-rule reducer/handler that moves cash in or
 * out of the household hub goes through here so a non-default transaction account
 * is respected everywhere — not just wages/expenses (Phase 6a).
 *
 * Fallback chain (first hit wins):
 *   1. `resolveTransactionAccountKey(country, ownerId)` — an account explicitly
 *      flagged `isTransactionAccount` (owner-preferred, then any owner).
 *   2. `getStateKey(savingsRole, ownerId)` — the owner's savings account.
 *   3. `getStateKey(savingsRole)` — any savings account for the country.
 *   4. Legacy literal: `usSavingsAccount`/`auSavingsAccount` if present in state,
 *      else `checkingAccount`.
 *
 * The registry hit is only used when the resolved account actually exists in the
 * live `state` (guards against a renamed/absent stateKey); otherwise the legacy
 * literal is returned. When there is no `stateRegistry` (partial test stubs) the
 * chain short-circuits straight to the legacy literal — byte-for-byte with the
 * old `state.usSavingsAccount ?? state.checkingAccount` helpers.
 *
 * Method-level optional chaining (`?.()`) is load-bearing: several hand-rolled
 * test stubs supply a partial `stateRegistry` exposing only `getStateKey`, so
 * `resolveTransactionAccountKey?.()` must short-circuit a missing method.
 *
 * @param {import('../services/state-registry.js').StateRegistry} [stateRegistry]
 * @param {string} country - ISO country code ('US' | 'AU')
 * @param {object} state   - Current simulation state (for the legacy tail + guard)
 * @param {string|null} [ownerId=null] - Preferred owner; null = any owner
 * @returns {string} A state key guaranteed present in `state` (or the legacy key).
 */
export function resolveCashKey(stateRegistry, country, state, ownerId = null) {
  const isAu = country === 'AU';
  const savingsRole = isAu ? ACCOUNT_ROLES.AU_SAVINGS : ACCOUNT_ROLES.US_SAVINGS;
  const legacyKey = isAu
    ? (state.auSavingsAccount != null ? 'auSavingsAccount' : 'checkingAccount')
    : (state.usSavingsAccount != null ? 'usSavingsAccount' : 'checkingAccount');

  const resolved =
       stateRegistry?.resolveTransactionAccountKey?.(country, ownerId)
    ?? stateRegistry?.getStateKey?.(savingsRole, ownerId)
    ?? stateRegistry?.getStateKey?.(savingsRole);

  return (resolved != null && state[resolved] != null) ? resolved : legacyKey;
}
