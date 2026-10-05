/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * super-fund-key.js — which super fund is a person's, once a person can hold several
 * (design 119 §6.3, phase 1).
 *
 * Two questions, kept apart because they have different answers:
 *
 *   - **Where does a contribution go?** One fund: the one the job names, else the
 *     person's first. `auSuperKeyFor`.
 *   - **What is the person's total superannuation balance?** Every fund they own,
 *     summed (ITAA 1997 s307-230(1)(a): "each of … a superannuation interest of
 *     yours"). `auSuperKeysOf`.
 *
 * Neither ever answers with another person's fund. The payroll handler used to fall back
 * to `getStateKey(SUPER)` with no owner, which in a two-person household where only one
 * person has a fund sent the other's SG into it. The one ownerless case kept is a fund
 * with no `ownerId` in a one-person household, where there is nobody else it could be.
 */

import { ACCOUNT_ROLES } from '../../state/account-roles.js';

const isSuper = a => a != null && typeof a === 'object' && a.role === ACCOUNT_ROLES.SUPER;

const householdSize = state => Object.keys(state?.people ?? {}).length;

/** A fund with no owner counts as the person's only in a one-person household. */
function ownerless(account, state) {
  return account?.ownerId == null && householdSize(state) <= 1;
}

/**
 * The super fund a contribution for `personKey` goes to, or null when they have none.
 *
 * @param {object} o
 * @param {object} o.state
 * @param {object} [o.stateRegistry]   resolves the person's first fund
 * @param {string} o.personKey
 * @param {string|null} [o.preferredKey]  the fund the in-force job names
 *        (`job.superAccountKey`). The loader has already checked it is the person's own
 *        super fund; it is re-checked here so a stale key can never route money to the
 *        wrong member.
 * @returns {string|null}
 */
export function auSuperKeyFor({ state, stateRegistry = null, personKey, preferredKey = null }) {
  if (preferredKey != null) {
    const a = state?.[preferredKey];
    if (isSuper(a) && (a.ownerId === personKey || ownerless(a, state))) return preferredKey;
  }
  const own = stateRegistry?.getStateKey?.(ACCOUNT_ROLES.SUPER, personKey);
  if (own != null && state?.[own] != null) return own;
  const any = stateRegistry?.getStateKey?.(ACCOUNT_ROLES.SUPER);
  if (any != null && ownerless(state?.[any], state)) return any;
  return null;
}

/**
 * Every super fund `personKey` owns, as state keys, in state order.
 *
 * Read off state rather than a registry, because the total-super-balance snapshot runs in
 * a reducer that has none. `recordedKey` (the fund payroll last paid into) and the legacy
 * key conventions are kept as a fallback for a fund state carries without a `role`, so a
 * plan that predates roles in state keeps its one-fund answer.
 *
 * @param {object} state
 * @param {string} personKey
 * @param {string|null} [recordedKey]
 * @returns {string[]}
 */
export function auSuperKeysOf(state, personKey, recordedKey = null) {
  const keys = [];
  for (const [key, a] of Object.entries(state ?? {})) {
    if (isSuper(a) && (a.ownerId === personKey || ownerless(a, state))) keys.push(key);
  }
  const legacy = legacySuperKey(state, personKey, recordedKey);
  if (legacy != null && !keys.includes(legacy)) keys.push(legacy);
  return keys;
}

/**
 * The single-fund answer from before design 119: the recorded key, then
 * `<person>SuperAccount`, then the household `superAccount` when it is theirs.
 */
function legacySuperKey(state, personKey, recordedKey) {
  if (recordedKey != null && state?.[recordedKey] != null) return recordedKey;
  const direct = `${personKey}SuperAccount`;
  if (state?.[direct] != null) return direct;
  // In a two-person household `superAccount` belongs to one of them; handing it to both
  // would count one balance as both their total superannuation balances.
  const shared = state?.superAccount;
  if (shared != null && (shared.ownerId === personKey || ownerless(shared, state))) {
    return 'superAccount';
  }
  return null;
}
