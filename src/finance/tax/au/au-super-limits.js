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
 * au-super-limits.js — design 95 §10 / §9.2-9.5, phase 7. The Australian
 * superannuation contribution caps, and the two things derived from them.
 *
 * ─── one published figure, three limits ──────────────────────────────────────
 *
 * The unusual thing about the Australian caps is how little has to be transcribed.
 * ONE number per financial year — the concessional cap — determines three:
 *
 *   - **s291-20(2)** concessional cap: \$25,000 for 2017-18, indexed annually
 *     thereafter under Subdiv 960-M. Transcribed from the ATO's own table.
 *   - **s292-85(2)(a)** non-concessional cap = **4 x** the concessional cap. Not
 *     inferred: the ATO's published table is exactly 4x the concessional column in
 *     every row back to 2017-18, so this is the regulator confirming the statute.
 *   - **SGAA s10A(5)** maximum contributions base = `cap / charge_percentage x 100`,
 *     rounded **down** to the nearest \$10. Since s17A(2) writes *"charge percentage
 *     means 12"* into the Act as a literal, the base is `cap / 12 x 100` floored.
 *
 * So the SG base cannot drift out of step with the cap, because it IS the cap
 * rearranged. That interlock is the point: 12% of the base equals the cap exactly,
 * which is how the Act guarantees that the Super Guarantee ALONE can never produce
 * an excess concessional contribution. Anything over the cap is the member's own
 * doing.
 *
 * ─── the constant that was right for two years and is now wrong ──────────────
 *
 * \$250,000 is a very attractive number to write down: through 2025-26 the maximum
 * contributions base and the Div 293 threshold were both exactly that. They were
 * equal by construction of the parameters, not by law — s293-20's \$250,000 is a
 * fixed literal in the statute, while the base moves with the indexed cap. **From
 * 1 July 2026 they differ by \$20,830.** Compute the base; never hard-code it.
 *
 *   | | 2025-26 | 2026-27 |
 *   |---|---|---|
 *   | Concessional cap | \$30,000 | \$32,500 |
 *   | Max contributions base | \$250,000 | \$270,830 |
 *   | Div 293 threshold (s293-20) | \$250,000 | \$250,000 |
 *
 * ─── sources, all on disk ────────────────────────────────────────────────────
 *
 *   - `docs/au-tax/ITAA-1997/C2026C00324VOL06.txt` — s291-20, s292-85
 *   - `docs/au-tax/SGAA-1992/C2026C00272.txt` — s10A(5), s10A(6), s17A(2)
 *   - `docs/au-tax/ato-rates/ato-contributions-caps.txt` — the applied figures,
 *     the general transfer balance cap, and Table 2's worked carry-forward example
 *
 * ─── projection past the published horizon (phase 9) ────────────────────────
 *
 * Phase 7 shipped this table flat. Phase 9 projects past the last published year,
 * off the scenario's own cumulative inflation and the \$2,500 rounding amount
 * s960-285(7) item 2 sets for the concessional cap — see `../statutory-indexation.js`
 * for the method and for what it deliberately is not. Because everything here is
 * derived from that one figure, indexing it carries the non-concessional cap and the
 * s10A(5) base with it, and the interlock between the base and the cap survives the
 * projection unchanged.
 *
 * **The concessional cap indexes to AWOTE, not CPI** (s960-285(7) item 2 —
 * *average weekly ordinary time earnings*), while the transfer balance cap indexes to
 * CPI (item 3). This model has one inflation assumption per country and §10 is
 * explicit that a second series would measure the gap between two assumptions rather
 * than a policy outcome, so both are projected on it. AWOTE has historically run
 * ABOVE CPI, so using CPI-like inflation for the concessional cap UNDERSTATES its
 * growth — less contribution room later in a run, which is the conservative side.
 *
 * ─── the year key is the FINANCIAL YEAR START ────────────────────────────────
 *
 * `2026` means 2026-27, i.e. 1 Jul 2026 - 30 Jun 2027. That is the convention the
 * rest of the AU side already uses for `taxYear`, and mixing it with a calendar
 * year silently shifts every cap by six months.
 */

import { indexLimit, ROUNDING } from '../statutory-indexation.js';

