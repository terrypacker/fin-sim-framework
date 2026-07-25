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
