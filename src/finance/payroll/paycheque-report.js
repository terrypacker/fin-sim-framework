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
 * paycheque-report.js — design 95 §17 phase 10, gaps G4/G5.
 *
 * One earner, one month, gross down to net. Design 95's organising idea is §5's
 * four-stage pipeline and nothing anywhere showed a single month of it; everything
 * this needs already rides on the actions, so this module is **assembly, not
 * computation** — it re-derives no amount, applies no rate, and knows no statute.
 * Every figure below is read off a journalled action that the engine already
 * emitted. Where a figure is absent from the journal it is absent here too, rather
 * than reconstructed: a paycheque view that recomputed its own withholding could
 * disagree with the run it claims to be showing, and nothing would say which was
 * right (the standing lesson of design 89 §11 — a view that grows its own pivot).
 *
 * ─── two hazards this walk has to respect ───────────────────────────────────
 *
 * **A journal entry is one REDUCER execution, not one action.** An action reduced
 * by two reducers appears twice, so summing `action.data.amount` across raw entries
 * double-counts. `spending-cube.js` sidesteps this by reading `stateDiff` balance
 * deltas; this module reads the payload instead (a withheld amount moves no
 * balance — that is the whole point of `alreadyNetted`), so it dedupes on
 * `action.instanceId` explicitly.
 *
 * **The wage's `amount` is GROSS and it is not the take-home.** Four figures on one
 * action mean four different things (design 95 §5.1's asymmetry, in the payload):
 *   `amount`     — assessable wage; already NET of any salary sacrifice, because
 *                  sacrifice reduces assessable income as well as cash
 *   `sacrificed` — what went to super before the wage existed
 *   `netAmount`  — what actually reached the household after withholding
 *   `splits`     — where that net landed
 * Adding `sacrificed` back gives the salary PACKAGE, which is the only figure the
 * four stages can be shown as reductions from.
 */

import { auFinancialYearOf } from './au-super-caps.js';

/** The wage/self-employment apply actions, per country and employment type. */
export const WAGE_APPLY_TYPES = new Set([
  'WAGES_INCOME_APPLY', 'AU_WAGES_INCOME_APPLY',
  'SE_INCOME_US_APPLY', 'SE_INCOME_AU_APPLY',
]);

/** Statutory withholding, deducted from the paycheque before it is credited. */
export const WITHHELD_TYPE = 'WAGES_WITHHELD_APPLY';

/**
 * The contribution streams a paycheque can carry, and how each one relates to cash.
 *
 * `employerFunded` on the action is the authority, not this table: the SG and the
 * 401(k) match are stamped with it, and an action that carries it never debited the
 * member. The table's `fundedBy` is the DEFAULT for a stream that cannot be
 * employer-funded at all, so a mis-stamped action still reads correctly.
 */
export const CONTRIBUTION_STREAMS = {
  K401_CONTRIBUTION_APPLY:       { label: '401(k)',                   country: 'US' },
  IRA_CONTRIBUTION_APPLY:        { label: 'Traditional IRA',          country: 'US' },
  ROTH_CONTRIBUTION_APPLY:       { label: 'Roth IRA',                 country: 'US' },
  SUPER_CONTRIBUTION_APPLY:      { label: 'Superannuation',           country: 'AU' },
  SUPER_SACRIFICE_APPLY:         { label: 'Salary Sacrifice',         country: 'AU' },
  SUPER_NON_CONCESSIONAL_APPLY:  { label: 'Non-Concessional Super',   country: 'AU' },
};

/**
 * `AU_QUALIFYING_EARNINGS_APPLY` is deliberately NOT a contribution: it moves no
 * money and credits no fund. It is the s10A(6) accumulator that decides when the
 * SG stops, and showing it beside the streams would read as a fifth contribution.
 */
const NOT_A_CONTRIBUTION = new Set(['AU_QUALIFYING_EARNINGS_APPLY']);

/** Cents — the whole module reports money, never a fraction of one. */
const cents = n => +(n ?? 0).toFixed(2);

/** UTC year-month key. The paycheque is a MONTH, and the sim's dates are UTC. */
export function monthKeyOf(date) {
  const d = date instanceof Date ? date : new Date(date);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/**
 * Walk the journal once, yielding each distinct ACTION (not each reducer execution).
 *
 * @param {object} journal
 * @param {function({type: string, data: object, date: Date, monthKey: string}): void} visit
 */
function forEachAction(journal, visit) {
  const entries = journal?.journal;
  if (!Array.isArray(entries)) return;
  const seen = new Set();
  for (const entry of entries) {
    const action = entry?.action;
    if (!action) continue;
    // Absent an instanceId (hand-built fixtures, and any entry recorded before the
    // field existed) fall back to a composite that is unique per emission — seq is
    // monotonic, so this degrades to "no dedupe" rather than to a wrong dedupe that
    // silently drops a second real contribution.
    const id = action.instanceId ?? `seq:${entry.seq}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const date = entry.date instanceof Date ? entry.date : new Date(entry.date);
    visit({ type: action.type, data: action.data ?? {}, date, monthKey: monthKeyOf(date) });
  }
}

/**
 * Which person does this action belong to?
 *
 * `personKey` on the action is authoritative. The IRA and Roth contributions do not
 * carry one — they were never given it, because the §402(g)-style per-person limits
 * that forced `personKey` onto the 401(k) actions have no IRA equivalent in this
 * model — so they fall back to the OWNER of the account being credited, read off
 * runtime state. Without a state to read, they are unattributed rather than
 * attributed to whoever came first.
 */
function attribute(data, state) {
  if (data?.personKey != null) return data.personKey;
  const key = data?.stateKey;
  if (key == null || state == null) return null;
  return state[key]?.ownerId ?? null;
}

/**
 * Every (person, month) pair the journal carries a paycheque for.
 *
 * Driven off the WAGE actions alone: a month with a contribution but no wage is not
 * a paycheque (an annual IRA top-up outside employment, say), and listing it would
 * offer the user a payslip with no pay on it.
 *
 * @param {object} journal
 * @param {object} [state]  runtime state, for the person names
 * @returns {Array<{personKey: string, name: string, monthKey: string, ts: number}>}
 *          newest last, so a picker's default (the last entry) is the latest month
 */
export function listPaycheques(journal, state = null) {
  const out = new Map();
  forEachAction(journal, ({ type, data, date, monthKey }) => {
    if (!WAGE_APPLY_TYPES.has(type)) return;
    const personKey = data.personKey ?? null;
    if (personKey == null) return;
    const id = `${personKey}|${monthKey}`;
    if (out.has(id)) return;
    out.set(id, {
      personKey, monthKey,
      name: state?.people?.[personKey]?.name ?? personKey,
      ts:   date.getTime(),
    });
  });
  return [...out.values()].sort((a, b) => a.ts - b.ts || a.personKey.localeCompare(b.personKey));
}

/**
 * Assemble one person's paycheque for one month.
 *
 * @param {object} o
 * @param {object} o.journal
 * @param {string} o.personKey
 * @param {string} o.monthKey   'YYYY-MM'
 * @param {object} [o.state]    runtime state — names, account labels, IRA/Roth owner
 * @returns {object|null} null when that person had no wage that month
 */
export function buildPaycheque({ journal, personKey, monthKey, state = null }) {
  let wage = null;
  let withheld = 0;
  const member   = [];
  const employer = [];
  const clamps   = new Set();
  let carriedForward = 0;
  let qualifyingEarnings = null;

  forEachAction(journal, ({ type, data, monthKey: mk }) => {
    if (mk !== monthKey) return;

    if (WAGE_APPLY_TYPES.has(type)) {
      if (data.personKey !== personKey) return;
      wage = data;
      return;
    }
    if (type === WITHHELD_TYPE) {
      if (data.personKey !== personKey) return;
      withheld = cents(withheld + (data.amount ?? 0));
      return;
    }
    if (NOT_A_CONTRIBUTION.has(type)) {
      if (data.personKey === personKey) qualifyingEarnings = cents(data.amount ?? 0);
      // The clamps ride on this action too — a month in which every stream was
      // clamped to nothing still emits it, and that is exactly the month whose clamp
      // most needs saying.
      for (const c of data.clamps ?? []) clamps.add(c);
      return;
    }
    const stream = CONTRIBUTION_STREAMS[type];
    if (!stream) return;
    if (attribute(data, state) !== personKey) return;

    const row = {
      type,
      label:    _streamLabel(type, data),
      amount:   cents(data.amount ?? 0),
      stateKey: data.stateKey ?? null,
      account:  _accountLabel(data.stateKey, state),
      employerFunded: data.employerFunded === true,
      deductible:     data.deductible === true,
      clamps:   [...(data.clamps ?? [])],
    };
    (row.employerFunded ? employer : member).push(row);
    for (const c of row.clamps) clamps.add(c);
    if (data.carriedForward > 0) carriedForward = cents(data.carriedForward);
  });

  if (!wage) return null;

  // §5's four stages, each a reduction from the one above. `assessable` is the
  // action's own `amount`: it is ALREADY net of the sacrifice, so the package is
  // recovered by adding it back rather than the other way round.
  const sacrificed = cents(wage.sacrificed ?? 0);
  const assessable = cents(wage.amount ?? 0);
  const salaryPackage = cents(assessable + sacrificed);
  // `netAmount` is stamped only when it differs from `amount` — an un-withheld
  // paycheque omits it, and reading it as 0 would show a month with no take-home.
  const netPay = cents(wage.netAmount ?? assessable);

  const splits = (wage.splits ?? []).map(s => ({
    targetKey: s.targetKey,
    amount:    cents(s.amount),
    account:   _accountLabel(s.targetKey, state),
  }));

  // What the member's own contributions took out of the cash that landed. These are
  // paid from the cash pool at the contributions stage rather than netted from the
  // wage, so they are a reduction FROM the credited pay, not from the package.
  const memberTotal = cents(member.reduce((a, r) => a + r.amount, 0));

  return {
    personKey,
    monthKey,
    name:     state?.people?.[personKey]?.name ?? personKey,
    currency: state?.people?.[personKey]?.wageCurrency
      ?? (String(wage.type ?? '').startsWith('AU') ? 'AUD' : 'USD'),
    selfEmployed: !!state?.people?.[personKey]?.selfEmployed,
    salaryPackage,
    sacrificed,
    assessable,
    withheld,
    netPay,
    splits,
    // Not credited anywhere: the fallback destination is implied by the remainder
    // when there are no splits at all.
    fallbackKey: wage.targetKey ?? null,
    member,
    employer,
    memberTotal,
    employerTotal: cents(employer.reduce((a, r) => a + r.amount, 0)),
    takeHome: cents(netPay - memberTotal),
    clamps: [...clamps],
    carriedForward,
    qualifyingEarnings,
  };
}

/**
 * The contributions a household made in each year, per person and per stream —
 * design 95 §17.2 G5/U4, the report the clamps become visible in.
 *
 * D8's promise was that a contribution stopped by a cap is "visible in the output
 * rather than inferred from a number being lower than expected". Half-kept as
 * shipped: `clamps` rides on every affected action but reading it means drilling the
 * journal by hand. The promise is only kept when the YEAR that clamped says so, in
 * the same table as the contributions — so `clamps` is a column here, not a footnote.
 *
 * @param {object} o
 * @param {object} o.journal
 * @param {object} [o.state]
 * Each row's `year` is that stream's OWN year — calendar for the US streams, AU
 * financial year (by FY START) for the super ones — and `period` is how to display
 * it. See the comment in the walk for why mixing them misreports a clamp.
 *
 * @returns {{rows: Array<object>, years: number[], people: string[]}}
 */
export function buildContributionsByYear({ journal, state = null }) {
  /** @type {Map<string, object>} `${personKey}|${year}|${type}|${funded}` → row */
  const rows = new Map();
  const years  = new Set();
  const people = new Set();

  forEachAction(journal, ({ type, data, date, monthKey }) => {
    const stream = CONTRIBUTION_STREAMS[type];
    if (!stream) return;
    const personKey = attribute(data, state);
    // EACH COUNTRY'S OWN YEAR, and this is not a nicety. Every cap named in the
    // `clamps` column is annual, and the two countries mean different years by it:
    // §402(g) and §415(c) are per calendar year, Div 291/292 and the s10A(5) base
    // are per AU FINANCIAL year. Rolling AU contributions up by calendar year puts
    // half of one FY's cap beside half of the next one's, so a member whose SG
    // stopped dead in month five of the financial year appears to have contributed
    // A$41,000 against a A$32,500 cap — with the clamp that DID fire sitting in the
    // same row, reading as though the cap had failed. Design 95 §10 records the same
    // hazard on the indexation side: reading one country's figure with the other's
    // year convention shifts it silently.
    const isAu = stream.country === 'AU';
    const year = isAu ? auFinancialYearOf(date) : date.getUTCFullYear();
    const funded    = data.employerFunded === true ? 'employer' : 'member';
    // The LABEL is part of the key, not just the display. Three of the six action
    // types carry more than one stream — a 401(k) match and a non-elective employer
    // contribution are both `K401_CONTRIBUTION_APPLY` with `employerFunded: true`,
    // and so are the SG and a personal deductible contribution on the AU side — so a
    // key of (type, funded) silently ADDS two different streams together and labels
    // the total as whichever arrived first. On a real run that reported a 4% match as
    // 6% of pay, twelve months of it as twenty-four, and gave no sign of either.
    const label = _streamLabel(type, data);
    const id    = `${personKey}|${year}|${type}|${funded}|${label}`;

    let row = rows.get(id);
    if (!row) {
      row = {
        personKey,
        name:   state?.people?.[personKey]?.name ?? personKey ?? '— unattributed —',
        year, type, funded, label,
        country: stream.country,
        // The year as it should be READ. An AU row spans two calendar years and
        // saying "2026" would be false about both halves of it.
        period:      isAu ? `${year}–${String(year + 1).slice(2)} FY` : String(year),
        periodBasis: isAu ? 'financialYear' : 'calendar',
        amount: 0,
        // A Set while accumulating, for the same reason `clamps` is one: a stream
        // that emits twice in a month is one month, not two. Collapsed to a count
        // below.
        _months: new Set(),
        // One clamp named in eight months is one clamp on the year, not eight.
        clamps: new Set(),
        carriedForward: 0,
      };
      rows.set(id, row);
    }
    row.amount = cents(row.amount + (data.amount ?? 0));
    row._months.add(monthKey);
    for (const c of data.clamps ?? []) row.clamps.add(c);
    // The carry-forward released is a FIGURE FOR THE YEAR restated each month, not a
    // monthly increment — summing it would multiply the relief by twelve.
    if (data.carriedForward > 0) row.carriedForward = cents(data.carriedForward);

    years.add(year);
    people.add(row.name);
  });

  const out = [...rows.values()]
    .map(({ _months, ...r }) => ({ ...r, months: _months.size, clamps: [...r.clamps] }))
    .sort((a, b) => a.year - b.year
      || String(a.name).localeCompare(String(b.name))
      || a.label.localeCompare(b.label));

  return {
    rows:   out,
    years:  [...years].sort((a, b) => a - b),
    people: [...people].sort(),
  };
}

/**
 * The AU per-person super cap state — design 95 §17.2 G6.
 *
 * `auSuperCapsByPerson` is the model's first genuinely multi-year accumulator: the
 * five-year unused-cap ring (s291-20), the total-super-balance snapshot that gates
 * it, and the Div 292 bring-forward arrangement. The ATO publishes this as a table
 * and the model should show one too; it is visible today only as an object in the
 * state panel.
 *
 * Read straight off state — no re-derivation. The settle owns this record's year
 * boundary alone, and a report that recomputed the ring from contributions would be
 * sizing it on INTENDED contributions rather than actual ones (§13.9).
 *
 * @param {object} state
 * @returns {Array<object>} one row per person, or [] when the scenario has no super
 */
export function buildSuperCapRows(state) {
  const byPerson = state?.auSuperCapsByPerson;
  if (!byPerson) return [];
  return Object.entries(byPerson).map(([personKey, rec]) => ({
    personKey,
    name: state?.people?.[personKey]?.name ?? personKey,
    concessionalYTD:       cents(rec?.concessionalYTD),
    sgYTD:                 cents(rec?.sgYTD),
    nonConcessionalYTD:    cents(rec?.nonConcessionalYTD),
    qualifyingEarningsYTD: cents(rec?.qualifyingEarningsYTD),
    tsbAtFyStart:          rec?.tsbAtFyStart == null ? null : cents(rec.tsbAtFyStart),
    // The ring, oldest first — it is a five-year window and the order is what makes
    // "expires next year" readable.
    unusedByFy: Object.entries(rec?.unusedByFy ?? {})
      .map(([fy, amount]) => ({ fy: Number(fy), amount: cents(amount) }))
      .sort((a, b) => a.fy - b.fy),
    bringForward: rec?.bringForward ?? null,
  })).sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

/** A stream's display name, sharpened by the flags that distinguish its variants. */
function _streamLabel(type, data) {
  const base = CONTRIBUTION_STREAMS[type]?.label ?? type;
  if (type === 'K401_CONTRIBUTION_APPLY') {
    if (data?.nonElective)    return '401(k) Non-Elective';
    if (data?.employerFunded) return '401(k) Match';
    return '401(k) Deferral';
  }
  if (type === 'SUPER_CONTRIBUTION_APPLY') {
    if (data?.deductible)     return 'Personal Deductible Super';
    if (data?.employerFunded) return 'Super Guarantee';
    return 'Super Contribution';
  }
  return base;
}

/** An account's display name, falling back to its state key. */
function _accountLabel(stateKey, state) {
  if (stateKey == null) return null;
  return state?.[stateKey]?.name ?? state?.[stateKey]?.stateKey ?? stateKey;
}