/**
 * Concessional contributions caps by FINANCIAL YEAR START (s291-20(2)).
 *
 * Transcribed from the ATO's Table 1.1. Add a year by transcribing it, never by
 * indexing the row below — see the published-base rule in
 * `us-contribution-limits.js`.
 *
 * Stops at 2017-18: before that the cap was age-dependent (\$35,000 for the over-49s
 * through 2016-17), which s291-20(2)(a) abolished and which no scenario in this
 * model reaches.
 */
export const AU_CONCESSIONAL_CAP_BY_FY = {
  2017: 25_000,
  2018: 25_000,
  2019: 25_000,
  2020: 25_000,
  2021: 27_500,
  2022: 27_500,
  2023: 27_500,
  2024: 30_000,
  2025: 30_000,
  2026: 32_500,
};

/**
 * The general transfer balance cap by financial year start, from the ATO's own note
 * under Table 4. It gates the non-concessional cap: at or above it, the cap is NIL.
 */
export const AU_TRANSFER_BALANCE_CAP_BY_FY = {
  2017: 1_600_000,
  2018: 1_600_000,
  2019: 1_600_000,
  2020: 1_600_000,
  2021: 1_700_000,
  2022: 1_700_000,
  2023: 1_900_000,
  2024: 1_900_000,
  2025: 2_000_000,
  2026: 2_000_000,
};

/** SGAA s17A(2): *"charge percentage means 12"* — a literal in the Act. */
export const SG_CHARGE_PERCENTAGE = 12;

/** s291-20(3)(b): the carry-forward is available only below this total super balance. */
export const CARRY_FORWARD_TSB_THRESHOLD = 500_000;

/** s291-20(3)(c): the look-back window, in financial years. */
export const CARRY_FORWARD_YEARS = 5;

/** s291-20(7): no unused cap accrues for a financial year earlier than this one. */
export const CARRY_FORWARD_FIRST_ACCRUAL_FY = 2018;

/** s292-85(3)(c): the bring-forward is unavailable from the year you turn 75. */
export const BRING_FORWARD_MAX_AGE = 75;

const _FYS = Object.keys(AU_CONCESSIONAL_CAP_BY_FY).map(Number).sort((a, b) => a - b);
export const FIRST_PUBLISHED_FY = _FYS[0];
export const LAST_PUBLISHED_FY  = _FYS[_FYS.length - 1];

/** Clamp a financial year into the published range (flat outside it — see header). */
function _clampFy(fyStartYear) {
  if (!Number.isFinite(fyStartYear)) return LAST_PUBLISHED_FY;
  return Math.min(Math.max(fyStartYear, FIRST_PUBLISHED_FY), LAST_PUBLISHED_FY);
}

/**
 * s291-20(2) — the BASIC concessional cap for a financial year.
 *
 * "Basic" matters: s10A(5) refers to the basic cap, and the s292-85(2) note is
 * explicit that the non-concessional cap "does not take into account any increase in
 * your concessional contributions cap under subsection 291-20(4)". So neither of the
 * two derived limits ever sees the carry-forward increase — only the member's own
 * concessional headroom does.
 *
 * @param {number} fyStartYear  financial year START (2026 ⇒ 2026-27)
 * @returns {number} AUD
 */
export function concessionalCap(fyStartYear, indexFactor = 1) {
  const fy = _clampFy(fyStartYear);
  const published = AU_CONCESSIONAL_CAP_BY_FY[fy];
  // Inside the published range the ATO's own figure stands, whatever the factor.
  // Past it, s960-285(2): multiply the base, then round the RESULT down to the
  // \$2,500 rounding amount its item 2 sets.
  if (fy < LAST_PUBLISHED_FY) return published;
  return indexLimit(published, indexFactor, ROUNDING.AU_CONCESSIONAL_CAP);
}

/**
 * s292-85(2)(a) — the GENERAL non-concessional cap: 4 x the basic concessional cap.
 * Derived rather than transcribed, because the ATO's published table is 4x the
 * concessional column in every row and a second table could only ever disagree.
 *
 * This is the cap before the s292-85(2)(b) transfer-balance stop and before any
 * bring-forward; see `nonConcessionalCap`.
 *
 * @param {number} fyStartYear
 * @returns {number} AUD
 */
export function generalNonConcessionalCap(fyStartYear, indexFactor = 1) {
  // Derived from the INDEXED concessional cap, so the 4x relation survives the
  // projection exactly as it survives every published row. There is no separate
  // rounding step for it in s960-265 — it is not an indexed amount in its own right,
  // it is a multiple of one.
  return 4 * concessionalCap(fyStartYear, indexFactor);
}

