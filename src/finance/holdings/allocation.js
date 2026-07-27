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
 * ALLOCATION — the asset category a Holding represents.
 *
 * The allocation is the AUTHORITATIVE asset-class signal for a holding. It drives
 * rateKey resolution (see default-allocations.js#resolveRateKey), the earnings
 * paths (growth / dividend / coupon / cash interest), shock revaluation, the
 * rebalance target classes and the drawdown sleeve order. The account's ROLE never
 * overrides it — a BOND sleeve inside an equity-role wrapper is a bond.
 *
 * This list is CLOSED. Every value here must be handled by every consumer above;
 * there is no catch-all bucket, because a holding that no consumer recognises is
 * silently excluded from rebalancing and drawdown rather than modelled. An
 * unrecognised allocation is a load-time error (see Holding's constructor).
 */
export const ALLOCATION = Object.freeze({
  EQUITY: 'EQUITY',
  BOND:   'BOND',
  CASH:   'CASH',
  GOLD:   'GOLD',
});

/** Tuple of every legal ALLOCATION value — useful for schema validation. */
export const ALLOCATION_VALUES = Object.freeze(Object.values(ALLOCATION));

/**
 * Allocations whose disposal is taxed as a **collectible** (design 56 §7.2):
 * GOLD is a commodity holding that carries the US 28% collectibles CGT rate (and
 * AU ordinary CGT when resident). The disposal reducer and the after-tax metric
 * branch on this set rather than a separately-stored `taxClass` field — the
 * allocation is the single, unambiguous signal (GOLD is the only collectible
 * holding today) and can never drift from a redundant tag.
 */
export const COLLECTIBLE_ALLOCATIONS = Object.freeze(new Set([ALLOCATION.GOLD]));

/** True when a holding's ALLOCATION disposes as a collectible (US 28% CGT). */
export function isCollectibleAllocation(allocation) {
  return COLLECTIBLE_ALLOCATIONS.has(allocation);
}

// ─── Target mixes (design 61 §12.2 Q3) ────────────────────────────────────────

/**
 * Tolerance on Σw = 1 for a target mix. Loose enough for hand-authored percentages and
 * for the 6-dp rounding the stick-breaking synthesizer emits; far tighter than any
 * authoring slip worth catching.
 */
export const MIX_SUM_EPSILON = 1e-4;

/**
 * A **total** target mix carries an explicit weight for EVERY allocation.
 *
 * Why totality is required (design 61 §12.2 Q3): a partial mix is indistinguishable
 * from a deliberate zero, and the difference decides whether a class is *held* or
 * *liquidated*. A glidepath baked before GOLD existed carried only EQUITY/BOND/CASH;
 * when gold was later added to the plan, every anchor silently targeted it at 0% and the
 * next rebalance sold it off, with no warning anywhere. Requiring the key to be present
 * turns that into a loud authoring error instead of a silent liquidation.
 *
 * `totalizeMix` is for **derived** mixes — a stick-breaking synthesis, a located
 * per-account composition — where backfilling 0 is the correct and intended meaning.
 * `assertTotalMix` is for **authored** input, where a missing key is a mistake.
 * Do not use totalizeMix to paper over authored input; that is the silent liquidation
 * wearing a hat.
 *
 * @param {object} mix - partial or total weight map
 * @returns {object} a new map with every ALLOCATION present (absent ⇒ 0)
 */
export function totalizeMix(mix) {
  const out = {};
  for (const alloc of ALLOCATION_VALUES) out[alloc] = mix?.[alloc] ?? 0;
  return out;
}

/** True when every allocation is present as a finite number. */
export function isTotalMix(mix) {
  if (!mix || typeof mix !== 'object') return false;
  return ALLOCATION_VALUES.every(a => Number.isFinite(Number(mix[a])));
}

/**
 * Validate an AUTHORED target mix: every allocation explicitly present, and Σw = 1.
 *
 * Throws rather than repairing. The repair used to happen — `_normalize` rescaled
 * whatever it was handed — and it hid a real authoring error: anchors written as
 * `{EQUITY: .75, BOND: .25, CASH: 0, GOLD: .25}` sum to 1.25 and were silently run as
 * `{EQUITY: .6, BOND: .2, CASH: 0, GOLD: .2}`. 75% equity authored, 60% executed, no
 * signal. So a non-unit sum is an error too, not just a missing key.
 *
 * @param {object} mix    - the authored weight map
 * @param {string} where  - human context for the message ("allocationGlidepath anchor age 53")
 * @param {object} [opts]
 * @param {number} [opts.epsilon=MIX_SUM_EPSILON]
 * @returns {object} the mix, unchanged, when valid
 */
export function assertTotalMix(mix, where, { epsilon = MIX_SUM_EPSILON } = {}) {
  if (!mix || typeof mix !== 'object' || Array.isArray(mix)) {
    throw new Error(`${where}: expected an allocation weight map, got ${mix === null ? 'null' : typeof mix}.`);
  }

  const unknown = Object.keys(mix).filter(k => !ALLOCATION_VALUES.includes(k));
  if (unknown.length) {
    throw new Error(
      `${where}: unknown allocation ${unknown.map(k => `"${k}"`).join(', ')}. ` +
      `Expected only: ${ALLOCATION_VALUES.join(', ')}.`);
  }

  const missing = ALLOCATION_VALUES.filter(a => !Number.isFinite(Number(mix[a])));
  if (missing.length) {
    throw new Error(
      `${where}: a target mix must name EVERY allocation explicitly — missing ` +
      `${missing.join(', ')}. Write the weight as 0 if you mean "hold none": an absent ` +
      `key and a deliberate 0 are indistinguishable downstream, and the difference ` +
      `decides whether that class is held or liquidated (design 61 §12.2 Q3). ` +
      `Got: ${JSON.stringify(mix)}.`);
  }

  const negative = ALLOCATION_VALUES.filter(a => Number(mix[a]) < 0);
  if (negative.length) {
    throw new Error(`${where}: negative weight for ${negative.join(', ')}. Got: ${JSON.stringify(mix)}.`);
  }

  const sum = ALLOCATION_VALUES.reduce((s, a) => s + Number(mix[a]), 0);
  if (Math.abs(sum - 1) > epsilon) {
    throw new Error(
      `${where}: weights must sum to 1, got ${sum.toFixed(6)}. They are NOT rescaled for ` +
      `you — a silent rescale turned an authored 0.75/0.25/0/0.25 into an executed ` +
      `0.6/0.2/0/0.2 (design 61 §12.2 Q3). Got: ${JSON.stringify(mix)}.`);
  }
  return mix;
}
