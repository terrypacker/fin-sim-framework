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
 * capital-gain-character.js — turn a disposal action into its §1222 short/long
 * contribution to the year's accumulators (design 90 §4).
 *
 * Every US classifier used to do one thing with a disposal: `usCapitalGainsYTD + gain`.
 * Two facts make that no longer enough — `gain` is floored at zero (so a loss vanished)
 * and it carries no character (so §1212(b)(1)(A)/(B), which carries short and long
 * forward as SEPARATE pools, could not be computed).
 *
 * ## Why this is not just "read the two new fields"
 *
 * For most disposal types `action.gain === max(0, short + long)`, and reading the signed
 * fields directly is right. **Real property is different**: its `gain` has already had
 * the §121 exclusion and the unrecaptured §1250 slice removed, while the signed fields
 * measure the raw gain from adjusted basis (they must — those two carve-outs shrink a
 * gain and neither can create a loss, so applying them to a LOSS would understate it).
 *
 * So the rule has to preserve `gain` wherever `gain` is the exclusion-aware answer, and
 * fall through to the signed figure only where there is a loss and `gain` is therefore
 * a floored zero carrying no information:
 *
 *     short + long >= 0   ⇒   { short, long: taxableGain − short }
 *     short + long <  0   ⇒   { short, long }
 *
 * The first branch is exact for both shapes. For a house (short = 0) it yields
 * `long = taxableGain`, preserving §121 and §1250 precisely. For a brokerage disposal
 * mixing a short-term loss lot with a long-term gain lot — say −15k short and +30k long,
 * `gain` = 15k — it yields `long = 15k − (−15k) = 30k`, recovering the true character
 * that the netted `gain` had collapsed. Reading `gain` as the long-term figure would
 * have mis-charactered exactly that case, and it is the case §1212(b) exists for.
 *
 * ## The absent-field contract, which is the OPPOSITE of the au* trio's
 *
 * `disposal-tax-payload-parity.test.mjs` treats a missing `auGain`/`auDiscountableGain`
 * as a bug because the consumer's `?? gain` fallback silently selects a WRONG treatment.
 * These two fields are deliberately different: absent ⇒ fall back to today's floored
 * `gain` with no character, which is exactly the pre-design-90 behaviour. That makes an
 * un-migrated emitter (or a saved action from an older run) conservative rather than
 * wrong — it forgoes a loss it might have been entitled to, and never invents one.
 *
 * @param {object} action        the disposal action
 * @param {number} taxableGain   the exclusion-aware gain the classifier books today
 * @returns {{ short: number, long: number }} signed contributions
 */
export function characterizeCapitalGain(action, taxableGain) {
  const st = action?.usShortTermGain;
  const lt = action?.usLongTermGain;
  if (st == null && lt == null) return { short: 0, long: taxableGain };
  const short = st ?? 0;
  const long  = lt ?? 0;
  return (short + long) >= 0
    ? { short, long: +(taxableGain - short).toFixed(2) }
    : { short, long };
}

/**
 * The AU sibling: the signed gain measured on the AU cost base, split by the Div 115
 * ≥12-month test. `long` is the discount-eligible slice.
 *
 * Same absent-field contract as above — no signed fields ⇒ the floored `auGain` with
 * `auDiscountableGain` deciding eligibility, i.e. exactly what the classifiers do today.
 *
 * @param {object} action
 * @param {number} auTaxableGain   the AU-assessable gain the classifier books today
 * @returns {{ short: number, long: number }} signed contributions in the action's currency
 */
export function characterizeAuCapitalGain(action, auTaxableGain) {
  const st = action?.auShortTermGain;
  const lt = action?.auLongTermGain;
  if (st == null && lt == null) {
    const discountable = action?.auDiscountableGain ?? auTaxableGain;
    return { short: +(auTaxableGain - discountable).toFixed(2), long: discountable };
  }
  const short = st ?? 0;
  const long  = lt ?? 0;
  return (short + long) >= 0
    ? { short, long: +(auTaxableGain - short).toFixed(2) }
    : { short, long };
}