/** The general transfer balance cap for a financial year (ATO, note under Table 4). */
export function transferBalanceCap(fyStartYear, indexFactor = 1) {
  const fy = _clampFy(fyStartYear);
  const published = AU_TRANSFER_BALANCE_CAP_BY_FY[fy];
  if (fy < LAST_PUBLISHED_FY) return published;
  // s960-285(7) item 3 — a \$100,000 rounding amount, which is why this cap moves in
  // long flat steps rather than annually: at 2.5% it takes four years to clear one.
  return indexLimit(published, indexFactor, ROUNDING.AU_TRANSFER_BALANCE_CAP);
}

/**
 * SGAA s10A(5) — the maximum contributions base.
 *
 *     floor_to_10( concessional_cap / charge_percentage x 100 )
 *
 * For 2026-27: 32,500 / 12 x 100 = 270,833.33 → **\$270,830**.
 *
 * The pre-Payday-Super regime had a QUARTERLY base, indexed independently of the
 * cap and published as its own figure. Compilation 78 removed both: there is no
 * s15 any more, the base is annual and cumulative (s10A(6)), and it falls out of
 * the cap. A model still applying a quarterly figure annually would let roughly
 * four times too much SG through, which is why this is derived in one place.
 *
 * @param {number} fyStartYear
 * @returns {number} AUD
 */
export function maxContributionsBase(fyStartYear, indexFactor = 1) {
  // Derived from the INDEXED cap. The base has a rounding rule of its own — s10A(5)'s
  // "rounded down to the nearest multiple of \$10" — applied here on top of the
  // \$2,500 the cap was already rounded to, exactly as the published rows are built.
  const raw = concessionalCap(fyStartYear, indexFactor) / SG_CHARGE_PERCENTAGE * 100;
  return Math.floor(raw / 10) * 10;
}

/**
 * SGAA s10A(6) — how much of THIS payment of qualifying earnings counts, given what
 * the employee has already been paid by this employer in the financial year.
 *
 * Not a rate cap and not an annual cap on the SG amount: it truncates the EARNINGS
 * the 12% is applied to. Past the base, a payment "is treated as if it were nil"
 * (s10A(6)(d)) — so the SG stops dead mid-year rather than tapering.
 *
 * @param {number} payment        this period's qualifying earnings
 * @param {number} earningsYTD    cumulative qualifying earnings, this employer, this FY
 * @param {number} fyStartYear
 * @returns {number} the countable portion of `payment`
 */
export function countableQualifyingEarnings(payment, earningsYTD, fyStartYear, indexFactor = 1) {
  const base = maxContributionsBase(fyStartYear, indexFactor);
  const room = Math.max(0, base - Math.max(0, earningsYTD));
  return Math.min(Math.max(0, payment), room);
}

/**
 * SGAA s17A(2) — the individual SG amount: qualifying earnings x 12 / 100.
 *
 * @param {number} countableEarnings  already truncated by `countableQualifyingEarnings`
 * @returns {number} AUD
 */
export function superGuaranteeAmount(countableEarnings) {
  return Math.max(0, countableEarnings) * SG_CHARGE_PERCENTAGE / 100;
}

/**
 * s291-20(3)-(5) — the concessional cap for a year, INCLUDING any carry-forward.
 *
 * Three conditions, all of which the ATO's own Table 2 worked example exercises:
 *
 *  - **(3)(a)** contributions "would otherwise exceed" the cap. The carry-forward is
 *    NOT an election you make and not headroom you can see: it materialises only to
 *    the extent you need it, which is why (4) caps the increase at the excess.
 *  - **(3)(b)** total super balance **just before the start of the year** is under
 *    \$500,000. This is tested EVERY YEAR, not once — the ATO's example has the
 *    balance cross to \$505,000 in 2020-21 (no carry-forward that year) and fall back
 *    to \$490,000 in 2021-22 (carry-forward available again). A model that treated the
 *    gate as a one-way switch would permanently destroy a member's accrued cap on a
 *    single good year.
 *  - **(3)(c)/(5)** unapplied unused cap from the previous 5 years, EARLIEST FIRST.
 *    Earliest-first is not cosmetic: unused cap expires after 5 years, so spending
 *    the oldest first is what preserves the most future headroom.
 *
 * Accrual is NOT gated (s291-20(6)): a year spent above the \$500,000 threshold still
 * accrues its own unused cap, it just cannot spend anyone else's.
 *
 * @param {object}  opts
 * @param {number}  opts.fyStartYear
 * @param {number}  opts.contributions  concessional contributions intended this year
 * @param {number}  opts.tsb            total super balance just before the FY start
 * @param {object}  opts.unusedByFy     { [fyStartYear]: unappliedAmount }
 * @returns {{ cap: number, basicCap: number, applied: Array<{fy: number, amount: number}>,
 *             carriedForward: number, gateOpen: boolean }}
 */
