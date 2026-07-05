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
 * Canonical country codes for the simulation.
 *
 * The project standardizes on ISO-3166-1 alpha-2 (`'US'`, `'AU'`) for every
 * country-coded value: tax/account `cc`, `person.residency`, `person.citizen[]`,
 * `country` on accounts/properties, and the `startingResidency` parameter. This
 * means the residency namespace is identical to the tax `cc` namespace — a
 * resident's country code IS the country whose tax module applies, so no
 * cross-namespace conversion is ever needed.
 *
 * Legacy spellings (`'AUS'`, `'USA'`) predate this convention; `normalizeCountryCode`
 * maps them forward and is applied to externally-sourced data (persisted scenarios)
 * at the loader boundary.
 */

export const US = 'US';
export const AU = 'AU';

/** All canonical country codes. */
export const COUNTRY_CODES = Object.freeze([US, AU]);

const _CURRENCY_BY_COUNTRY = Object.freeze({ [US]: 'USD', [AU]: 'AUD' });

/**
 * Currency code for a country, or `null` when the country is unknown.
 * @param {string} cc - ISO-3166-1 alpha-2 country code
 * @returns {string|null}
 */
export function currencyForCountry(cc) {
  return _CURRENCY_BY_COUNTRY[cc] ?? null;
}

/**
 * Currency code for a country, defaulting to USD for an unknown country.
 * @param {string} cc - ISO-3166-1 alpha-2 country code
 * @returns {string}
 */
export function defaultCurrencyForCountry(cc) {
  return currencyForCountry(cc) ?? 'USD';
}

const _NORMALIZE = Object.freeze({ AUS: AU, USA: US });

/**
 * Map a legacy/long-form country code to its canonical alpha-2 form.
 * Unknown or already-canonical values pass through unchanged; nullish passes through.
 * @param {string|null|undefined} raw
 * @returns {string|null|undefined}
 */
export function normalizeCountryCode(raw) {
  if (raw == null) return raw;
  return _NORMALIZE[raw] ?? raw;
}