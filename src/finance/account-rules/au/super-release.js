/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * super-release.js — when a member's super becomes lawfully drawable (design 119 §6.2,
 * phase 2). Replaces the fixed age-60 gate for super.
 *
 * From the SIS Regulations 1994 (`docs/au-tax/SISR-1994/`, compilation F2026C00541):
 *
 *   - **Preservation age** (reg 6.01(2)): 55 for a person born before 1 July 1960, one
 *     more year for each later birth year, and 60 for a person born after 30 June 1964.
 *   - **Retirement** (reg 6.01(7)), a condition of release (Sch 1 item 101):
 *       (a) preservation age under 60: a gainful employment arrangement has ended and the
 *           person intends never to work again;
 *       (b) aged 60 or more: an arrangement has ended and either (i) they were 60 on or
 *           before it ended, or (ii) they intend never to work again.
 *   - **Age 65** (Sch 1 item 106): released, no conditions.
 *
 * Intent is not modelled, so "intends never to work again" is read off the plan: no job
 * after this one. That gives
 *
 *   release = min( 65th birthday,
 *                  max(preservation-age birthday, end of the last job),   (a), (b)(ii)
 *                  first job end on or after the 60th birthday )          (b)(i)
 *
 * A person with no recorded work is taken as already retired, so their release is their
 * preservation age. "Gainfully employed" covers self-employment too (reg 1.03), so every
 * job counts, in either country.
 *
 * A leaf module: it reads the person's state record only, so the drawdown walk, the pool
 * metrics and the panels can all ask it without a registry.
 */

import { spellsOf } from '../../payroll/employment.js';
import { isMsbs, msbsElectionMs } from './msbs.js';

const toMs = v => {
  if (v == null) return null;
  const t = v instanceof Date ? v.getTime() : (typeof v === 'number' ? v : Date.parse(v));
  return Number.isFinite(t) ? t : null;
};

/** The `years`th birthday of someone born at `bornMs`, as a UTC calendar date. */
function birthdayMs(bornMs, years) {
  const b = new Date(bornMs);
  return Date.UTC(b.getUTCFullYear() + years, b.getUTCMonth(), b.getUTCDate());
}

/**
 * Preservation age for a birth date (reg 6.01(2)), or null when the date is unusable.
 *
 * @param {Date|string|number} birthDate
 * @returns {number|null}
 */
export function preservationAge(birthDate) {
  const t = toMs(birthDate);
  if (t == null) return null;
  const d = new Date(t);
  // The financial year of birth: born 1 July 1960 – 30 June 1961 is "1960".
  const fy = d.getUTCMonth() >= 6 ? d.getUTCFullYear() : d.getUTCFullYear() - 1;
  if (fy < 1960) return 55;
  if (fy > 1963) return 60;
  return 56 + (fy - 1960);
}

/**
 * The person's work, as `{ endMs }` per job, in start order; `endMs` null for a job that
 * never ends. A legacy person (no jobs) works until `retirementDate` only if they earn.
 */
function workSpans(person) {
  const spells = spellsOf(person);
  if (spells != null) return spells.map(s => ({ endMs: s.endMs ?? null }));
  if (!(Number(person?.monthlyWage) > 0)) return [];
  return [{ endMs: toMs(person.retirementDate) }];
}

/**
 * The instant the member's super is released, in ms, or null without a birth date.
 *
 * @param {object} person                the member's state record (`birthDate`, and
 *                                       `spells` or `monthlyWage`/`retirementDate`)
 * @param {Date|string|number} [birthDate]  overrides `person.birthDate` (a caller that
 *                                       resolved the owner's date its own way)
 * @returns {number|null}
 */
export function auSuperReleaseMs(person, birthDate = person?.birthDate) {
  const bornMs = toMs(birthDate);
  if (bornMs == null) return null;
  const at65  = birthdayMs(bornMs, 65);
  const at60  = birthdayMs(bornMs, 60);
  const atPres = birthdayMs(bornMs, preservationAge(bornMs));

  const spans = workSpans(person);
  const open  = spans.some(s => s.endMs == null);
  const lastEnd = spans.reduce((m, s) => (s.endMs != null && s.endMs > m ? s.endMs : m), -Infinity);

  const candidates = [at65];
  if (!open) candidates.push(Math.max(atPres, lastEnd));
  for (const s of spans) if (s.endMs != null && s.endMs >= at60) candidates.push(s.endMs);
  return Math.min(...candidates);
}

/**
 * The instant this super account starts paying, in ms, or null without a birth date
 * (design 119 §6.1). Its `drawStartDate` is the household's choice of when to start
 * drawing; blank means as soon as the law allows. A date before the release date moves
 * to it, since nothing can be drawn earlier.
 *
 * It is also when pension phase starts: from this instant the fund's earnings on the
 * account are exempt (0%), and before it they are taxed at 15% (design 119 D2).
 *
 * @param {object} account               the super account (state entry or record)
 * @param {object} person                the member's state record
 * @param {Date|string|number} [birthDate]  overrides `person.birthDate`
 * @returns {number|null}
 */
export function auSuperDrawStartMs(account, person, birthDate = person?.birthDate) {
  const release = auSuperReleaseMs(person, birthDate);
  if (release == null) return null;
  // An MSBS account starts paying on its election (§6.4): the draw date clamped into the
  // scheme's window. Its member benefit is then released by the ordinary rules.
  const chosen = isMsbs(account) ? msbsElectionMs(account, birthDate) : toMs(account?.drawStartDate);
  return chosen != null && chosen > release ? chosen : release;
}

/**
 * The state key of the member who owns a super account: the person whose `id` is the
 * account's owner, else the person keyed by it, else the first person.
 *
 * @param {object} state
 * @param {string|null} ownerId
 * @returns {string|null}
 */
export function superMemberKey(state, ownerId) {
  const people = state?.people ?? {};
  const keys   = Object.keys(people);
  return keys.find(k => people[k]?.id != null && people[k].id === ownerId)
    ?? (ownerId != null && people[ownerId] ? ownerId : (keys[0] ?? null));
}

/**
 * {@link auSuperDrawStartMs} for an account in sim state, its member found by
 * {@link superMemberKey}. Null when the member has no birth date.
 *
 * @param {object} state
 * @param {object} account   the account's state entry
 * @param {string|null} [ownerId]  the owner, when the entry does not carry one
 * @returns {number|null}
 */
export function superDrawStartIn(state, account, ownerId = account?.ownerId ?? null) {
  const key = superMemberKey(state, ownerId);
  const person = key != null ? state.people[key] : null;
  return person ? auSuperDrawStartMs(account, person) : null;
}
