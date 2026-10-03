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
 * US Social Security claiming rules (design 118 §4–§5.2): full retirement age by birth
 * date, the month entitlement begins, and the factor an early or late claim applies to
 * the primary insurance amount (PIA). Pure functions of dates; no state.
 *
 * Every table is transcribed row by row from the regulation saved in
 * `docs/us-social-security/` and checked against that file by
 * `tests/unit/us-social-security-rules.test.mjs`, so a typo here fails a test rather than
 * a plan. These are law by birth date, not by tax year, so they are not repeated in the
 * per-year account modules.
 *
 * Months are counted as a UTC month index (`year × 12 + month`), so the difference of two
 * indexes is a number of whole months.
 */

/** Claim ages a person may choose, in whole years (design 118 D1). */
export const SS_MIN_CLAIM_AGE = 62;
export const SS_MAX_CLAIM_AGE = 70;
export const SS_CLAIM_AGES    = Object.freeze(
  Array.from({ length: SS_MAX_CLAIM_AGE - SS_MIN_CLAIM_AGE + 1 }, (_, i) => SS_MIN_CLAIM_AGE + i));

// Each row applies from its `from` birth date (inclusive) until the next row's. A null
// `from` is the open first row ("Before 1/2/1938").

/** 20 CFR 404.409(a): FRA for old-age, wife's and husband's benefits. */
export const FRA_OWN_TABLE = Object.freeze([
  { from: null,         years: 65, months: 0 },
  { from: '1938-01-02', years: 65, months: 2 },
  { from: '1939-01-02', years: 65, months: 4 },
  { from: '1940-01-02', years: 65, months: 6 },
  { from: '1941-01-02', years: 65, months: 8 },
  { from: '1942-01-02', years: 65, months: 10 },
  { from: '1943-01-02', years: 66, months: 0 },
  { from: '1955-01-02', years: 66, months: 2 },
  { from: '1956-01-02', years: 66, months: 4 },
  { from: '1957-01-02', years: 66, months: 6 },
  { from: '1958-01-02', years: 66, months: 8 },
  { from: '1959-01-02', years: 66, months: 10 },
  { from: '1960-01-02', years: 67, months: 0 },
]);

/** 20 CFR 404.409(b): FRA for widow's and widower's benefits. */
export const FRA_SURVIVOR_TABLE = Object.freeze([
  { from: null,         years: 62, months: 0 },
  { from: '1912-01-02', years: 65, months: 0 },
  { from: '1940-01-02', years: 65, months: 2 },
  { from: '1941-01-02', years: 65, months: 4 },
  { from: '1942-01-02', years: 65, months: 6 },
  { from: '1943-01-02', years: 65, months: 8 },
  { from: '1944-01-02', years: 65, months: 10 },
  { from: '1945-01-02', years: 66, months: 0 },
  { from: '1957-01-02', years: 66, months: 2 },
  { from: '1958-01-02', years: 66, months: 4 },
  { from: '1959-01-02', years: 66, months: 6 },
  { from: '1960-01-02', years: 66, months: 8 },
  { from: '1961-01-02', years: 66, months: 10 },
  { from: '1962-01-02', years: 67, months: 0 },
]);

/** 20 CFR 404.313(b)(2): delayed retirement credit per month, as a fraction of 1%. */
export const DRC_TABLE = Object.freeze([
  { from: null,         num: 1,  den: 12 },
  { from: '1917-01-02', num: 1,  den: 4 },
  { from: '1925-01-02', num: 7,  den: 24 },
  { from: '1927-01-02', num: 1,  den: 3 },
  { from: '1929-01-02', num: 3,  den: 8 },
  { from: '1931-01-02', num: 5,  den: 12 },
  { from: '1933-01-02', num: 11, den: 24 },
  { from: '1935-01-02', num: 1,  den: 2 },
  { from: '1937-01-02', num: 13, den: 24 },
  { from: '1939-01-02', num: 7,  den: 12 },
  { from: '1941-01-02', num: 5,  den: 8 },
  { from: '1943-01-02', num: 2,  den: 3 },
]);

// ── Dates and months ───────────────────────────────────────────────────────────

/** A birth date (Date, ISO string or epoch ms) as a UTC Date. */
function toDate(d) {
  return d instanceof Date ? d : new Date(d);
}

