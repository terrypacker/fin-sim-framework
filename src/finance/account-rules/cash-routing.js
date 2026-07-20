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

/**
 * Resolve the destination cash key for a proceeds credit (asset/property/company
 * sale) that carries an optional pre-stamped `destinationKey` (design 55 §7.4).
 *
 * An explicit, still-valid `destinationKey` (a user-chosen sale destination) wins;
 * but a stamped key that is **absent from `state`** — e.g. a stale canonical
 * `usSavingsAccount`/`checkingAccount` baked by a handler after the account was
 * deleted or the transaction account was reflagged — must NOT be trusted. The bare
 * `destinationKey ?? resolveCashKey(...)` idiom only caught `null`, so an absent-but-
 * non-null key slipped through and hit `transaction(undefined)`. This existence
 * guard routes such a key back through the flag-aware {@link resolveCashKey} chain.
 *
 * @param {object} stateRegistry
 * @param {string} country
 * @param {object} state
 * @param {string|null|undefined} destinationKey - the action's stamped destination
 * @param {string|null} [ownerId=null]
 * @returns {string}
 */
export function resolveDestinationCashKey(stateRegistry, country, state, destinationKey, ownerId = null) {
  if (destinationKey != null && state[destinationKey] != null) return destinationKey;
  return resolveCashKey(stateRegistry, country, state, ownerId);
}

/**
 * Resolve a user-chosen sale destination (`saleDestinationAccount` on a company
 * equity / real property / collectible) to a state key, falling back to the
 * caller's default cash pool when it names nothing that exists (design 72 §2).
 *
 * The stored value is expected to be a state key; `ScenarioLoader` normalizes the
 * account-**id** form (which the asset editors persist whenever the chosen account
 * had no stateKey yet) up front, because runtime account state carries `stateKey`
 * but not `id` and so cannot resolve one. Anything that still names nothing in
 * `state` lands on `defaultKey` — silently, which is why the normalization
 * matters: the sale still "works", the proceeds simply land in cash instead of
 * the chosen investment account and earn the savings rate for the rest of the
 * run. That was Gap 2 — a marginal tranche compounding at ~3% instead of ~8%.
 *
 * @param {object} state
 * @param {string|null|undefined} saleDestinationAccount
 * @param {string} defaultKey - the caller's country cash-pool key
 * @returns {string}
 */
export function resolveSaleDestinationKey(state, saleDestinationAccount, defaultKey) {
  if (saleDestinationAccount && state[saleDestinationAccount] != null) return saleDestinationAccount;
  return defaultKey;
}

/**
 * Resolve a cash account GUARANTEED PRESENT in `state`, preferring `country`'s
 * pool and falling back to the OTHER country's when this country has none.
 *
 * `resolveCashKey` can return an absent legacy literal (`checkingAccount`) when a
 * country has no wired cash account — normally harmless because the sim only routes
 * a country's cash for people who bank there. Inheritance breaks that assumption: an
 * inherited **US** IRA distribution (design 63 §6.2) or **AU** super lump-sum (§6.4)
 * forces cash movement in a country the heir may not bank in at all (e.g. an
 * AU-resident US-citizen heir with no US cash, §7). The bare key would then strand
 * the proceeds or crash `transaction(undefined)`.
 *
 * This picks the heir's cash *wherever it exists*, so the caller can currency-convert
 * and land/source the money cross-border instead of stranding it. Returns
 * `{ key, account, country, crossed }` (`crossed` = fell back to the other country),
 * or `null` when the household holds no cash account in EITHER country (degenerate —
 * callers no-op rather than fabricate one).
 *
 * @param {object} stateRegistry
 * @param {string} country - preferred ISO country ('US' | 'AU')
 * @param {object} state
 * @param {string|null} [ownerId=null]
 * @returns {{ key: string, account: object, country: string, crossed: boolean } | null}
 */
export function resolvePresentCash(stateRegistry, country, state, ownerId = null) {
  const localKey = resolveCashKey(stateRegistry, country, state, ownerId);
  if (state[localKey] != null) {
    return { key: localKey, account: state[localKey], country, crossed: false };
  }
  const other    = country === 'AU' ? 'US' : 'AU';
  const otherKey = resolveCashKey(stateRegistry, other, state, ownerId);
  if (state[otherKey] != null) {
    return { key: otherKey, account: state[otherKey], country: other, crossed: true };
  }
  return null;
}
