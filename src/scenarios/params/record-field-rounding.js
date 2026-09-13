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
 * Whole-number coercion and date-backed lever fields for the param→record cascade.
 *
 * Shared by the two cascade implementations — `ScenarioLoader._applyParamNode`
 * (the load/Rebuild path) and `BaseScenario.applyParams` (the cheap in-place
 * rebuild) — so a field is rounded and converted identically no matter which one runs.
 */

/**
 * Asset-record fields (real property / collectible / company equity) the param
 * cascade should round to a whole number: dollar amounts and calendar years.
 * Fractional fields (rates, ratios) must NOT be listed — Math.round on a 0.04
 * appreciation rate would zero it, silently killing the asset's growth.
 */
export const WHOLE_NUMBER_RECORD_FIELDS = new Set([
  'value', 'plannedSaleYear', 'costBasis', 'mortgageBalance',
]);

/**
 * @param {string} field - the record property being written
 * @param {*}      val   - the param value (null/undefined pass through untouched)
 * @returns {*} the value, rounded when `field` is a whole-number field
 */
export function roundRecordField(field, val) {
  if (val == null) return val;
  return WHOLE_NUMBER_RECORD_FIELDS.has(field) ? Math.round(val) : val;
}

/**
 * Lever fields that sweep a stored DATE as a fractional year: lever field → the record's
 * date field. A date cannot be a grid axis or an optimizer variable, but a year can, and
 * the US §121 2-of-5 test is a cliff at exactly 730 days — so the year must be fractional
 * or a sweep cannot put points either side of it.
 */
export const FRACTIONAL_YEAR_DATE_FIELDS = Object.freeze({
  mainResidenceFromYear: 'mainResidenceFrom',
});

const _daysIn = (y, m) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
const _pad2   = (n) => String(n).padStart(2, '0');

/**
 * A date (ISO string, Date or epoch ms) as a fractional year: month-based, so 2031.5 is
 * 1 Jul 2031 and 2031.25 is 1 Apr, with the day a fraction of its own month.
 * @returns {?number} null when `v` is not a date
 */
export function dateToFractionalYear(v) {
  if (v == null) return null;
  const t = v instanceof Date ? v.getTime() : (typeof v === 'number' ? v : Date.parse(v));
  if (!Number.isFinite(t)) return null;
  const d = new Date(t);
  const y = d.getUTCFullYear(), m = d.getUTCMonth();
  return y + (m + (d.getUTCDate() - 1) / _daysIn(y, m)) / 12;
}

/**
 * The inverse of {@link dateToFractionalYear}, to the day, as the `YYYY-MM-DD` string the
 * property editor writes. Exact on a round trip from a date.
 * @returns {?string} null when `x` is not a finite number
 */
export function fractionalYearToIsoDate(x) {
  if (!Number.isFinite(x)) return null;
  let y = Math.floor(x);
  const months = (x - y) * 12;
  let m = Math.floor(months + 1e-9);
  let day = 1 + Math.max(0, Math.round((months - m) * _daysIn(y, m)));
  if (day > _daysIn(y, m)) { day = 1; m += 1; }
  if (m > 11) { m = 0; y += 1; }
  return `${y}-${_pad2(m + 1)}-${_pad2(day)}`;
}

/**
 * A lever field's value as read from its record: the fractional year of a date-backed
 * field, the raw field otherwise. Seeds a generated param, so the §6 harvest re-reads it.
 */
export function recordFieldValue(record, field) {
  const dateField = FRACTIONAL_YEAR_DATE_FIELDS[field];
  return dateField ? dateToFractionalYear(record?.[dateField]) : record?.[field];
}

/**
 * The record patch a cascaded param value makes, shared by both cascade paths.
 *
 * A date-backed field writes its date field, and writes NOTHING when the value is the
 * record's own year or null: the plan's cascade must stay a no-op (the authored date
 * keeps its exact string), and a null lever is never a request to clear a move-in date.
 *
 * @returns {object} fields to assign onto the record; may be empty
 */
export function recordFieldPatch(record, field, val) {
  const dateField = FRACTIONAL_YEAR_DATE_FIELDS[field];
  if (!dateField) return { [field]: roundRecordField(field, val) };
  const x = val == null || val === '' ? NaN : Number(val);
  if (!Number.isFinite(x)) return {};
  const current = dateToFractionalYear(record?.[dateField]);
  if (current != null && Math.abs(current - x) < 1e-9) return {};
  return { [dateField]: fractionalYearToIsoDate(x) };
}