/** UTC month index of a date: year × 12 + month. */
export function monthIndex(date) {
  const d = toDate(date);
  return d.getUTCFullYear() * 12 + d.getUTCMonth();
}

/** Epoch ms of the first day of a month index. */
export function monthIndexToMs(mi) {
  return Date.UTC(Math.floor(mi / 12), ((mi % 12) + 12) % 12, 1);
}

/**
 * The day a person attains an age: the day BEFORE the birthday (20 CFR 404.102). A
 * birthday that does not exist in the target month (31 Jan + 1 month) is the month's
 * last day.
 */
export function attainDate(birthDate, years, months = 0) {
  const b  = toDate(birthDate);
  const y  = b.getUTCFullYear() + years;
  const m  = b.getUTCMonth() + months;
  const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  const birthday = Date.UTC(y, m, Math.min(b.getUTCDate(), lastDay));
  return new Date(birthday - 86_400_000);
}

/** Month index in which a person attains an age. */
export function attainMonth(birthDate, years, months = 0) {
  return monthIndex(attainDate(birthDate, years, months));
}

function rowFor(table, birthDate) {
  const t = toDate(birthDate).getTime();
  let row = table[0];
  for (const r of table) if (r.from != null && Date.parse(r.from) <= t) row = r;
  return row;
}

// ── Full retirement age ─────────────────────────────────────────────────────────

/**
 * Full retirement age for a birth date.
 * @param {Date|string|number} birthDate
 * @param {'own'|'survivor'} [kind='own']  'own' also covers spousal benefits (404.409(a))
 * @returns {{ years: number, months: number }}
 */
export function fullRetirementAge(birthDate, kind = 'own') {
  const { years, months } = rowFor(kind === 'survivor' ? FRA_SURVIVOR_TABLE : FRA_OWN_TABLE, birthDate);
  return { years, months };
}

/** Month index in which a person attains full retirement age. */
export function fraMonth(birthDate, kind = 'own') {
  const { years, months } = fullRetirementAge(birthDate, kind);
  return attainMonth(birthDate, years, months);
}

/**
 * Normalize an authored claim age: blank → null (claim at FRA), otherwise a whole number
 * of years in 62–70. A numeric string (a select's value) is accepted.
 * @throws {Error} on anything else, so a bad save fails at load rather than mid-run
 */
export function normalizeClaimAge(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < SS_MIN_CLAIM_AGE || n > SS_MAX_CLAIM_AGE) {
    throw new Error(`ssClaimAge must be a whole number of years from ${SS_MIN_CLAIM_AGE} to `
      + `${SS_MAX_CLAIM_AGE}, or blank for full retirement age; got ${JSON.stringify(v)}`);
  }
  return n;
}

/**
 * The first month a person is entitled to their own benefit when they claim at
 * `claimAge` (20 CFR 404.311(a)). From FRA on, it is the month the age is attained.
 * Before FRA it is the first month they are that age THROUGHOUT, which is the month of
 * attainment only when the age is attained on the 1st (a birthday on the 2nd).
 *
 * @param {Date|string|number} birthDate
 * @param {number|null} claimAge  whole years, or null for exactly FRA
 * @returns {number} month index
 */
export function entitlementMonth(birthDate, claimAge) {
  const fra = fraMonth(birthDate);
  const age = normalizeClaimAge(claimAge);
  if (age == null) return fra;
  const attained = attainDate(birthDate, age);
  const mi = monthIndex(attained);
  if (mi >= fra) return mi;
  return attained.getUTCDate() === 1 ? mi : mi + 1;
}

// ── The own-benefit factor ─────────────────────────────────────────────────────

/** Delayed retirement credit per month for a birth date, as a fraction (2/3 of 1% = 0.00667). */
export function drcMonthlyRate(birthDate) {
  const { num, den } = rowFor(DRC_TABLE, birthDate);
  return num / den / 100;
}

/**
 * Reduction for an old-age benefit `monthsEarly` months before FRA, as a fraction of the
 * PIA: 5/9 of 1% for each of the first 36 months, 5/12 of 1% beyond (20 CFR 404.410(a)).
 */
