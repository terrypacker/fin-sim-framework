/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { resolveAttributionFractions } from '../../ownership-utils.js';
import { toAUD } from '../tax-fx.js';

/** The per-person map that supersedes each deferred-gain household scalar (design 76 Gap B). */
export const AU_DEFERRED_PERSON_FIELD = Object.freeze({
  auDeferredCapitalGainsYTD:      'auPersonDeferredCapitalGainsYTD',
  auDeferredDiscountableGainsYTD: 'auPersonDeferredDiscountableGainsYTD',
});

/**
 * Book a disposal's s112-160 deferred gain (design 132 §4.3) for an AU resident.
 *
 * A separate pair of buckets from `auCapitalGainsYTD` / `auRealCapitalGainsYTD`: those
 * now measure the post-1 July 2027 gain, which takes indexation and the 30% minimum tax,
 * while the deferred gain takes the 50% discount and neither of the other two (s102-6(5),
 * s115-100(aa), s119-5(2)). Created on first use, so a plan with no lot held across the
 * date never grows the keys.
 *
 * @param {object} state         state before the action (attribution source)
 * @param {object} next          state accumulated so far by the classifier
 * @param {object} action        the disposal action
 * @param {string|null} canonicalKey  fallback account key for attribution
 * @param {string} ccy           the action's money currency
 * @returns {object} next, with the deferred buckets advanced (unchanged when none)
 */
export function bookAuDeferredGain(state, next, action, canonicalKey, ccy) {
  if (action?.auDeferredGain == null) return next;
  const gain = toAUD(action.auDeferredGain, ccy, state);
  const disc = toAUD(action.auDeferredDiscountableGain ?? 0, ccy, state);
  const fractions = resolveAttributionFractions(state, action, canonicalKey);
  if (fractions == null) {
    return {
      ...next,
      auDeferredCapitalGainsYTD:      (next.auDeferredCapitalGainsYTD      ?? 0) + gain,
      auDeferredDiscountableGainsYTD: (next.auDeferredDiscountableGainsYTD ?? 0) + disc,
    };
  }
  const spread = (map, amount) => {
    const out = { ...(map ?? {}) };
    for (const { personKey, fraction } of fractions) out[personKey] = (out[personKey] ?? 0) + amount * fraction;
    return out;
  };
  return {
    ...next,
    auPersonDeferredCapitalGainsYTD:      spread(next.auPersonDeferredCapitalGainsYTD, gain),
    auPersonDeferredDiscountableGainsYTD: spread(next.auPersonDeferredDiscountableGainsYTD, disc),
  };
}
