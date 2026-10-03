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
 * employment.js — who works where, for how much, on a date (design 116 §4.4).
 *
 * ─── the two shapes a person can have ────────────────────────────────────────
 *
 * **Legacy** (no `job` records): one job for the whole run, on the person's flat fields
 * `monthlyWage`, `wageCurrency`, `workCountry`, `selfEmployed`, ending at
 * `retirementDate`. `InflationAdjustReducer` inflates `monthlyWage` in place once a year.
 * Every function here reads that shape exactly as the code before this module did, so a
 * scenario without jobs is byte-identical (§4.2): `w·f₁·f₂·…` and `w·(f₁·f₂·…)` differ in
 * the last bits, and the whole-state goldens are exact-match.
 *
 * **Spells** (one or more `cfg.jobs` rows): `state.people[id].spells`, sorted by start,
 * and none of the flat job fields. A spell's wage is
 *
 *     baseMonthlyWage × state.wageIndex[cc] × (1 + realGrowth)^n
 *
 * where `cc` is the wage currency's country and `n` the whole years since the spell's
 * own start. The base is in SIM-START money (§4.1), so a spell beginning in 2035 means
 * "what this job pays today" under every inflation path a sweep can draw.
 *
 * ─── why no imports ──────────────────────────────────────────────────────────
 *
 * `lever-schedule.js` may import leaf modules only (design 81 §16.5), and a career-change
 * MPC lever (D5) would need this resolver. Keep it a leaf.
 */

/**
 * Employer-set terms a job may carry (design 116 phase 3). Each is optional: empty
 * inherits the person's own value, then the household default — the chain `elect()` in
 * the payroll handler already applies once the spell's value is laid over the person.
 * The EMPLOYEE's elections (deferral, sacrifice, IRA, Roth, personal super) stay on the
 * person: they move with the person, not with the job.
 */
export const JOB_EMPLOYER_TERMS = Object.freeze([
  'k401EmployerMatchPct', 'k401MatchTiers', 'k401NonElectivePct', 'superGuaranteePct',
]);

/** A `job` record field that is a date ('YYYY-MM-DD'), as authored. */
export const JOB_DATE_FIELDS = Object.freeze(['startDate', 'endDate']);

/** Country whose CPI indexes a wage paid in `code` (design 50: the WAGE currency's). */
export function wageIndexCountry(code) {
  return code === 'AUD' ? 'AU' : 'US';
}

/** Epoch ms of a Date, a date string or a number; null when absent or unparseable. */
function toMs(v) {
  if (v == null || v === '') return null;
  const t = v instanceof Date ? v.getTime() : (typeof v === 'number' ? v : Date.parse(v));
  return Number.isFinite(t) ? t : null;
}

/** The person's spells, or null for a legacy person. */
export function spellsOf(person, spellsByPerson = null) {
  const s = person?.spells ?? spellsByPerson?.[person?.id];
  return Array.isArray(s) && s.length > 0 ? s : null;
}

/** Does this person carry spells (and so none of the flat job fields)? */
export function hasSpells(person, spellsByPerson = null) {
  return spellsOf(person, spellsByPerson) != null;
}

/**
 * Whole years from `startMs` to `t`: the number of anniversaries of the start passed.
 * 0 before the first one, so a spell's first year reads its base exactly.
 */
export function wholeYearsSince(startMs, t) {
  const a = new Date(startMs);
  const b = new Date(t);
  let n = b.getUTCFullYear() - a.getUTCFullYear();
  if (b.getUTCMonth() < a.getUTCMonth()
      || (b.getUTCMonth() === a.getUTCMonth() && b.getUTCDate() < a.getUTCDate())) n -= 1;
  return Math.max(0, n);
}

/**
 * The spell in force on `date`: `startMs ≤ t < endMs`, a null end meaning open-ended.
 *
 * For a legacy person this is a view over the flat fields ending at `retirementDate`, so
 * a caller can ask one question of both shapes. Null when nothing is in force — a gap
 * between spells is unemployment (§4.6).
 */
