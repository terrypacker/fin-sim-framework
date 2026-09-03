/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { REGIME_TAG } from './regime-tag.js';

/**
 * Severity-gated regime matching (design 21 §24).
 *
 * A tag says WHICH KIND of stress is in play; `regime.severity` says HOW HARD. Keeping
 * those on separate channels is what stops the tag vocabulary from having to grow a rung
 * per intensity — and, more importantly, it is the only version that survives a Monte
 * Carlo sweep. `applySeverity` rescales a shock's level effects and drags and leaves its
 * tags untouched, so a preset that declared its own intensity as a TAG would still claim
 * to be severe after a sweep had scaled it down to a mild dip.
 *
 * `severity` is the shock's measured trough depth, stamped onto every one of its regimes
 * by `EconomicShockHandler` and already carrying the swept value by the time it gets there.
 */

/** Tags that mean "the household is reacting to a downturn", for the toggle strategies. */
export const STRESS_TAGS = Object.freeze([
  REGIME_TAG.ECONOMIC_STRESS, REGIME_TAG.PANIC_SELL_TRIGGER,
]);

/**
 * Does one regime clear a severity floor?
 *
 * An UNRATED regime (`severity` null/undefined) always clears it. That is the deliberate
 * reading: a missing severity is an absence of information, not evidence of mildness, and
 * the author who put a tag on an unrated shock made an explicit statement that a threshold
 * has no standing to overrule. It also keeps every custom/legacy shock behaving exactly as
 * it did before thresholds existed.
 *
 * @param {object}      regime
 * @param {number|null} [minSeverity] - absolute trough depth, e.g. 0.25 for a 25 % fall.
 *                                      Null/undefined disables the gate.
 */
export function regimeMeetsSeverity(regime, minSeverity) {
  if (minSeverity == null) return true;
  const s = regime?.severity;
  if (s == null) return true;
  return Math.abs(s) >= minSeverity;
}

/**
 * The active regimes a strategy should react to: tagged with any of `tags` AND at or above
 * `minSeverity`.
 *
 * @param {object[]}    activeRegimes
 * @param {object}      [opts]
 * @param {string[]}    [opts.tags=STRESS_TAGS]
 * @param {number|null} [opts.minSeverity]
 */
export function stressRegimes(activeRegimes, { tags = STRESS_TAGS, minSeverity = null } = {}) {
  return (activeRegimes ?? []).filter(r =>
    tags.some(t => r?.tags?.includes(t)) && regimeMeetsSeverity(r, minSeverity));
}

/** Convenience predicate for the two toggle strategies. */
export function isStressed(activeRegimes, opts) {
  return stressRegimes(activeRegimes, opts).length > 0;
}
