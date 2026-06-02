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
 * @returns {string|null}    - Country code (e.g. 'US', 'AUS') or null if not found
 */
export function getResidency(state, personKey) {
  return state.people?.[personKey]?.residency ?? null;
}

/**
 * True iff that person's residency matches the given country code.
 *
 * @param {object} state     - Simulation state
 * @param {string} personKey - Key into state.people
 * @param {string} country   - Country code to test (e.g. 'AUS')
 * @returns {boolean}
 */
export function isResident(state, personKey, country) {
  return getResidency(state, personKey) === country;
}

/**
 * Array of personKeys whose residency matches `country`.
 *
 * @param {object} state   - Simulation state
 * @param {string} country - Country code (e.g. 'AUS')
 * @returns {string[]}
 */
export function residentsOf(state, country) {
  if (!state.people) return [];
  return Object.entries(state.people)
    .filter(([, p]) => p?.residency === country)
    .map(([k]) => k);
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
