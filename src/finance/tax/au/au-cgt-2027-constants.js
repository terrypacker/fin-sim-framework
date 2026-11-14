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
 * Leaf constants for the 1 July 2027 deemed sale (design 132). A separate module because
 * `holdings-fifo.js` reads them and sits beneath nearly everything; importing the reducer
 * module from there would pull the reducer framework into the holdings layer.
 */

/** 1 July 2027 00:00 UTC — the first instant of the FY2027 regime (s112-155(2)). */
export const AU_DEEMED_SALE_MS = Date.UTC(2027, 6, 1);

/** The `costBaseByCountry` key holding a stamped lot's AU cost base before the deemed sale. */
export const AU_PRE2027_KEY = 'AU_PRE2027';

/**
 * The deferred-gain fields a disposal action carries (design 132 §4.3), read from a
 * `consumeHoldings` result. Empty unless a lot stamped by the deemed sale was consumed, so
 * every other disposal's payload is unchanged. Amounts are in the drawn account's currency.
 *
 * @param {object}  fifo                   a `consumeHoldings` result
 * @param {{collectible?: boolean}} [opts] the gold slice reads its own tally
 * @returns {{auDeferredGain?: number, auDeferredDiscountableGain?: number}}
 */
export function deferredGainFields(fifo, { collectible = false } = {}) {
  const t = (collectible ? fifo?.collectibleDeferredGainByCountry : fifo?.deferredGainByCountry)?.AU;
  if (t == null || (t.gain === 0 && t.discountable === 0)) return {};
  return { auDeferredGain: t.gain, auDeferredDiscountableGain: t.discountable };
}
