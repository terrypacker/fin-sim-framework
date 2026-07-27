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
 * Build a reverse-lookup map from person.id → personKey for state.people.
 *
 * @param {object} people - state.people: { personKey: Person | null }
 * @returns {Map<string, string>}
 */
function personIdToKey(people) {
  const map = new Map();
  for (const [key, person] of Object.entries(people)) {
    if (person?.id != null) map.set(person.id, key);
  }
  return map;
}

/**
 * Compute per-person ownership fractions for an asset.
 *
 * Resolution order:
 *   1. RealProperty.owners array  → use each entry's ownershipPct (0-100 scale)
 *   2. ownershipType === 'sole'   → 100% to the person whose id === asset.ownerId
 *   3. Joint / fallback           → split evenly across all non-null people
 *
 * @param {object} asset   - Asset or RealProperty instance
 * @param {object} people  - state.people: { personKey: Person | null }
 * @returns {{ personKey: string, fraction: number }[]}  — fractions sum to 1.0
 */
export function ownershipFractions(asset, people) {
  if (asset.owners?.length > 0) {
    const byId = personIdToKey(people);
    return asset.owners
      .map(({ personId, ownershipPct }) => {
        const personKey = byId.get(personId);
        return personKey ? { personKey, fraction: ownershipPct / 100 } : null;
      })
      .filter(Boolean);
  }

  if (asset.ownershipType === 'sole' && asset.ownerId != null) {
    const byId = personIdToKey(people);
    const personKey = byId.get(asset.ownerId);
    if (personKey) return [{ personKey, fraction: 1.0 }];
  }

  // Joint or unresolved sole — split evenly across all present people.
  const keys = Object.entries(people)
    .filter(([, p]) => p != null)
    .map(([k]) => k);
  if (keys.length === 0) return [];
  const fraction = 1.0 / keys.length;
  return keys.map(personKey => ({ personKey, fraction }));
}

/**
 * Split an amount across owners according to the asset's ownership model.
 *
 * @param {object} asset   - Asset or RealProperty instance
 * @param {number} amount  - Total amount to split
 * @param {object} people  - state.people: { personKey: Person | null }
 * @returns {{ personKey: string, amount: number }[]}
 */
export function splitByOwnership(asset, amount, people) {
  return ownershipFractions(asset, people).map(({ personKey, fraction }) => ({
    personKey,
    amount: amount * fraction,
  }));
}

/**
 * Resolve the account an income item should be attributed to.
 *
 * Attribution must follow the account that actually produced the income, not a
 * canonical state key: a household with two accounts in the same role (design 55)
 * has one `auSavingsAccount` and one `spouseAuSavingsAccount`, and reading the
 * canonical key alone attributes *both* accounts' interest to the first one's owner.
 * Emitting reducers therefore stamp `stateKey` on the tax action and this resolves it.
 *
 * `canonicalKey` is the pre-design-55 single-account key, kept as the fallback for
 * legacy bare-event dispatchers and pre-stateKey saved actions. A stamped key that
 * no longer resolves (account deleted or re-flagged mid-run) also falls back rather
 * than returning undefined — the same absent-but-non-null trap that
 * `resolveDestinationCashKey` was added to close on the sale path.
 *
 * @param {object} state        - Simulation state snapshot
 * @param {object} action       - Tax action, optionally carrying `stateKey`
 * @param {string} canonicalKey - Fallback state key
 * @returns {object|null}       - The account object, or null if neither resolves
 */
export function resolveAttributionAsset(state, action, canonicalKey) {
  const stamped = action?.stateKey;
  if (stamped != null && state?.[stamped] != null) return state[stamped];
  return state?.[canonicalKey] ?? null;
}

/**
 * Resolve who an income item belongs to, from whatever identifier its action carries.
 *
 * Design 76 §7 settled one identifier per income shape, chosen so each emit site
 * stamps what it naturally has to hand:
 *
 *   1. `personKey`  — person-derived income with no account behind it: wages,
 *                     self-employment, Social Security. Always 100% to the earner
 *                     or recipient; personal services income is never apportionable.
 *   2. `stateKey`   — account-derived income. Resolves to the account, then to its
 *                     owners, keeping ownership resolution in exactly one place.
 *   3. inline owner  — asset-derived income whose asset is not an account and may
 *      fields         not be in state under a stable key: real property, collectibles,
 *                     company equity. The emitter stamps ownership onto the action.
 *
 * Returns null when nothing resolves, which callers MUST treat as "fall back to the
 * household scalar" rather than as an even split — the even split is precisely the
 * bug design 76 exists to remove, and a silent one is worse than a loud scalar.
 *
 * @param {object} state        - Simulation state snapshot
 * @param {object} action       - Tax action carrying personKey | stateKey | owner fields
 * @param {string} canonicalKey - Fallback state key for the account-derived case
 * @returns {{ personKey: string, fraction: number }[] | null}
 */
export function resolveAttributionFractions(state, action, canonicalKey) {
  // (1) Explicit person — the earner/recipient, whole. Deliberately NOT gated on
  // state.people: a personKey already IS a person key, so there is nothing to
  // resolve. Only the ownership branches below need the people map (to turn
  // person *ids* into person *keys*). When state.people is present we still use it
  // to reject an unknown key rather than inventing a person.
  if (action?.personKey != null) {
    if (state?.people != null && state.people[action.personKey] == null) return null;
    return [{ personKey: action.personKey, fraction: 1.0 }];
  }

  if (state?.people == null) return null;

  // (3) Ownership stamped inline on the action (asset is not an account).
  const hasInlineOwnership = action?.ownershipType != null
                          || action?.ownerId      != null
                          || action?.owners       != null;
  const asset = hasInlineOwnership
    ? { ownershipType: action.ownershipType, ownerId: action.ownerId, owners: action.owners }
    // (2) Account-derived — resolve the account, then its owners.
    : resolveAttributionAsset(state, action, canonicalKey);
  if (asset == null) return null;

  const fractions = ownershipFractions(asset, state.people);
  return fractions.length > 0 ? fractions : null;
}

/**
 * Apply a per-person split to an existing per-person accumulator map.
 * Returns a new map (does not mutate the input).
 *
 * @param {object} personMap   - Existing { personKey: number } accumulator
 * @param {object} asset       - Asset or RealProperty instance
 * @param {number} amount      - Total amount to distribute
 * @param {object} people      - state.people
 * @returns {object}           - Updated accumulator map
 */
export function accumulateByOwnership(personMap, asset, amount, people) {
  const next = { ...personMap };
  for (const { personKey, amount: share } of splitByOwnership(asset, amount, people)) {
    next[personKey] = (next[personKey] ?? 0) + share;
  }
  return next;
}
