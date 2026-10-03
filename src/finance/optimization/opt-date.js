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
 * The optimizer's Date variable (design 117 §5).
 *
 * A DATE variable is authored and reported as ISO days:
 *
 *   { paramKey, type: 'date', min: 'YYYY-MM-DD', max: 'YYYY-MM-DD', step, anchor?: 'MM-DD' }
 *
 * The solvers never see a date. `dateSolverView` turns the variable into an integer one
 * over a month count (`year × 12 + month`), or over the year itself when it carries an
 * `anchor`, so every solver's integer path searches it unchanged. `step` is in that unit:
 * months, or years when anchored. The problem converts a solver value back to an ISO day
 * only where it applies a candidate (`paramCandidate`), and the ledger reports ISO days.
 *
 * Why a month: loans pay monthly and a sale or purchase runs once, so a month is the
 * smallest step that moves most results. The day of each value is the anchor's day, or
 * else `min`'s day (clamped to the month's length).
 *
 * A leaf module: it imports nothing, so a worker, the panels and the MC sampler can share it.
 */

export const OPT_DATE_TYPE = 'date';

const ANCHOR_RE = /^(\d{2})-(\d{2})$/;

/** `'MM-DD'` → `{ month0, day }`, or null when absent or malformed. */
export function parseDateAnchor(anchor) {
  const m = typeof anchor === 'string' ? ANCHOR_RE.exec(anchor) : null;
  if (!m) return null;
  const month0 = Number(m[1]) - 1, day = Number(m[2]);
  return month0 >= 0 && month0 < 12 && day >= 1 && day <= 31 ? { month0, day } : null;
}

/** A Date, ISO string or epoch ms → a UTC Date, or null when it is not a date. */
export function toUtcDate(v) {
  if (v == null || v === '') return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Any date-like value → `'YYYY-MM-DD'`, or null. */
export function isoDay(v) {
  const d = toUtcDate(v);
  return d ? d.toISOString().slice(0, 10) : null;
}

function _daysInMonth(year, month0) {
  return new Date(Date.UTC(year, month0 + 1, 0)).getUTCDate();
}

/** The ISO day for (year, month0, day), the day clamped to the month (31 Feb → 28/29 Feb). */
function _iso(year, month0, day) {
  const d = Math.min(day, _daysInMonth(year, month0));
  return new Date(Date.UTC(year, month0, d)).toISOString().slice(0, 10);
}

/**
 * A date → its solver ordinal: the year when anchored, else `year × 12 + month`.
 * @returns {number|null}
 */
export function dateOrdinal(v, anchor = null) {
  const d = toUtcDate(v);
  if (!d) return null;
  return parseDateAnchor(anchor) ? d.getUTCFullYear() : d.getUTCFullYear() * 12 + d.getUTCMonth();
}

/** A solver ordinal → its ISO day (see `dateOrdinal`). */
export function ordinalToIso(n, anchor = null, day = 1) {
  const k = Math.round(n);
  const a = parseDateAnchor(anchor);
  if (a) return _iso(k, a.month0, a.day);
  const year = Math.floor(k / 12);
  return _iso(year, k - year * 12, day);
}

/** Is this a DATE variable (authored or already a solver view)? */
export function isDateVariable(v) {
  return v?.type === OPT_DATE_TYPE;
}

/**
 * The integer view the solvers search (see the module doc). Idempotent: a view passes
 * through, so a worker handed the main thread's views rebuilds the same problem. A
 * variable that is not a DATE is returned unchanged.
 */
export function dateSolverView(v) {
  if (!isDateVariable(v) || v._dateView) return v;
  const anchor = parseDateAnchor(v.anchor) ? v.anchor : null;
  const lo = dateOrdinal(v.min, anchor);
  const hi = dateOrdinal(v.max, anchor);
  const step = Math.max(1, Math.round(Number(v.step) || 1));
  const minDate = toUtcDate(v.min);
  return {
    ...v,
    min:  lo ?? NaN,
    max:  hi ?? NaN,
    step,
    anchor,
    isoMin: isoDay(v.min),
    isoMax: isoDay(v.max),
    _day:   anchor ? parseDateAnchor(anchor).day : (minDate ? minDate.getUTCDate() : 1),
    _dateView: true,
  };
}

/** A solver value (or an ISO day already) → the ISO day the param takes. */
export function dateParamValue(view, x) {
  if (x == null) return x;
  if (typeof x === 'number') return ordinalToIso(x, view.anchor, view._day ?? 1);
  return isoDay(x) ?? x;
}

/** A param value (ISO day, or an ordinal already) → the solver's ordinal. */
export function dateSolverValue(view, x) {
  if (typeof x === 'number') return x;
  return dateOrdinal(x, view.anchor) ?? view.min;
}

/**
 * A candidate with every DATE variable's value as an ISO day. Keys that are not DATE
 * variables pass through untouched; returns the same object when nothing changes.
 */
export function paramCandidate(variables, candidate) {
  if (!candidate) return candidate;
  let out = candidate;
  for (const v of variables ?? []) {
    if (!isDateVariable(v) || !Object.hasOwn(candidate, v.paramKey)) continue;
    const view = dateSolverView(v);
    const iso  = dateParamValue(view, candidate[v.paramKey]);
    if (iso === candidate[v.paramKey]) continue;
    if (out === candidate) out = { ...candidate };
    out[v.paramKey] = iso;
  }
  return out;
}

/** Display form of a DATE variable's value (an ISO day), whichever space it is in. */
export function formatDateValue(view, x) {
  return dateParamValue(dateSolverView(view), x);
}