export function spellAt(person, date, spellsByPerson = null) {
  const t = toMs(date);
  const spells = spellsOf(person, spellsByPerson);
  if (spells == null) {
    if (person == null) return null;
    const end = toMs(person.retirementDate);
    if (end != null && !(t < end)) return null;
    return {
      id: null, startMs: null, endMs: end,
      baseMonthlyWage: person.monthlyWage ?? 0, realGrowth: 0,
      wageCurrency: person.wageCurrency ?? null,
      workCountry:  person.workCountry  ?? null,
      selfEmployed: !!person.selfEmployed,
    };
  }
  for (const s of spells) {
    if (s.startMs != null && t < s.startMs) continue;
    if (s.endMs   != null && !(t < s.endMs)) continue;
    return s;
  }
  return null;
}

/**
 * Nominal monthly wage on `date`; 0 when no spell is in force.
 *
 * A legacy person returns `monthlyWage` untouched (already inflated in place) while
 * `date < retirementDate` — the predicate `isEarning` has always applied.
 */
export function wageAt(person, date, state, spellsByPerson = null) {
  const spells = spellsOf(person, spellsByPerson);
  if (spells == null) {
    if ((person?.monthlyWage ?? 0) <= 0) return 0;
    const end = person.retirementDate;
    return (end ? date < end : true) ? person.monthlyWage : 0;
  }
  const s = spellAt(person, date, spellsByPerson);
  if (s == null || !(s.baseMonthlyWage > 0)) return 0;
  const index  = state?.wageIndex?.[wageIndexCountry(s.wageCurrency)] ?? 1;
  const n      = s.startMs == null ? 0 : wholeYearsSince(s.startMs, toMs(date));
  const growth = n > 0 && s.realGrowth ? Math.pow(1 + s.realGrowth, n) : 1;
  return s.baseMonthlyWage * index * growth;
}

/**
 * The person as payroll sees them on `date`, or null when they draw no wage.
 *
 * A legacy earner is returned AS ITSELF — the same object the pipeline always read — so
 * nothing downstream can tell this function exists. A spell earner is the person with
 * the spell's job fields laid over it, the wage resolved to its nominal figure, and
 * `spellId` naming the job.
 */
export function earnerView(person, date, state, spellsByPerson = null) {
  const w = wageAt(person, date, state, spellsByPerson);
  if (!(w > 0)) return null;
  if (!hasSpells(person, spellsByPerson)) return person;
  const s = spellAt(person, date, spellsByPerson);
  return {
    ...person,
    monthlyWage:  w,
    wageCurrency: s.wageCurrency,
    workCountry:  s.workCountry,
    selfEmployed: !!s.selfEmployed,
    spellId:      s.id,
    // The job's employer terms win over the person's own; an empty one leaves the
    // person's value (and through it the household default) in force.
    ...Object.fromEntries(JOB_EMPLOYER_TERMS
      .filter(f => s[f] != null).map(f => [f, s[f]])),
  };
}

/** Does this person draw a wage at any point in the run? (compile-time gating) */
/**
 * Does any of the person's jobs carry a positive value in one of `fields`? Lets the
 * payroll gate schedule contributions for an employer term set only on a job.
 */
export function anySpellTerm(person, fields, spellsByPerson = null) {
  const spells = spellsOf(person, spellsByPerson);
  return !!spells?.some(s => fields.some(f => (typeof s[f] === 'number' ? s[f] : 0) > 0));
}

export function everEarns(person, spellsByPerson = null) {
  const spells = spellsOf(person, spellsByPerson);
  if (spells == null) return (person?.monthlyWage ?? 0) > 0;
  return spells.some(s => s.baseMonthlyWage > 0);
}

/**
 * When the person stops working, as a Date; null when they never stop (open-ended).
 *
 * Legacy: the authored `retirementDate`. Spells: the end of the last spell, optionally
 * only among spells paid in `currency` — the 401(k) separation date is the end of the
 * last USD job, not of a later Australian one.
 *
 * @returns {Date|null|undefined} undefined when `currency` matches no spell at all
 */
export function lastWorkDate(person, spellsByPerson = null, { currency = null } = {}) {
  const spells = spellsOf(person, spellsByPerson);
  if (spells == null) return person?.retirementDate ?? null;
  const pool = currency == null ? spells : spells.filter(s => s.wageCurrency === currency);
  if (pool.length === 0) return undefined;
  const last = pool[pool.length - 1];
  return last.endMs == null ? null : new Date(last.endMs);
}

