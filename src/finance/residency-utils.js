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
 * Pure helpers for reading per-person residency and birth date from simulation state.
 * All functions take plain state — no service injection required.
 *
 * Co-located with ownership-utils.js.
 */

/**
 * Country code of the person identified by `personKey`.
 *
 * @param {object} state     - Simulation state containing state.people
 * @param {string} personKey - Key into state.people (e.g. 'primary', 'spouse')
 * @returns {string|null}    - Country code (e.g. 'US', 'AU') or null if not found
 */
export function getResidency(state, personKey) {
  return state.people?.[personKey]?.residency ?? null;
}

/**
 * True iff that person's residency matches the given country code.
 *
 * @param {object} state     - Simulation state
 * @param {string} personKey - Key into state.people
 * @param {string} country   - Country code to test (e.g. 'AU')
 * @returns {boolean}
 */
export function isResident(state, personKey, country) {
  return getResidency(state, personKey) === country;
}

/**
 * Array of personKeys whose residency matches `country`.
 *
 * @param {object} state   - Simulation state
 * @param {string} country - Country code (e.g. 'AU')
 * @returns {string[]}
 */
export function residentsOf(state, country) {
  if (!state.people) return [];
  return Object.entries(state.people)
    .filter(([, p]) => p?.residency === country)
    .map(([k]) => k);
}

/**
 * Primary person's key — the first entry in state.people. Matches the
 * "first person is primary" convention used elsewhere (e.g. TaxLossHarvestHandler's
 * _primaryResidency, replenishSavings' default personKey).
 *
 * @param {object} state - Simulation state
 * @returns {string|null}
 */
export function primaryPersonKey(state) {
  const keys = Object.keys(state.people ?? {});
  return keys.length > 0 ? keys[0] : null;
}

/**
 * Household US residency state, derived from the PRIMARY person (design 34 §4).
 * Both people are assumed to share a state, so only the primary is consulted;
 * the spouse's residencyState exists for a future per-person model but is not
 * read here. Returns null when no state is configured (⇒ no state income tax).
 *
 * @param {object} state - Simulation state
 * @returns {string|null}  e.g. 'NE' | 'HI' | 'SD' | null
 */
export function primaryResidencyState(state) {
  const key = primaryPersonKey(state);
  return key ? (state.people[key]?.residencyState ?? null) : null;
}

/**
 * Birth date of the person identified by `personKey`.
 * Replaces the single-valued `state.personBirthDate` field.
 *
 * @param {object} state     - Simulation state
 * @param {string} personKey - Key into state.people
 * @returns {Date|null}
 */
export function getBirthDate(state, personKey) {
  const raw = state.people?.[personKey]?.birthDate;
  if (raw == null) return null;
  return raw instanceof Date ? raw : new Date(raw);
}
