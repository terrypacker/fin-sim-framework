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
 * bracket-schedule — marginal-bracket arithmetic, shared by every rate module
 * (design 71 §3).
 *
 * Before this module, `_applyBrackets` and `_marginalBracketRate` existed as three
 * byte-identical private copies (US federal, AU, US state). They are collapsed here
 * and, more importantly, extended: `applyBracketsDetailed` keeps the **per-band
 * detail** that the scalar version throws away, so a tax worksheet can show which
 * income fell in which bracket and what tax each band produced.
 *
 * A `bracket table` is `[[lowerThreshold, rate], ...]` ascending by threshold, with
 * the first entry's threshold conventionally 0. A `band` is one row of the applied
 * schedule:
 *
 *   { lower, upper, rate, income, tax }
 *
 * where `upper` is `null` on the open-ended top band, `income` is the portion of the
 * subject income falling inside [lower, upper), and `tax` is `income × rate`.
 */

/**
 * Apply marginal brackets, returning the total tax **and** the per-band detail.
 *
 * Every band in the table is emitted, including bands the income never reached
 * (`income: 0, tax: 0`). A zero band is evidence the taxpayer stayed below that
 * bracket — which is exactly what a validator wants to confirm — and a constant band
 * count per table keeps the exported worksheet rectangular across years.
 *
 * @param {number}                 income
 * @param {Array<[number, number]>} brackets  ascending by threshold
 * @returns {{ tax: number, bands: Array<{lower: number, upper: number|null, rate: number, income: number, tax: number}> }}
 */
export function applyBracketsDetailed(income, brackets) {
  const bands = [];
  let tax = 0;

  for (let i = 0; i < brackets.length; i++) {
    const [lower, rate] = brackets[i];
    const upper    = i + 1 < brackets.length ? brackets[i + 1][0] : null;
    const ceiling  = upper ?? Infinity;
    // Income above the band's floor, capped at its ceiling. Negative or
    // below-floor income yields 0 rather than a negative band.
    const inBand   = Math.max(0, Math.min(income, ceiling) - lower);
    const bandTax  = inBand * rate;

    bands.push({ lower, upper, rate, income: inBand, tax: bandTax });
    tax += bandTax;
  }

  return { tax, bands };
}

/**
 * Apply marginal brackets to an income amount — the scalar result only.
 *
 * Behaviorally identical to the three private copies it replaces: non-positive
 * income and an empty table both yield 0.
 *
 * @param {number}                  income
 * @param {Array<[number, number]>} brackets  ascending by threshold
 * @returns {number}
 */
export function applyBrackets(income, brackets) {
  if (income <= 0 || brackets.length === 0) return 0;
  return applyBracketsDetailed(income, brackets).tax;
}

/**
 * Return the marginal rate of the highest bracket reached by income.
 *
 * @param {number}                  income
 * @param {Array<[number, number]>} brackets
 * @returns {number}
 */
export function marginalBracketRate(income, brackets) {
  if (income <= 0 || brackets.length === 0) return 0;
  let rate = 0;
  for (const [lower, r] of brackets) {
    if (income > lower) rate = r;
  }
  return rate;
}

/**
 * Band-wise difference of two schedules: `bands(a) − bands(b)`, matched by index.
 *
 * Several taxes in the engine are computed as a *differential* over the same bracket
 * table rather than by applying the table to an amount directly:
 *
 *   - US long-term capital gains (IRC §1(h)) — gains stack on top of taxable ordinary
 *     income, so the tax is `brackets(ordinary + cg) − brackets(ordinary)`.
 *   - US FEIE stacking (IRS Foreign Earned Income Tax Worksheet) — the excluded income
 *     is stacked at the bottom, so the tax is `brackets(all) − brackets(excluded)`.
 *   - AU capital gains — the relieved gain is stacked on ordinary income and taxed at
 *     the resulting marginal brackets (AU has no separate CGT rate schedule).
 *
 * In each case the scalar difference is already computed; this recovers *which band*
 * the differential came from. Both operands must come from the same bracket table, so
 * index alignment is exact — mismatched inputs are a programming error and throw.
 *
 * @param {Array<object>} aBands
 * @param {Array<object>} bBands
 * @returns {Array<object>} bands with differenced `income` and `tax`
 */
export function subtractBands(aBands, bBands) {
  if (aBands.length !== bBands.length) {
    throw new Error(
      `[bracket-schedule] subtractBands: band count mismatch (${aBands.length} vs ${bBands.length}) `
      + '— operands must come from the same bracket table',
    );
  }
  return aBands.map((a, i) => {
    const b = bBands[i];
    if (a.lower !== b.lower || a.rate !== b.rate) {
      throw new Error(
        `[bracket-schedule] subtractBands: band ${i} mismatch `
        + `(lower ${a.lower}/${b.lower}, rate ${a.rate}/${b.rate})`,
      );
    }
    return {
      lower:  a.lower,
      upper:  a.upper,
      rate:   a.rate,
      income: a.income - b.income,
      tax:    a.tax    - b.tax,
    };
  });
}

/**
 * Describe a flat (non-bracketed) rate as a worksheet-shaped record, so surfaces can
 * render NIIT / collectibles / Medicare-levy style lines through the same code path
 * as a bracket band without inventing a one-band schedule for them.
 *
 * @param {number} rate
 * @param {number} income
 * @param {number} [tax]  defaults to `income × rate`; pass explicitly when the engine
 *                        applies caps or thresholds the bare product doesn't capture.
 */
export function flatRateBand(rate, income, tax = income * rate) {
  return { rate, income, tax };
}
