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
 * franking.js — the ITAA 1997 imputation arithmetic (design 76 §8, design 90 §8).
 *
 * ## What the Act says, read from disk
 *
 * `docs/au-tax/ITAA-1997/C2026C00324VOL05.txt`, s202-60(2): the maximum franking credit
 * on a distribution is
 *
 *     Amount of the *frankable distribution × (1 ÷ applicable gross-up rate)
 *
 * and `…VOL10.txt:10872` defines the *corporate tax gross-up rate* as
 *
 *     (100% − corporate tax rate for imputation purposes) ÷ corporate tax rate
 *
 * Substituting gives `credit = cash × r/(1 − r)` — **30/70 ≈ 0.4286 at a 30% company
 * rate**, not 100% of the cash. That factor is the whole of design 76 §8.2 Gap 2, which
 * measured the model overstating the credit by ≈2.33×.
 *
 * s207-20(1) then includes that credit in assessable income "**in addition to** any other
 * amount included in the receiving entity's assessable income in relation to the
 * distribution" — the cash dividend — and s207-20(2) gives a tax offset "**equal to** the
 * franking credit". So a franked dividend is `cash + credit` of income carrying a `credit`
 * offset, which nets to roughly zero for a taxpayer on a 30% marginal rate and to real tax
 * above it. Gap 1 was booking neither half.
 *
 * ## Why the rate is a table and not a literal
 *
 * 30% is the *full* company rate; a base-rate entity pays 25%, and the gross-up follows
 * whichever rate the paying company used. A literal 0.30 would silently mis-state the
 * credit on any small-company holding, and the difference is not small — 25% gives
 * 25/75 = 0.3333 against 30/70 = 0.4286, a fifth less credit.
 */

/**
 * Corporate tax rates for imputation purposes. The gross-up follows the rate the PAYING
 * company used, so this is a property of the holding, not of the shareholder.
 */
export const CORPORATE_TAX_RATE = Object.freeze({
  /** The full company rate — ASX blue chips, which is what a retail portfolio holds. */
  FULL: 0.30,
  /** Base-rate entity (aggregated turnover under the threshold, ≤80% passive income). */
  BASE_RATE_ENTITY: 0.25,
});

/** The rate assumed when a distribution does not name one. */
export const DEFAULT_CORPORATE_TAX_RATE = CORPORATE_TAX_RATE.FULL;

/**
 * The franking credit on a distribution — s202-60(2).
 *
 * `frankedPercent` handles partial franking (design 76 §8 open question 2): a company
 * paying partly out of untaxed profits franks only part of the dividend, and the credit
 * scales with that part. Defaulting to 1 (fully franked) is right for the ASX blue chips
 * this models and, unlike defaulting the rate, cannot silently overstate anything a
 * scenario has actually described — an unfranked dividend goes through the *unfranked*
 * classifier, not this one.
 *
 * @param {number} cash            the cash distribution (AUD)
 * @param {object} [opts]
 * @param {number} [opts.corporateTaxRate]  the payer's rate for imputation purposes
 * @param {number} [opts.frankedPercent=1]  fraction of the distribution that is franked
 * @returns {number} the franking credit (AUD), never negative
 */
export function frankingCreditOn(cash, { corporateTaxRate, frankedPercent } = {}) {
  const r = corporateTaxRate ?? DEFAULT_CORPORATE_TAX_RATE;
  // A rate of 0 or 1 would divide by zero or blow up; neither is a real company rate,
  // and silently returning 0 beats propagating an Infinity into assessable income.
  if (!(r > 0 && r < 1)) return 0;
  const pct = Math.min(1, Math.max(0, frankedPercent ?? 1));
  return Math.max(0, cash * pct * (r / (1 - r)));
}
