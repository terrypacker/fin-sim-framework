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
 * au-super-caps.js — design 95 §9.2-9.5, phase 7. One month of Australian super
 * contributions, with every cap applied.
 *
 * The AU counterpart of `k401-limits.js`, and deliberately the same shape: a pure
 * function of (elections, this person's running totals, the financial year) that
 * returns the amounts to contribute plus the NAMES of whatever bound them. The
 * names are the point — design 95 D8 is "track and clamp, and JOURNAL the clamp",
 * so that a contribution which stopped in March reads as `Div 291` in the journal
 * rather than as an unexplained smaller number.
 *
 * ─── the order the caps bind in, and why it is not arbitrary ─────────────────
 *
 *  1. **SGAA s10A(6)** truncates qualifying EARNINGS at the maximum contributions
 *     base, before the 12% is applied. This one is not really a cap on the member
 *     at all — it is a limit on the employer's obligation.
 *  2. **Div 291** then rations what is left of the concessional cap across the
 *     three concessional streams, in the order SG → sacrifice → personal
 *     deductible. Employer money has first claim because the member cannot refuse
 *     it: an SG dollar crowded out by the member's own sacrifice would be a
 *     contribution their employer still legally owes them.
 *  3. **Div 292** rations the non-concessional stream, which shares nothing with
 *     the concessional pool.
 *
 * The interlock between 1 and 2 is what makes this coherent: 12% of the s10A(5)
 * base IS the concessional cap (to within the base's \$10 rounding), so the Super
 * Guarantee alone can never produce an excess concessional contribution. Any
 * clamping of the member's own streams is therefore genuinely the member's own
 * doing, which is what makes clamping them defensible rather than arbitrary.
 *
 * ─── what "clamp" models, and what it does not ───────────────────────────────
 *
 * **Exceeding these caps is not illegal, and this module makes it impossible.**
 * That is a deliberate divergence, taken under D8, and it is worth stating plainly
 * because it is the one place this design departs from the Act it cites. In law:
 *
 *   - excess CONCESSIONAL contributions (s291-20(1)) are included in the member's
 *     assessable income and taxed at their marginal rate, with a 15% offset for the
 *     tax the fund already paid, and the excess then counts toward the
 *     non-concessional cap;
 *   - excess NON-CONCESSIONAL contributions (s292-85(1)) trigger a determination,
 *     which the member answers by releasing the money or by paying tax on the
 *     associated earnings.
 *
 * Both are *rectification* regimes: an accounting for something that already
 * happened. Modelling them faithfully means modelling a determination, a release
 * authority and an election, none of which a projection can decide on the member's
 * behalf. Clamping instead models the member noticing the cap and stopping — which
 * is what a person with a financial plan actually does — and the journalled clamp
 * names the year and the limit, so a plan that is trying to contribute more than
 * the law allows is visible rather than silently re-priced.
 */

import {
  concessionalCapWithCarryForward, nonConcessionalCap,
  countableQualifyingEarnings, superGuaranteeAmount,
} from '../tax/au/au-super-limits.js';

/** Round to cents the way every other money path in this model does. */
const cents = n => Math.round((n + Number.EPSILON) * 100) / 100;

/**
 * The Australian financial year a date falls in, keyed by its START year.
 *
 * 1 Jul 2026 - 30 Jun 2027 is `2026`. This is the convention `taxYear` already uses
 * on the AU side and the one `au-super-limits.js` tables are keyed by; a calendar
 * year silently shifts every cap by six months.
 *
 * @param {Date|number|string} date
 * @returns {number}
 */
export function auFinancialYearOf(date) {
  const d = date instanceof Date ? date : new Date(date);
  return d.getUTCMonth() >= 6 ? d.getUTCFullYear() : d.getUTCFullYear() - 1;
}

/**
 * One month of AU super, capped.
 *
 * @param {object}  o
 * @param {number}  o.fyStartYear
 * @param {number}  o.monthlyEarnings        this month's qualifying earnings, PRE-sacrifice
 * @param {number}  o.annualEarnings         for sizing the year's intended contributions
 * @param {number}  o.guaranteePct           the SG rate (a scenario assumption)
 * @param {?number} o.guaranteeAnnualCap     an authored cap ON TOP of the statute; null ⇒ statute only
 * @param {number}  o.sacrificePct           salary sacrifice, fraction of annual pay
 * @param {number}  o.deductibleAnnual       s290-150, annual AUD
 * @param {number}  o.nonConcessionalAnnual  annual AUD
 * @param {object}  o.caps                   this person's running record (see payroll-handler)
 * @param {?number} [o.age]                  for the s292-85(3)(c) bring-forward gate
 * @param {number}  [o.indexFactor=1]        design 95 §10 — cumulative inflation since
 *                                           the last published FY; 1 inside it
 * @returns {{ sg: number, sacrifice: number, deductible: number, nonConcessional: number,
 *             countableEarnings: number, clamps: string[], carriedForward: number,
 *             concessionalCap: number, nonConcessionalCap: number,
 *             bringForwardTriggered: boolean, bringForwardCap: number }}
 */
export function monthlyAuSuper({
  fyStartYear, monthlyEarnings, annualEarnings,
  guaranteePct = 0, guaranteeAnnualCap = null,
  sacrificePct = 0, deductibleAnnual = 0, nonConcessionalAnnual = 0,
  caps = {}, age = null, indexFactor = 1,
}) {
  const clamps = [];
  const concessionalYTD    = Math.max(0, caps.concessionalYTD    ?? 0);
  const nonConcessionalYTD = Math.max(0, caps.nonConcessionalYTD ?? 0);
  const earningsYTD        = Math.max(0, caps.qualifyingEarningsYTD ?? 0);
  const tsb                = Math.max(0, caps.tsbAtFyStart ?? 0);

  // ── 1. SGAA s10A(5)/(6): truncate the EARNINGS, then take the charge percentage ──
  //
  // Note this uses PRE-sacrifice earnings. s10A(1)(h) counts a salary-sacrificed
  // reduction as qualifying earnings, so sacrificing neither reduces the SG nor
  // slows the member's progress toward the base.
  const countableEarnings = countableQualifyingEarnings(
    monthlyEarnings, earningsYTD, fyStartYear, indexFactor);
  if (countableEarnings < monthlyEarnings - 0.005) clamps.push('s10A(5) base');

  // `guaranteePct` is a scenario assumption and may differ from the statutory 12,
  // so the rate is applied here rather than through `superGuaranteeAmount` — that
  // helper exists for the statutory calculation the base is derived from, and using
  // it here would silently override the scenario's own rate.
  let sg = cents(countableEarnings * Math.max(0, guaranteePct));

  // An authored annual cap applies ON TOP of the statute, never instead of it —
  // same rule as the 401(k) plan cap. A scenario may model an employer contributing
  // less than the SGAA requires; it may not model one contributing more.
  if (guaranteeAnnualCap != null) {
    // Measured against the SG's OWN running total, not the shared concessional pool.
    // Against the pool it bound every month on a scenario whose employer contribution
    // was nowhere near it — the member's sacrifice was eating an employer cap.
    const room = Math.max(0, guaranteeAnnualCap - Math.max(0, caps.sgYTD ?? 0));
    if (sg > room) { sg = cents(room); clamps.push('SG scenario cap'); }
  }

  // ── 2. Div 291: the concessional cap, across all three concessional streams ──
  //
  // The year's INTENDED concessional total sizes the s291-20(3)(a) test: the
  // carry-forward materialises only to the extent contributions "would otherwise
  // exceed" the cap, so a member who stays under it never touches their accrued
  // cap — and a monthly view that asked "does THIS month exceed" would answer no
  // every month and never release any of it.
  const wantSacrificeAnnual = Math.max(0, annualEarnings * Math.max(0, sacrificePct));
  const intendedConcessional =
      Math.max(0, annualEarnings * Math.max(0, guaranteePct))
    + wantSacrificeAnnual
    + Math.max(0, deductibleAnnual);

  const cc = concessionalCapWithCarryForward({
    fyStartYear, contributions: intendedConcessional, tsb,
    unusedByFy: caps.unusedByFy ?? {}, indexFactor,
  });
  // NOT a clamp. `clamps` names what STOPPED a contribution; the carry-forward is
  // the opposite — cap the member accrued in earlier years being released to let a
  // contribution through that would otherwise have been stopped. Reported on its own
  // field so the journal can show relief and restriction as the different things they
  // are, instead of one list that means "something about Div 291 happened".

  let concessionalRoom = Math.max(0, cc.cap - concessionalYTD);

  // Employer money has first claim: the member cannot decline an SG contribution,
  // so it cannot be the stream that gives way.
  if (sg > concessionalRoom) { sg = cents(concessionalRoom); clamps.push('Div 291'); }
  concessionalRoom -= sg;

  // Capped at the month's EARNINGS before anything else. Sacrificing more than you
  // are paid is not an arrangement an employer can operate, and without this the
  // wage the handler computes goes NEGATIVE and negative pay reaches the tax chain —
  // which is exactly what an over-set rate produced before AUS-6 caught it.
  const electedSacrifice = cents(wantSacrificeAnnual / 12);
  const wantSacrifice    = Math.min(electedSacrifice, cents(Math.max(0, monthlyEarnings)));
  // Named, not silent. An over-set rate truncated here is exactly the "smaller number
  // with no explanation" D8 exists to prevent, and it is a DIFFERENT cause from the
  // cap binding — one is the member electing more than they are paid, the other is
  // the statute.
  if (wantSacrifice < electedSacrifice - 0.005) clamps.push('sacrifice exceeds pay');
  let sacrifice = Math.min(wantSacrifice, concessionalRoom);
  if (sacrifice < wantSacrifice - 0.005) clamps.push('Div 291');
  sacrifice = cents(Math.max(0, sacrifice));
  concessionalRoom -= sacrifice;

  // The personal deductible contribution gives way LAST among the three, because it
  // is the one the member can redirect: money that cannot be contributed
  // concessionally can still be contributed non-concessionally, whereas a forgone
  // salary sacrifice has to be unwound with the employer.
  const wantDeductible = cents(Math.max(0, deductibleAnnual) / 12);
  let deductible = Math.min(wantDeductible, concessionalRoom);
  if (deductible < wantDeductible - 0.005) clamps.push('Div 291');
  deductible = cents(Math.max(0, deductible));

  // ── 3. Div 292: the non-concessional cap, an entirely separate pool ─────────
  const intendedNc = Math.max(0, nonConcessionalAnnual);
  const nc = nonConcessionalCap({
    fyStartYear, tsb, age, contributions: intendedNc,
    bringForward: caps.bringForward ?? null, indexFactor,
  });

  const wantNonConcessional = cents(intendedNc / 12);
  let nonConcessional = Math.min(wantNonConcessional, Math.max(0, nc.cap - nonConcessionalYTD));
  if (nonConcessional < wantNonConcessional - 0.005) {
    clamps.push(nc.reason === 'TRANSFER_BALANCE_CAP' ? 'transfer balance cap' : 'Div 292');
  }
  nonConcessional = cents(Math.max(0, nonConcessional));

  return {
    sg, sacrifice, deductible, nonConcessional,
    countableEarnings,
    // Deduped, because the same limit binding two streams in one month is one fact
    // about the year, not two — and a journal entry reading `Div 291, Div 291` says
    // nothing the single name does not.
    clamps: [...new Set(clamps)],
    concessionalCap:       cc.cap,
    concessionalApplied:   cc.applied,
    carriedForward:        cc.carriedForward,
    nonConcessionalCap:    nc.cap,
    bringForwardTriggered: nc.bringForwardTriggered,
    bringForwardCap:       nc.bringForwardCap,
  };
}
