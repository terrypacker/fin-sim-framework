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
 * fica-rates.js — the employee FICA rates and wage base (IRC §3101, §3121(a)(1)).
 *
 * Deliberately a leaf module with no imports, for the same reason
 * `au/super-tax-rate.js` is one: design 95 phase 5 made these visible to call sites
 * that MUST agree on them, and there is no version of "they drifted" that is not a
 * bug —
 *
 *   - the annual tax computation (`us-tax-rates-base.js`), which charges FICA; and
 *   - the payroll handler, which WITHHOLDS it monthly and whose withholding the
 *     settle then credits against that same liability.
 *
 * If those two ever disagreed the difference would silently become a balance due or
 * an over-withholding, and it would look like an ordinary rounding residual rather
 * than like two modules using different numbers.
 *
 * ─── rates ───────────────────────────────────────────────────────────────────
 *
 * §3101(a) OASDI 6.2% up to the contribution and benefit base; §3101(b)(1) HI 1.45%
 * uncapped. §3101(b)(2)'s 0.9% Additional Medicare surtax is NOT here: it is a
 * return-level computation on combined earned income against a filing-status
 * threshold, not a payroll rate, and it stays in the tax module.
 *
 * These are exactly half the SECA rates — a self-employed person pays both halves.
 * The employER half of an employee's FICA is the employer's own liability and is
 * not modelled.
 *
 * ─── the wage base is per EMPLOYEE ───────────────────────────────────────────
 *
 * §3121(a)(1) applies the base to each employee separately, so two earners each get
 * a full base. Pooling a household against one base under-charges every two-earner
 * household from the moment their combined pay passes it.
 *
 * Source: `docs/us-tax/SSA-COLA-Fact-Sheet-2026.txt` (Maximum Taxable Earnings).
 * Transcribed from the authority within the published range. Past it the base must be
 * PROJECTED — holding it flat for the decades a retirement run covers understates the
 * OASDI charge on every high earner — and the projection rides its own US_FICA series
 * precisely because the base moves with the SSA average wage index rather than with
 * this model's price inflation. The factor is passed IN rather than read from state so
 * this stays a leaf module with no imports; `bracketIndexationFactor` computes it.
 */

/** IRC §3101(a) — employee OASDI. */
export const FICA_SS_RATE = 0.062;

/** IRC §3101(b)(1) — employee HI (Medicare), uncapped. */
export const FICA_MEDICARE_RATE = 0.0145;

/** §3121(a)(1) contribution and benefit base, by calendar year. */
export const FICA_WAGE_BASE_BY_YEAR = {
  2025: 176_100,
  2026: 184_500,
};

const _YEARS = Object.keys(FICA_WAGE_BASE_BY_YEAR).map(Number).sort((a, b) => a - b);
const _FIRST = _YEARS[0];
const _LAST  = _YEARS[_YEARS.length - 1];

/** The last calendar year SSA has published a contribution and benefit base for. */
export const LAST_PUBLISHED_FICA_YEAR = _LAST;

/**
 * The contribution and benefit base in force for `taxYear`.
 *
 * Clamps to the published range at both ends and applies `indexFactor` to whatever it
 * lands on. Inside the range the caller passes 1 (or nothing) and the transcribed
 * figure is returned exactly; past it the caller passes the US_FICA projection factor
 * anchored at `LAST_PUBLISHED_FICA_YEAR`.
 *
 * @param {number} taxYear
 * @param {number} [indexFactor=1] projection factor for years past the published range
 */
export function ficaWageBase(taxYear, indexFactor = 1) {
  const y = Number.isFinite(taxYear) ? Math.min(Math.max(taxYear, _FIRST), _LAST) : _LAST;
  return FICA_WAGE_BASE_BY_YEAR[y] * indexFactor;
}

/**
 * One person's FICA on a month's wage, given what they have already earned this year.
 *
 * The running total is what makes the monthly withholding foot EXACTLY to the annual
 * charge: OASDI stops mid-year at the base for a high earner, and a withholding that
 * kept going would over-withhold and need a refund the model has no path for.
 *
 * The `indexFactor` is not optional in spirit: it MUST be the same projection the
 * annual charge uses, or the two disagree past the published range and the difference
 * silently becomes a balance due that looks like a rounding residual — the exact
 * failure this module's header exists to prevent.
 *
 * @param {number} wage        this month's gross wage
 * @param {number} ssWagesYTD  this person's SS-covered wages already booked this year
 * @param {number} taxYear
 * @param {number} [indexFactor=1] US_FICA projection factor, per `ficaWageBase`
 * @returns {{ss: number, medicare: number, total: number}}
 */
export function ficaOnWage(wage, ssWagesYTD, taxYear, indexFactor = 1) {
  if (!(wage > 0)) return { ss: 0, medicare: 0, total: 0 };
  const base      = ficaWageBase(taxYear, indexFactor);
  const alreadyOn = Math.min(Math.max(0, ssWagesYTD), base);
  const ssPortion = Math.max(0, Math.min(wage, base - alreadyOn));
  const ss        = +(ssPortion * FICA_SS_RATE).toFixed(2);
  const medicare  = +(wage * FICA_MEDICARE_RATE).toFixed(2);
  return { ss, medicare, total: +(ss + medicare).toFixed(2) };
}
