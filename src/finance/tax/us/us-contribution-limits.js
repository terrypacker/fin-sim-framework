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
 * us-contribution-limits.js — design 95 §10, phase 3. The statutory dollar limits
 * on qualified-plan contributions.
 *
 * ─── the statute gives BASES, not the numbers you need ───────────────────────
 *
 * Every limit here is a base amount in the Code plus a cost-of-living adjustment:
 *
 *   - **§402(g)(1)(B)** — elective deferral limit. Base **\$15,000**; §402(g)(4)
 *     indexes it as under §415(d) from a Q3-2005 base period, rounded **down** to a
 *     multiple of \$500. (`docs/us-tax/…subpartA-sec402.txt`)
 *   - **§415(c)(1)** — annual additions: the lesser of a base **\$40,000** or 100%
 *     of compensation. (`docs/us-tax/…subpartB-sec415.txt`)
 *   - **§401(a)(17)(A)** — compensation limit. Base **\$200,000**, indexed from a
 *     Q3-2001 base period, rounded **down** to a multiple of \$5,000.
 *     (`docs/us-tax/…subpartA-sec401.txt`)
 *   - **§414(v)(2)** — catch-up contributions, and the SECURE 2.0 age-60-to-63
 *     amount under §414(v)(2)(E). (`docs/us-tax/…subpartB-sec414.txt`)
 *
 * **The applied figures below are TRANSCRIBED from the IRS notice, not compounded
 * forward from those bases.** Rounding differs per provision — §402(g) rounds down
 * to \$500, §401(a)(17) down to \$5,000 — and compounding our own inflation series
 * through two decades of those steps does not reproduce the published number. That
 * is the standing rule for any published-base figure in this model: take the
 * cumulative amount from the authority.
 *
 * Source: `docs/us-tax/IRS-Notice-2025-67-Retirement-COLA-2026.txt` (2026 amounts,
 * with the 2025 amounts it supersedes stated alongside each).
 *
 * ─── projection past the published horizon (phase 9) ────────────────────────
 *
 * Phase 3 shipped this table flat: beyond 2026 a 40-year run held 2026 limits in
 * nominal terms, understating later headroom *visibly* rather than wrongly. Phase 9
 * projects instead, off the scenario's own cumulative inflation and each provision's
 * own rounding step — see `../statutory-indexation.js` for the method and for what it
 * deliberately is not. Inside the published range the transcribed figures always
 * stand; the projection begins only where the authority stops.
 *
 * A scenario that wants different limits sets them per person or per household; the
 * table is the default, not a constraint.
 */

/**
 * Published limits by tax year. Add a year by transcribing that year's notice —
 * never by scaling the row below it.
 */
import { indexLimit, ROUNDING } from '../statutory-indexation.js';

export const US_CONTRIBUTION_LIMITS_BY_YEAR = {
  2025: {
    electiveDeferral:         23_500,   // §402(g)(1)
    catchUp50:                 7_500,   // §414(v)(2)(B)(i)
    catchUp60to63:            11_250,   // §414(v)(2)(E)(i)
    annualAdditions:          70_000,   // §415(c)(1)(A)
    compensation:            350_000,   // §401(a)(17)
    iraContribution:           7_000,   // §219(b)(5)(A)
    iraCatchUp50:              1_000,   // §219(b)(5)(B)(ii)
    rothCatchUpWageThreshold:145_000,   // §414(v)(7)(A)
  },
  2026: {
    electiveDeferral:         24_500,
    catchUp50:                 8_000,
    catchUp60to63:            11_250,   // unchanged from 2025 per the notice
    annualAdditions:          72_000,
    compensation:            360_000,
    iraContribution:           7_500,
    iraCatchUp50:              1_100,
    rothCatchUpWageThreshold:150_000,
  },
};

const _YEARS = Object.keys(US_CONTRIBUTION_LIMITS_BY_YEAR).map(Number).sort((a, b) => a - b);

/** Earliest and latest published years, for callers that want to say so. */
export const FIRST_PUBLISHED_YEAR = _YEARS[0];
export const LAST_PUBLISHED_YEAR  = _YEARS[_YEARS.length - 1];

/**
 * The statutory rounding step for each limit, from the provision that sets it.
 *
 * Every one differs, which is exactly why they are named rather than shared: a single
 * step applied to all of them would be wrong for three of the six.
 */
const STEP = {
  electiveDeferral:         ROUNDING.US_ELECTIVE_DEFERRAL,
  catchUp50:                ROUNDING.US_CATCH_UP,
  catchUp60to63:            ROUNDING.US_CATCH_UP,
  annualAdditions:          ROUNDING.US_ANNUAL_ADDITIONS,
  compensation:             ROUNDING.US_COMPENSATION,
  iraContribution:          ROUNDING.US_IRA,
  iraCatchUp50:             ROUNDING.US_IRA_CATCHUP,
  rothCatchUpWageThreshold: ROUNDING.US_ROTH_CATCHUP_WAGES,
};

/**
 * The limits in force for `taxYear`.
 *
 * Clamps to the published range at both ends. Before the first published year this
 * returns the earliest table — a scenario starting in 2020 is not a claim about
 * 2020 law, it is a scenario the model has no table for, and refusing would break
 * runs that never touch a limit.
 *
 * **Past the last published year the table is PROJECTED** (design 95 §10, phase 9),
 * using `indexFactor` — the scenario's own cumulative inflation since that year — and
 * each provision's own rounding step. A caller that passes no factor gets the last
 * published table unchanged, which is the pre-phase-9 behaviour and what every
 * non-simulation caller wants.
 *
 * @param {number} taxYear
 * @param {object} [opts]
 * @param {number} [opts.indexFactor=1]  cumulative factor since LAST_PUBLISHED_YEAR
 * @returns {{electiveDeferral:number, catchUp50:number, catchUp60to63:number,
 *            annualAdditions:number, compensation:number, iraContribution:number,
 *            iraCatchUp50:number, rothCatchUpWageThreshold:number}}
 */
export function usContributionLimits(taxYear, { indexFactor = 1 } = {}) {
  const y = Number.isFinite(taxYear)
    ? Math.min(Math.max(taxYear, FIRST_PUBLISHED_YEAR), LAST_PUBLISHED_YEAR)
    : LAST_PUBLISHED_YEAR;
  const published = US_CONTRIBUTION_LIMITS_BY_YEAR[y];

  // Inside the published range the transcribed figures stand, whatever the factor:
  // the authority's number for a year it has published is not ours to adjust, and a
  // caller whose accumulator has drifted must not be able to move it.
  if (y < LAST_PUBLISHED_YEAR || !(indexFactor > 1)) return published;

  return Object.fromEntries(Object.entries(published)
    .map(([k, v]) => [k, indexLimit(v, indexFactor, STEP[k] ?? 0)]));
}

/**
 * The §414(v) catch-up an individual of `age` may make on top of §402(g).
 *
 * SECURE 2.0 §109 gives 60-63 a HIGHER amount than 50+, and it reverts at 64 —
 * a band, not a floor. Age is taken at the end of the taxable year, which is what
 * "attains age 50 before the close of the taxable year" means; callers pass the age
 * the person reaches during the year rather than their age today.
 *
 * @param {number} age      age attained during the tax year
 * @param {object} limits   from {@link usContributionLimits}
 */
export function catchUpAllowance(age, limits) {
  if (!(age >= 50)) return 0;
  if (age >= 60 && age <= 63) return limits.catchUp60to63;
  return limits.catchUp50;
}