/**
 * Build the state spells for one person from the scenario's `job` records (§4.3).
 *
 * Projected COMPLETE and sorted by start: `_mergeStatePatches` replaces a person's whole
 * entry, so a partial projection would delete fields. An empty start is the run's start,
 * which is also the anchor `realGrowth` compounds from.
 *
 * @param {Array<object>} jobs        cfg `job` records (any person's)
 * @param {object}        person      the Person (its wageCurrency is the default)
 * @param {Date|number}   simStart
 * @returns {Array<object>|null}      null when the person has no job records
 */
export function buildSpells(jobs, person, simStart) {
  const mine = (jobs ?? []).filter(j => j?.personId === person?.id);
  if (mine.length === 0) return null;
  const runStart = toMs(simStart);
  return mine
    .map(j => ({
      id:              j.id,
      startMs:         toMs(j.startDate) ?? runStart,
      endMs:           toMs(j.endDate),
      baseMonthlyWage: Number(j.monthlyWage ?? 0),
      realGrowth:      Number(j.realGrowth ?? 0),
      wageCurrency:    j.wageCurrency ?? person.wageCurrency ?? null,
      workCountry:     j.workCountry  ?? null,
      selfEmployed:    !!j.selfEmployed,
      ...Object.fromEntries(JOB_EMPLOYER_TERMS.map(f => [f, j[f] ?? null])),
    }))
    .sort((a, b) => (a.startMs ?? -Infinity) - (b.startMs ?? -Infinity));
}

/**
 * Spells for every person, keyed by person id; people without jobs are absent.
 *
 * @param {Array<object>} jobs
 * @param {Array<object>} people
 * @param {Date|number}   simStart
 */
export function buildSpellsByPerson(jobs, people, simStart) {
  const out = {};
  for (const p of people ?? []) {
    const s = buildSpells(jobs, p, simStart);
    if (s) out[p.id] = s;
  }
  return out;
}

/** Whole months between two dates (b − a), on the `year × 12 + month` scale. */
function monthsBetween(a, b) {
  const x = new Date(toMs(a)), y = new Date(toMs(b));
  return (y.getUTCFullYear() * 12 + y.getUTCMonth()) - (x.getUTCFullYear() * 12 + x.getUTCMonth());
}

/** The default reach of a date lever either side of its value, in months (±2 years). */
export const JOB_DATE_REACH_MONTHS = 24;

/** The shortest a job may be made, and the least two neighbouring dates may close to. */
export const JOB_MIN_LENGTH_MONTHS = 1;

/**
 * The job dates that are sweep levers, per person, in date order (design 116 §10 Q2).
 *
 * One variable per fact:
 *  - a job's `startDate` is a lever whenever it is set. When the job before it ends on that
 *    same day the two share one boundary, and the START owns it — moving it moves the
 *    previous job's end with it (the loader's job cascade);
 *  - a job's `endDate` is a lever only when no job starts on it: the last job's end (the
 *    work end date) or the end of a job followed by a gap.
 * A blank start (the run's start) or a blank end (never) is not a date, and not a lever.
 *
 * Each lever carries `down` / `up`: how many months it may move before it could meet a
 * neighbour. Neighbours split the room between them, leaving `JOB_MIN_LENGTH_MONTHS`, so
 * ANY combination of in-range values is a valid job sequence — nothing to clamp or reject.
 *
 * @param {Array<object>} jobs  cfg `job` records (any person's)
 * @returns {Map<string, Array<{jobId, field, date, down, up}>>}
 */
export function jobDateLevers(jobs) {
  const byPerson = new Map();
  for (const j of jobs ?? []) {
    if (!byPerson.has(j?.personId)) byPerson.set(j?.personId, []);
    byPerson.get(j.personId).push(j);
  }
  const out = new Map();
  for (const [personId, list] of byPerson) {
    const sorted = [...list].sort((a, b) =>
      (toMs(a.startDate) ?? -Infinity) - (toMs(b.startDate) ?? -Infinity));
    const levers = [];
    sorted.forEach((j, i) => {
      if (toMs(j.startDate) != null) levers.push({ jobId: j.id, field: 'startDate', date: j.startDate });
      const next = sorted[i + 1];
      const shared = next && toMs(next.startDate) != null && toMs(next.startDate) === toMs(j.endDate);
      if (toMs(j.endDate) != null && !shared) levers.push({ jobId: j.id, field: 'endDate', date: j.endDate });
    });
    levers.forEach((l, i) => {
      const room = (a, b) => Math.max(0, monthsBetween(a.date, b.date) - JOB_MIN_LENGTH_MONTHS);
      // The earlier lever takes the larger half of an odd split, so the two never add to
      // more than the room between them.
      const before = i > 0 ? room(levers[i - 1], l) : Infinity;
      const after  = i < levers.length - 1 ? room(l, levers[i + 1]) : Infinity;
      l.down = Math.min(JOB_DATE_REACH_MONTHS, Math.floor(before / 2));
      l.up   = Math.min(JOB_DATE_REACH_MONTHS,
        Number.isFinite(after) ? after - Math.floor(after / 2) : Infinity);
    });
    out.set(personId, levers);
  }
  return out;
}

