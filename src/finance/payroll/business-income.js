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
 * business-income.js — a person's sole-proprietor business income (design 134 §8.3, step 4b).
 *
 * `cfg.businessIncome` holds one flat row per business:
 *
 * ```js
 * { id, personId, name?, kind: 'SCHEDULE_F',
 *   startDate, endDate?,          // 'YYYY-MM-DD'; a year pays when its payment date is inside
 *   paymentDay?,                  // 'MM-DD', default '12-15'
 *   net,                          // the year's Schedule F net, signed: a loss is negative
 *   neCommunityCollegeTax?,       // Nebraska community-college tax paid that year (77-6706)
 *   source? }                     // where it came from (the farm export), for reading only
 * ```
 *
 * A job with `selfEmployed: true` does not fit this (design 134 §8.3): a job is a monthly wage
 * that grows, and design 116 D3 allows one job at a time, while a farmer can also hold an
 * off-farm job. A business-income row is one signed amount a year.
 *
 * **The same year repeats** (design 134 §16.1). The farm export's one full Schedule F is the
 * crop year's, and it already holds last season's carry-in and next season's prepay, so the row
 * pays it every year from `startDate` to `endDate`. `net` is in the money of the FIRST year the
 * row pays; each later year is indexed by US CPI from there. That is why the index base is the
 * accumulator on the first payment, not at sim start: the export's amounts are crop-year
 * dollars, which a sim that starts before the crop year must not inflate again.
 *
 * Kept a leaf (no imports) for the reason `employment.js` is.
 */

export const BUSINESS_INCOME_KINDS = Object.freeze({
  SCHEDULE_F: 'SCHEDULE_F',
});

/**
 * The default day a year's net reaches the household. Before 31 December, when the US and
 * state returns settle, so the year's income is on its own year's return.
 */
export const DEFAULT_PAYMENT_DAY = '12-15';

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_DAY = /^(\d{2})-(\d{2})$/;

/** A valid 'MM-DD' (no 29 February: it would skip three years in four). */
function validMonthDay(s) {
  const m = MONTH_DAY.exec(s ?? '');
  if (!m) return false;
  const [mo, d] = [Number(m[1]), Number(m[2])];
  const days = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return mo >= 1 && mo <= 12 && d >= 1 && d <= days[mo - 1];
}

/**
 * Every reason the scenario's business-income rows cannot run. Errors, as for jobs
 * (design 116 §4.6): an orphaned or undated row would be a silently missing income.
 *
 * @param {Array<object>} rows    `cfg.businessIncome`
 * @param {Array<object>} persons cfg person records (only `id` is read)
 * @returns {string[]} empty when valid
 */
export function validateBusinessIncome(rows, persons) {
  const errors = [];
  if (rows == null) return errors;
  if (!Array.isArray(rows)) return ['businessIncome must be a list'];
  const personIds = new Set((persons ?? []).map(p => p?.id));
  const seen = new Set();
  for (const r of rows) {
    const label = `Business income "${r?.id ?? '?'}"`;
    if (r?.id == null || r.id === '') { errors.push('Business income: `id` is required.'); continue; }
    if (seen.has(r.id)) errors.push(`${label}: duplicate id.`);
    seen.add(r.id);
    if (!personIds.has(r.personId)) errors.push(`${label}: personId "${r.personId}" names no person.`);
    if (!Object.hasOwn(BUSINESS_INCOME_KINDS, r.kind ?? '')) {
      errors.push(`${label}: kind must be one of ${Object.keys(BUSINESS_INCOME_KINDS).join(', ')}.`);
    }
    if (!ISO_DAY.test(r.startDate ?? '') || Number.isNaN(Date.parse(r.startDate))) {
      errors.push(`${label}: startDate must be a YYYY-MM-DD date.`);
    }
    if (r.endDate != null && r.endDate !== '') {
      if (!ISO_DAY.test(r.endDate) || Number.isNaN(Date.parse(r.endDate))) errors.push(`${label}: endDate must be a YYYY-MM-DD date.`);
      else if (r.endDate < r.startDate) errors.push(`${label}: endDate is before startDate.`);
    }
    if (r.paymentDay != null && !validMonthDay(r.paymentDay)) {
      errors.push(`${label}: paymentDay must be MM-DD (not 02-29).`);
    }
    if (!Number.isFinite(Number(r.net)) || r.net === '' || r.net == null) errors.push(`${label}: net must be a number.`);
    if (r.neCommunityCollegeTax != null && !(Number(r.neCommunityCollegeTax) >= 0)) {
      errors.push(`${label}: neCommunityCollegeTax must be 0 or more.`);
    }
  }
  return errors;
}

/**
 * Every reason the MC path table cannot be drawn from (design 134 step 4c/4d).
 * `cfg.businessIncomePaths` holds one flat row per farm MC path, joined to its business-income
 * row by `businessIncomeId`: `{ businessIncomeId, seed, net, neCommunityCollegeTax? }`.
 *
 * @param {Array<object>} paths `cfg.businessIncomePaths`
 * @param {Array<object>} rows  `cfg.businessIncome`
 * @returns {string[]} empty when valid
 */
export function validateBusinessIncomePaths(paths, rows) {
  if (paths == null) return [];
  if (!Array.isArray(paths)) return ['businessIncomePaths must be a list'];
  const ids = new Set((rows ?? []).map(r => r?.id));
  const errors = [];
  const orphans = new Set();
  paths.forEach((p, i) => {
    if (!ids.has(p?.businessIncomeId)) orphans.add(p?.businessIncomeId);
    if (!Number.isFinite(Number(p?.net)) || p?.net == null) errors.push(`Business income path #${i}: net must be a number.`);
  });
  for (const id of orphans) errors.push(`Business income paths name "${id}", which is not a businessIncome row.`);
  return errors;
}

/**
 * The payment dates of one row inside a run, by year.
 *
 * @param {object} row a valid business-income row
 * @param {Date} start the run's start
 * @param {Date} end   the run's end
 * @returns {Array<{ year: number, date: Date }>}
 */
export function businessIncomeDates(row, start, end) {
  const day = row.paymentDay ?? DEFAULT_PAYMENT_DAY;
  const from = Math.max(Number(row.startDate.slice(0, 4)), start.getUTCFullYear());
  const lastYear = row.endDate ? Number(row.endDate.slice(0, 4)) : end.getUTCFullYear();
  const to = Math.min(lastYear, end.getUTCFullYear());
  const out = [];
  for (let year = from; year <= to; year++) {
    const iso = `${year}-${day}`;
    if (iso < row.startDate) continue;
    if (row.endDate && iso > row.endDate) continue;
    const date = new Date(`${iso}T00:00:00Z`);
    if (date < start || date > end) continue;
    out.push({ year, date });
  }
  return out;
}

/**
 * The year's nominal amounts: the row's figures × US CPI since its first payment.
 *
 * @param {object} data the event's data: `{ net, neCommunityCollegeTax }`
 * @param {number} accNow  `state.inflationAccumulator.US` on the payment date
 * @param {number|null} accBase the accumulator on the row's first payment, or null on it
 * @returns {{ net: number, neCommunityCollegeTax: number, factor: number }}
 */
export function businessIncomeAmounts(data, accNow, accBase) {
  const factor = accBase == null ? 1 : accNow / accBase;
  return {
    net: Number(data.net) * factor,
    neCommunityCollegeTax: Number(data.neCommunityCollegeTax ?? 0) * factor,
    factor,
  };
}