export function earlyReduction(monthsEarly) {
  const n = Math.max(0, monthsEarly);
  return (Math.min(n, 36) * 5 / 9 + Math.max(0, n - 36) * 5 / 12) / 100;
}

/**
 * The factor applied to the PIA for a person entitled in `entitledMi`, as paid in month
 * `asOfMi`.
 *
 * - Before FRA: 1 − the 404.410(a) reduction.
 * - After FRA: 1 + one credit per month from FRA to entitlement, capped at the month
 *   they attain 70 (404.313(a)). Credits earned in the year of filing are added the
 *   following January, unless the filing is at 70, when they are added at once
 *   (404.313(c)(2)–(3)). So the factor can step up once, the January after entitlement.
 *
 * @param {Date|string|number} birthDate
 * @param {number} entitledMi  month index entitlement began
 * @param {number} [asOfMi]    month index being paid; defaults to all credits applied
 * @returns {number}
 */
export function ownFactor(birthDate, entitledMi, asOfMi = Infinity) {
  const fra = fraMonth(birthDate);
  if (entitledMi < fra) return 1 - earlyReduction(fra - entitledMi);
  const at70    = attainMonth(birthDate, 70);
  const credits = Math.min(entitledMi, at70 + 1) - fra;
  let applied = credits;
  if (entitledMi < at70 && Math.floor(asOfMi / 12) <= Math.floor(entitledMi / 12)) {
    // Still the year of filing: only the credits up to the previous December count.
    const filingYearStart = Math.floor(entitledMi / 12) * 12;
    applied = Math.max(0, Math.min(credits, filingYearStart - fra));
  }
  return 1 + applied * drcMonthlyRate(birthDate);
}

// ── The spousal benefit (design 118 §4.4, phase 3) ──────────────────────────────

/**
 * Reduction for a wife's or husband's benefit `monthsEarly` months before FRA, as a
 * fraction: 25/36 of 1% for each of the first 36 months, 5/12 of 1% beyond
 * (20 CFR 404.410(b)).
 */
export function spousalReduction(monthsEarly) {
  const n = Math.max(0, monthsEarly);
  return (Math.min(n, 36) * 25 / 36 + Math.max(0, n - 36) * 5 / 12) / 100;
}

/**
 * The factor applied to a spousal benefit that starts in `spousalStartMi`. The months are
 * counted to the spouse's own FRA, table 404.409(a), which covers wife's and husband's
 * benefits. Never above 1: delayed credits are an increase to the old-age benefit only
 * (42 U.S.C. 402(w); 20 CFR 404.313(e)(2)).
 */
export function spousalFactor(birthDate, spousalStartMi) {
  return 1 - spousalReduction(fraMonth(birthDate) - spousalStartMi);
}

/**
 * The spousal amount payable on top of a person's own benefit, for one month (20 CFR
 * 404.330(d), 404.333, 404.407(a); 42 U.S.C. 402(q)(3)(B); POMS RS 00615.020 method C and
 * RS 00615.694):
 *
 * 1. The full spousal benefit is half the worker's PIA. A person whose own PIA is equal or
 *    larger is not entitled to it, so nothing is payable.
 * 2. The excess of the full spousal benefit over the person's own PIA is reduced by the
 *    spousal factor.
 * 3. The combined amount is the own benefit without delayed credits plus that excess. The
 *    own benefit WITH its credits is subtracted from it, and the rest, not below zero, is
 *    the spousal amount. Delayed credits on the person's own benefit therefore eat into
 *    the excess rather than adding to it.
 *
 * A person with no record of their own passes `ownPia` 0 and both own benefits 0.
 *
 * @param {object} p
 * @param {number} p.ownPia           the person's own PIA
 * @param {number} p.workerPia        the spouse's PIA
 * @param {number} p.ownBenefit       the person's own benefit this month, credits included
 * @param {number} p.ownBenefitNoDrc  the same benefit without delayed credits
 * @param {number} p.factor           `spousalFactor` for the month the spousal benefit began
 * @returns {number}
 */
export function spousalPayable({ ownPia, workerPia, ownBenefit, ownBenefitNoDrc, factor }) {
  const full = workerPia / 2;
  if (ownPia >= full) return 0;
  return Math.max(0, ownBenefitNoDrc + (full - ownPia) * factor - ownBenefit);
}