export function concessionalCapWithCarryForward(
  { fyStartYear, contributions = 0, tsb = 0, unusedByFy = {}, indexFactor = 1 } = {}) {
  const basicCap = concessionalCap(fyStartYear, indexFactor);
  const excess   = contributions - basicCap;
  const gateOpen = tsb < CARRY_FORWARD_TSB_THRESHOLD;

  // (3)(a) and (3)(b): no excess, or the balance gate is shut ⇒ the basic cap stands.
  if (!(excess > 0) || !gateOpen) {
    return { cap: basicCap, basicCap, applied: [], carriedForward: 0, gateOpen };
  }

  // (3)(c) + (5): the previous 5 financial years, earliest first. Years before
  // 2018-19 never accrue (s291-20(7)); a stored key from one is ignored rather than
  // trusted, so a hand-edited state cannot conjure cap the Act never granted.
  const oldest = fyStartYear - CARRY_FORWARD_YEARS;
  const years  = Object.keys(unusedByFy)
    .map(Number)
    .filter(fy => Number.isFinite(fy)
                && fy >= Math.max(oldest, CARRY_FORWARD_FIRST_ACCRUAL_FY)
                && fy < fyStartYear)
    .sort((a, b) => a - b);

  let remaining = excess;
  const applied = [];
  for (const fy of years) {
    if (!(remaining > 0)) break;
    const available = Math.max(0, unusedByFy[fy] ?? 0);
    if (!(available > 0)) continue;
    // (4): "but not by more than the excess from paragraph (3)(a)".
    const take = Math.min(available, remaining);
    applied.push({ fy, amount: take });
    remaining -= take;
  }

  const carriedForward = applied.reduce((s, a) => s + a.amount, 0);
  return { cap: basicCap + carriedForward, basicCap, applied, carriedForward, gateOpen };
}

/**
 * s291-20(6)-(7) — roll the unused-cap ring at the end of a financial year.
 *
 * Two movements in one place, because they have to agree about which year is which:
 * this year's shortfall is recorded, and anything older than the 5-year window
 * expires. The ATO puts it plainly: *"a 2019-20 unused cap amount that isn't used by
 * the end of 2024-25 will expire."*
 *
 * `applied` is what `concessionalCapWithCarryForward` actually spent, so the ring
 * decrements by exactly what was used rather than by a re-derivation that could
 * disagree with the cap the year was assessed under.
 *
 * @param {object}  opts
 * @param {number}  opts.fyStartYear    the year just ENDED
 * @param {number}  opts.contributions  concessional contributions made in it
 * @param {object}  opts.unusedByFy     the ring as it stood at the start of that year
 * @param {Array}   [opts.applied]      [{ fy, amount }] spent during that year
 * @returns {object} the ring for the next year
 */
export function rollUnusedConcessionalCap(
  { fyStartYear, contributions = 0, unusedByFy = {}, applied = [], indexFactor = 1 } = {}) {
  const next = {};

  // Spend first, so a year that both used old cap and accrued new cap nets correctly.
  const spent = new Map(applied.map(a => [Number(a.fy), a.amount]));
  for (const [k, v] of Object.entries(unusedByFy)) {
    const fy = Number(k);
    if (!Number.isFinite(fy)) continue;
    const left = Math.max(0, (v ?? 0) - (spent.get(fy) ?? 0));
    if (left > 0) next[fy] = +left.toFixed(2);
  }

  // s291-20(6): this year's own shortfall, measured against the BASIC cap. Not the
  // carried-forward one — a year that consumed old cap has no shortfall of its own,
  // and measuring against the increased cap would let a member accrue unused cap out
  // of cap they had already spent.
  const basicCap = concessionalCap(fyStartYear, indexFactor);
  const shortfall = basicCap - Math.max(0, contributions);
  if (shortfall > 0 && fyStartYear >= CARRY_FORWARD_FIRST_ACCRUAL_FY) {
    next[fyStartYear] = +shortfall.toFixed(2);
  }

  // Expire anything now outside the 5-year window. Done AFTER accrual so the year
  // just ended is never expired on the same pass that records it.
  const oldest = (fyStartYear + 1) - CARRY_FORWARD_YEARS;
  for (const k of Object.keys(next)) {
    if (Number(k) < oldest) delete next[k];
  }
  return next;
}

