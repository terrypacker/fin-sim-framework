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

/**
 * The AU CGT-reform cost-base indexation factor for a **scalar** asset — a house, a
 * vested equity stake, a bar of bullion. `consumeHoldingsFifo` already does this per
 * lot for account holdings (`holdings-fifo.js`); scalar assets have no lots, so the
 * same arithmetic lives here rather than being re-inlined at each disposal.
 *
 * Two ways to know the price level the asset was acquired at, in order:
 *
 *   1. **A stamped `acquisitionPriceLevel`** — written by the s855-45 residency
 *      step-up (`recordResidencyChange`) and by an in-sim purchase. The factor is
 *      the plain ratio `level(sale) / level(acquisition)`, exactly as for a lot.
 *   2. **A back-cast from the acquisition DATE.** An asset the plan already owned when
 *      the run began has a real acquisition date but no stamped level: the accumulator
 *      is 1.0 at sim start and knows nothing about the years before it. Compounding the
 *      CPI rate over the whole holding period recovers the missing factor.
 *
 *      This matters because design 57 Part 2 Item B taxes the WHOLE gain of an asset
 *      held across 1 July 2027 under the new regime, on the stated rationale that
 *      "cost-base indexation already relieves the inflationary part of the whole
 *      holding period". A dwelling bought in 2016 and sold in 2032 is assessed on its
 *      2016 cost base; refusing to index the pre-run decade would take the reform's
 *      penalty (no Division 115 discount, 30% floor) without the relief that is
 *      supposed to pay for it. The pre-run CPI is not observed — the model has no
 *      history — so the run's own CPI rate stands in for it, the same proxy the design
 *      already accepts for the forward series. Authors who know the real figure can set
 *      `acquisitionPriceLevel` on the asset and take branch 1 instead.
 *
 * With **neither** — no stamped level and no acquisition date — the basis is returned
 * unindexed. §6.3 sketches an alternative ("lots bootstrapped from the scenario get the
 * sim-start level (1.0)") that would index such an asset from t0, but `consumeHoldingsFifo`
 * has never done that, and making scalar assets the one family that grants relief off a
 * *missing* field would be a worse inconsistency than the one this closes. Relief follows a
 * stated acquisition, which is also what the ATO asks for. The return prints a zero
 * indexation-relief line when this bites, so it is visible rather than silent.
 *
 * The ≥12-month gate is the reform's own (ITAA97 Div 115's clock, measured from the AU
 * deemed acquisition), and indexation never ratchets the basis DOWN — it cannot create
 * or increase a capital loss.
 *
 * @param {object}      o
 * @param {number}      o.auBasis                    AU cost base before indexation
 * @param {number|null} [o.acquisitionPriceLevel]    stamped CPI level at AU acquisition
 * @param {number}      [o.currentPriceLevel=1]      CPI level now (cpiAccumulator.AU)
 * @param {number|null} [o.auAcquisitionMs]          AU (deemed) acquisition date
 * @param {number|null} [o.saleMs]                   disposal date
 * @param {number}      [o.cpiRate=0]                annual CPI rate, for the back-cast
 * @returns {number} the indexed AU cost base, never below `auBasis`
 */
export function auIndexedCostBase({ auBasis, acquisitionPriceLevel = null, currentPriceLevel = 1,
                                    auAcquisitionMs = null, saleMs = null, cpiRate = 0 }) {
  const heldMs = (auAcquisitionMs != null && saleMs != null) ? saleMs - auAcquisitionMs : null;
  // Undated ⇒ not short-term, matching `singleAssetTermFields`: every asset in this family
  // is held for years, and the alternative default would deny relief on a missing field.
  // (An undated asset with no stamped level indexes at factor 1 regardless — see above.)
  if (heldMs != null && !isLongTerm('AU', heldMs)) return auBasis;

  let factor = 1;
  if (acquisitionPriceLevel != null && acquisitionPriceLevel > 0 && currentPriceLevel > 0) {
    factor = currentPriceLevel / acquisitionPriceLevel;
  } else if (heldMs != null && heldMs > 0 && cpiRate > 0) {
    factor = (1 + cpiRate) ** (heldMs / YEAR_MS);
  }
  return auBasis * Math.max(1, factor);
}

/**
 * The AU CGT indexation rate in force, read the same way `InflationAdjustReducer`
 * reads it so the back-cast above compounds the identical series the accumulator does.
 * @param {object} state
 * @returns {number}
 */
export function auCpiRate(state) {
  return state?.cpiRates?.AU
      ?? state?.effectiveInflationRates?.AU
      ?? state?.inflationRates?.AU
      ?? 0;
}

/**
 * The AU CPI level now, reading the dedicated ATO series with the inflation
 * accumulator as fallback (design 57 Part 2 Item A). Both the stamp and the sale
 * must read the same accumulator or the ratio is meaningless.
 * @param {object} state
 * @returns {number}
 */
export function auCpiLevel(state) {
  return state?.cpiAccumulator?.AU ?? state?.inflationAccumulator?.AU ?? 1;
}
