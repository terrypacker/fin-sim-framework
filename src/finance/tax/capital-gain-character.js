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
