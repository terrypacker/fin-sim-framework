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
 * holding-period.js — the ONE definition of "how long was this held, and does that
 * make it long-term here" (design 90 §3.1, §6).
 *
 * This module exists because of what happened to the disposal payload the last time a
 * per-lot fact had to reach six emitters. `auDiscountableGain` was computed
 * independently at each site, they drifted, and the path raising 98% of a real plan's
 * disposals shipped the thinnest payload of the six while the rebalancer taxed the same
 * lots correctly (design/inconsistencies §4.11). `disposal-tax-payload-parity.test.mjs`
 * now stops an emitter *omitting* a field — it cannot stop six emitters computing the
 * same field six subtly different ways. One exported function can.
 *
 * The holding-period test is per COUNTRY and the two jurisdictions genuinely differ at
 * the boundary:
 *
 *   AU — ITAA 1997 Div 115 grants the CGT discount where the asset was acquired
 *        "at least 12 months" before the CGT event. Inclusive.
 *   US — IRC §1222(3) defines long-term as held "for more than 1 year", and §1222(1)
 *        defines short-term as "not more than 1 year". Exclusive.
 *
 * So a lot held exactly one year is AU-discountable and US-short-term at the same
 * instant. That is not a rounding artefact to be smoothed over; it is what the two
 * statutes say, and the design-62 residency step-up makes the case reachable.
 */

/** One year in ms. Leap years are ignored, matching every other clock in the model. */
export const YEAR_MS = 365 * 24 * 60 * 60 * 1000;

/**
 * Per-country long-term test, keyed by ISO country code. A country with no entry
 * defaults to the inclusive (AU) form — the behaviour this codebase has always had.
 */
export const LONG_TERM_TEST = Object.freeze({
  AU: (heldMs) => heldMs >= YEAR_MS,
  US: (heldMs) => heldMs >  YEAR_MS,
});

/**
 * @param {string} country  ISO country code
 * @param {number} heldMs   holding period in ms
 * @returns {boolean} true when the country treats this as long-term
 */
export function isLongTerm(country, heldMs) {
  return (LONG_TERM_TEST[country] ?? LONG_TERM_TEST.AU)(heldMs);
}

/**
 * The four signed, charactered fields every capital-gains disposal action carries
 * (design 90 §9 step 2), built from a `consumeHoldings` term tally.
 *
 * Returned as an object so the arithmetic has one home, but callers are expected to
 * **destructure and write the keys explicitly** into the action rather than spreading
 * this in. That is not style: `disposal-tax-payload-parity.test.mjs` scans object
 * literals statically, and a spread is invisible to it — the parity guarantee is only
 * real while the keys are literal (shorthand counts).
 *
 * @param {Object<string,{short:number,long:number}>|null} byCountryAndTerm
 *   `realizedGainByCountryAndTerm` or `collectibleGainByCountryAndTerm`.
 * @returns {{usShortTermGain:number, usLongTermGain:number, auShortTermGain:number, auLongTermGain:number}}
 */
export function disposalTermFields(byCountryAndTerm) {
  return {
    usShortTermGain: byCountryAndTerm?.US?.short ?? 0,
    usLongTermGain:  byCountryAndTerm?.US?.long  ?? 0,
    auShortTermGain: byCountryAndTerm?.AU?.short ?? 0,
    auLongTermGain:  byCountryAndTerm?.AU?.long  ?? 0,
  };
}

/**
 * The same four fields for a disposal of a SINGLE asset that has no lot ledger —
 * company equity, real property, and the tax harvester's one targeted holding.
 *
 * These assets carry one basis and one acquisition date per country rather than an
 * array of lots, so there is nothing to walk; but the character test and the sign
 * convention must be identical to the lot-based path, which is why this lives beside
 * it instead of being written out at each site.
 *
 * `auBasis`/`auAcquisitionMs` fall back to their US counterparts, matching the
 * `?? costBasis` convention every disposal emitter already uses for an asset that was
 * never stepped up (design 36 §12.2) — for such an asset the AU and US figures are
 * legitimately the same number.
 *
 * @param {Object}      o
 * @param {number}      o.proceeds
 * @param {number}      o.usBasis
 * @param {number}      [o.auBasis]           defaults to usBasis
 * @param {number|null} o.acquisitionMs       US acquisition (never deemed — only AU steps up)
 * @param {number|null} [o.auAcquisitionMs]   AU deemed acquisition; defaults to acquisitionMs
 * @param {number|null} o.saleMs
 * @param {boolean}     [o.deductibleLoss=true]
 *   When false, a LOSS is floored to zero and never recorded. IRC §165(c) allows an
 *   individual's loss deduction only for a trade or business, a transaction entered
 *   into for profit, or a casualty — a personal-use asset sold at a loss qualifies
 *   under none of them. See the call site in the real-property disposal.
 * @returns {{usShortTermGain:number, usLongTermGain:number, auShortTermGain:number, auLongTermGain:number}}
 */
export function singleAssetTermFields({ proceeds, usBasis, auBasis, acquisitionMs,
                                        auAcquisitionMs, saleMs, deductibleLoss = true }) {
  const auCost = auBasis ?? usBasis;
  const auAcq  = auAcquisitionMs ?? acquisitionMs;
  const clamp  = (v) => (deductibleLoss ? v : Math.max(0, v));
  const usGain = clamp(+(proceeds - usBasis).toFixed(2));
  const auGain = clamp(+(proceeds - auCost).toFixed(2));
  // An unknown acquisition or sale date cannot be characterized. Treat it as long-term:
  // every asset in this family (a house, a vested equity stake) is held for years, and
  // the alternative default — short-term — would tax a gain at ordinary rates on the
  // strength of a missing field.
  const usLong = acquisitionMs == null || saleMs == null || isLongTerm('US', saleMs - acquisitionMs);
  const auLong = auAcq         == null || saleMs == null || isLongTerm('AU', saleMs - auAcq);
  return {
    usShortTermGain: usLong ? 0 : usGain,
    usLongTermGain:  usLong ? usGain : 0,
    auShortTermGain: auLong ? 0 : auGain,
    auLongTermGain:  auLong ? auGain : 0,
  };
}
