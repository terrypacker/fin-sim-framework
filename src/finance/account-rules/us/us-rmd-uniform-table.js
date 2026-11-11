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
 * IRS Uniform Lifetime Table (Publication 590-B, updated for SECURE 2.0 Act).
 * Maps whole age → distribution period divisor used to compute annual RMD:
 *   RMD = prior-Dec-31 IRA balance / distributionPeriod
 */
const IRS_UNIFORM_LIFETIME_TABLE = Object.freeze({
  73: 26.5, 74: 25.5, 75: 24.6, 76: 23.7, 77: 22.9, 78: 22.0,
  79: 21.1, 80: 20.2, 81: 19.4, 82: 18.5, 83: 17.7, 84: 16.8,
  85: 16.0, 86: 15.2, 87: 14.4, 88: 13.7, 89: 12.9, 90: 12.2,
  91: 11.5, 92: 10.8, 93: 10.1, 94:  9.5, 95:  8.9, 96:  8.4,
  97:  7.8, 98:  7.3, 99:  6.8, 100: 6.4, 101: 6.0, 102: 5.6,
  103: 5.2, 104: 4.9, 105: 4.6, 106: 4.3, 107: 4.1, 108: 3.9,
  109: 3.7, 110: 3.5, 111: 3.4, 112: 3.3, 113: 3.1, 114: 3.0,
  115: 2.9, 116: 2.8, 117: 2.7, 118: 2.5, 119: 2.3, 120: 2.0,
});

/**
 * The RMD "applicable age" for an owner, from their birth date (IRC §401(a)(9)(C)(v), SECURE 2.0;
 * §408(a)(6) applies it to IRAs). Text on disk: docs/us-tax/…-sec401.txt:89–91.
 *   (I)  attains 72 after 31 Dec 2022 and 73 before 1 Jan 2033 → 73
 *   (II) attains 74 after 31 Dec 2032                          → 75
 * So born 1960 or later → 75. Born 1959 satisfies BOTH clauses on the statute's text (73 in
 * 2032, 74 in 2033); we use 73, the earlier start. Confirm against the final regulations, which are
 * not on disk. Born before 1951 had an older age (72 / 70½), but those owners are already past it
 * in any run starting 2026 or later, and the table below starts at 73, so 73 is returned for them too.
 *
 * @param {Date|string|number|null|undefined} birthDate
 * @returns {number} 73 or 75 (73 when the birth date is unknown)
 */
export function usRmdApplicableAge(birthDate) {
  if (birthDate == null) return 73;
  const d = birthDate instanceof Date ? birthDate : new Date(birthDate);
  const y = d.getUTCFullYear();
  if (!Number.isFinite(y)) return 73;
  return y >= 1960 ? 75 : 73;
}

/**
 * Returns the IRS Uniform Lifetime distribution period for a given whole age.
 * Ages above 120 are capped at the age-120 factor (2.0).
 * Returns null for ages below the RMD threshold (73).
 *
 * @param {number} age - whole years of age
 * @returns {number | null}
 */
export function getUniformDistributionPeriod(age) {
  const intAge = Math.floor(age);
  if (intAge < 73) return null;
  return IRS_UNIFORM_LIFETIME_TABLE[intAge] ?? IRS_UNIFORM_LIFETIME_TABLE[120];
}