/**
 * Optimizer rows on job dates whose ranges can cross a neighbour's (design 116 Q2): the
 * pre-run check for a range the author widened by hand. Each pair is two consecutive
 * levers of one person; a disabled row counts at its plan value.
 *
 * @param {Array<object>} rows  optimizer variable configs ({ paramKey, enabled, min, max })
 * @param {Array<object>} jobs  cfg `job` records
 * @returns {Array<{ earlier: string, later: string }>} param keys, empty when none cross
 */
export function jobDateRangeConflicts(rows, jobs) {
  const byKey = new Map((rows ?? []).map(r => [r.paramKey, r]));
  const span = (l) => {
    const r = byKey.get(`job.${l.jobId}.${l.field}`);
    return r?.enabled && r.min != null && r.max != null ? [r.min, r.max] : [l.date, l.date];
  };
  const out = [];
  for (const levers of jobDateLevers(jobs).values()) {
    for (let i = 1; i < levers.length; i++) {
      const [, prevMax] = span(levers[i - 1]);
      const [nextMin]   = span(levers[i]);
      if (monthsBetween(prevMax, nextMin) < JOB_MIN_LENGTH_MONTHS) {
        out.push({ earlier: `job.${levers[i - 1].jobId}.${levers[i - 1].field}`,
                   later:   `job.${levers[i].jobId}.${levers[i].field}` });
      }
    }
  }
  return out;
}

/**
 * Every reason the scenario's `job` records cannot run (§4.6). Errors, not warnings: an
 * inert spell is a silent wrong answer.
 *
 * @param {Array<object>} jobs
 * @param {Array<object>} persons  cfg person records (only `id` is read)
 * @returns {string[]} empty when the records are valid
 */
export function validateJobs(jobs, persons) {
  const errors = [];
  if (!Array.isArray(jobs) || jobs.length === 0) return errors;
  const personIds = new Set((persons ?? []).map(p => p?.id));
  const seen = new Set();
  const byPerson = new Map();
  for (const j of jobs) {
    const label = `Job "${j?.id ?? '?'}"`;
    if (j?.id == null || j.id === '') errors.push('Job: `id` is required.');
    else if (seen.has(j.id)) errors.push(`${label}: duplicate id.`);
    seen.add(j?.id);
    if (!personIds.has(j?.personId)) {
      errors.push(`${label}: personId "${j?.personId}" names no person.`);
      continue;
    }
    for (const f of JOB_DATE_FIELDS) {
      if (j[f] != null && j[f] !== '' && toMs(j[f]) == null) {
        errors.push(`${label}: ${f} "${j[f]}" is not a date.`);
      }
    }
    const s = toMs(j.startDate);
    const e = toMs(j.endDate);
    if (s != null && e != null && e <= s) {
      errors.push(`${label}: endDate must be after startDate.`);
    }
    if (!byPerson.has(j.personId)) byPerson.set(j.personId, []);
    byPerson.get(j.personId).push({ id: j.id, s: s ?? -Infinity, e: e ?? Infinity });
  }
  // D3: overlapping spells are rejected. Sorted by start, each spell must end at or
  // before the next one starts (end is exclusive, so a shared boundary is fine).
  for (const [personId, list] of byPerson) {
    list.sort((a, b) => a.s - b.s);
    for (let i = 1; i < list.length; i++) {
      if (list[i].s < list[i - 1].e) {
        errors.push(`Jobs "${list[i - 1].id}" and "${list[i].id}" of person "${personId}" `
          + 'overlap. One person holds one job at a time (design 116 D3).');
      }
    }
  }
  return errors;
}