/**
 * The exact signed amount `characterizeAuCapitalGain`'s caller books into
 * `auCapitalGainsYTD` — the two slices added back together.
 *
 * Derived from the split rather than restated, because it exists to be compared
 * against it: the FY2027 real bucket is a slice of this figure, and the two are booked
 * by DIFFERENT modules from the same action (design 57 §6.5). Recomputing the nominal
 * total independently is how they came apart in the first place (au-house-sale F5).
 *
 * @param {object} action
 * @param {number} auTaxableGain   the AU-assessable gain the classifier books today
 * @returns {number} the signed AU capital result, in the action's currency
 */
export function signedAuCapitalGain(action, auTaxableGain) {
  const { short, long } = characterizeAuCapitalGain(action, auTaxableGain);
  return +(short + long).toFixed(2);
}

/**
 * The FY2027 **real** (post-indexation) amount for one disposal, given the signed
 * nominal amount its classifier booked and the emitter's indexed candidate.
 *
 * Two rules, both of which the per-emitter code got wrong in opposite directions:
 *
 * 1. **ITAA97 s960-275 — indexation can neither create nor increase a capital loss.**
 *    A disposal already under water takes its un-indexed figure, SIGNED. Most emitters
 *    floor `auIndexedGain` at zero instead, which does not mean "no indexation" — it
 *    means the loss never reaches the real bucket at all. `_applyCapitalLosses` only
 *    rediscovers a current-year loss when a whole *bucket* goes negative, so a loss
 *    sitting beside a larger gain in the same bucket was silently dropped from the
 *    FY2027 assessment while reducing the nominal one (design 57 Part 6).
 *
 * 2. **The real amount is a slice of the nominal one, never more.** Indexation raises
 *    the cost base, so `real ≤ nominal` per disposal — the au-house-sale F5 invariant,
 *    enforced here at the disposal rather than left to `AuTaxRates2027._cgtRelief` to
 *    notice on a year's totals, where one asset's genuine relief can hide another's
 *    excess.
 *
 * @param {number} nominal   the signed nominal amount booked into auCapitalGainsYTD
 * @param {number|null|undefined} indexed  the emitter's `auIndexedGain`, if any
 * @returns {number} the signed amount for auRealCapitalGainsYTD
 */
export function auRealCapitalGain(nominal, indexed) {
  if (!(nominal > 0)) return nominal;              // s960-275
  return Math.min(indexed ?? nominal, nominal);
}

/**
 * Design 90 §4.5 — accumulate a capital gain into one of the §904 basket capital-gain
 * slices, returning a patch fragment to spread.
 *
 * Exists so the six disposal classifiers express this identically. They already share the
 * shape above; the slice has to be written at exactly the same places and with exactly the
 * same signed amount that reached the basket itself, or Pub 514's U.S. capital loss
 * adjustment is computed against a figure that is not the basket's capital component.
 *
 * **Writes only when non-zero**, following the `usUnrecaptured1250GainYTD` precedent the
 * classifiers already cite: creating the key at 0 puts a state diff on every gainless
 * disposal, which is both noise in the journal and a golden-fixture churn. A gainless
 * disposal contributes nothing to the adjustment, so the absent key and the zero key mean
 * the same thing to every reader (`?? 0`).
 *
 * @param {object} state   the state being read from
 * @param {string} key     `foreign{General,Passive}CapGainsYTD` or
 *                         `usSource{General,Passive}CapGainsUsdYTD`
 * @param {number} amount  the SIGNED amount that reached the basket, in the basket's currency (USD)
 * @returns {object} `{ [key]: newTotal }`, or `{}` when there is nothing to add
 */
export function basketCapGainPatch(state, key, amount) {
  return amount !== 0 ? { [key]: (state?.[key] ?? 0) + amount } : {};
}