/**
 * s292-85(2)-(7) — the non-concessional cap for a year, bring-forward included.
 *
 * The transfer-balance stop in (2)(b) is a **hard nil**, not a taper: at or above the
 * general transfer balance cap immediately before the year starts, the cap is zero
 * and every non-concessional dollar is an excess contribution. For the balances these
 * scenarios model it is the binding constraint far more often than the annual cap is.
 *
 * The bring-forward (3)-(7) is NOT an election — it triggers automatically when the
 * year's contributions exceed the general cap and the four conditions hold. Its size
 * depends on the "first year cap space", the room between the transfer balance cap
 * and the member's balance:
 *
 *   - space <= 1x general cap ⇒ no bring-forward at all ((3)(e) fails)
 *   - 1x < space <= 2x        ⇒ 2x, under (5)(a)
 *   - space > 2x              ⇒ 3x, under (5)(b)
 *
 * Years two and three of a triggered bring-forward get the SHORTFALL of the first
 * year's cap ((6), (7)), which is nil once the member has used it all — that is the
 * whole shape of "bring forward", and it is why the caller passes the bring-forward
 * state in rather than this function guessing at it.
 *
 * @param {object}  opts
 * @param {number}  opts.fyStartYear
 * @param {number}  opts.tsb            total super balance immediately before the FY start
 * @param {?number} [opts.age]          age at any time in the year; null ⇒ treated as eligible
 * @param {number}  [opts.contributions] intended NCC for the year, for the (3)(a) trigger
 * @param {?object} [opts.bringForward] { firstFy, cap, used } from a live arrangement
 * @returns {{ cap: number, generalCap: number, reason: string,
 *             bringForwardTriggered: boolean, bringForwardCap: number }}
 */
export function nonConcessionalCap(
  { fyStartYear, tsb = 0, age = null, contributions = 0, bringForward = null,
    indexFactor = 1 } = {}) {
  const generalCap = generalNonConcessionalCap(fyStartYear, indexFactor);
  const tbc        = transferBalanceCap(fyStartYear, indexFactor);

  // (2)(b) — the hard stop, and it precedes everything. (3)(b) makes it a bar to the
  // bring-forward too, so there is nothing to work out below it.
  if (tsb >= tbc) {
    return { cap: 0, generalCap, reason: 'TRANSFER_BALANCE_CAP',
             bringForwardTriggered: false, bringForwardCap: 0 };
  }

  // (6)/(7) — years two and three of an arrangement already running: the cap is the
  // shortfall of the first year's cap, which is nil once it has been used up.
  if (bringForward != null && bringForward.firstFy != null
      && fyStartYear > bringForward.firstFy && fyStartYear <= bringForward.firstFy + 2) {
    const left = Math.max(0, (bringForward.cap ?? 0) - (bringForward.used ?? 0));
    return { cap: left, generalCap, reason: 'BRING_FORWARD_REMAINDER',
             bringForwardTriggered: false, bringForwardCap: bringForward.cap ?? 0 };
  }

  // (3) — do the conditions for a NEW arrangement hold?
  const capSpace  = tbc - tsb;                                   // (3)(e)
  const ageOk     = age == null || age < BRING_FORWARD_MAX_AGE;  // (3)(c)
  const wouldBust = contributions > generalCap;                  // (3)(a)
  if (wouldBust && ageOk && capSpace > generalCap) {
    // (5) — a straight two-way branch on the first year cap space, NOT a ladder:
    // (a) space at or under 2x the general cap gives 2x; (b) "otherwise" gives 3x.
    // (4) says the same thing from the other side, by disapplying the third year
    // whenever (5)(a) is the branch taken.
    const cap = capSpace <= 2 * generalCap ? 2 * generalCap : 3 * generalCap;
    return { cap, generalCap, reason: 'BRING_FORWARD',
             bringForwardTriggered: true, bringForwardCap: cap };
  }

  return { cap: generalCap, generalCap, reason: 'GENERAL',
           bringForwardTriggered: false, bringForwardCap: 0 };
}
