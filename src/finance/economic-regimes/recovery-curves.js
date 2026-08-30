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
 * Deterministic recovery curve functions. Each returns a factor that scales the regime's
 * adjustments — in [0, 1] for the four original profiles, and possibly NEGATIVE for the
 * *_REBOUND pair. When the factor reaches 0 and the regime is past its endDate,
 * RegimeApplyReducer drops the regime from the stack.
 *
 * @param {number} t              months since shock start (may be negative before shock)
 * @param {number} durationMonths total recovery duration in months
 * @param {object} [regime]       the regime being scaled; the rebound profiles read
 *                                `reboundStart` and `reboundPeak` off it. The four
 *                                original curves ignore it.
 * @returns {number} scale factor. [0, 1] for the four original profiles; the *_REBOUND
 *                   profiles also return NEGATIVE values, which flip the regime's
 *                   adjustments into a tailwind (design 21 §22).
 */
export const RecoveryCurves = Object.freeze({
  /**
   * V-shape: linear fade from 1 → 0 over durationMonths.
   */
  V: (t, durationMonths) => {
    if (t < 0)               return 1;
    if (t >= durationMonths) return 0;
    return 1 - t / durationMonths;
  },

  /**
   * U-shape: flat at 1 for the first half, then linear fade.
   */
  U: (t, durationMonths) => {
    if (t < 0)               return 1;
    const stagnation = durationMonths * 0.5;
    if (t < stagnation)      return 1;
    if (t >= durationMonths) return 0;
    return 1 - (t - stagnation) / (durationMonths - stagnation);
  },

  /**
   * W-shape: damped cosine producing a double-dip pattern.
   */
  W: (t, durationMonths) => {
    if (t < 0)               return 1;
    if (t >= durationMonths) return 0;
    const phase = (t / durationMonths) * 2 * Math.PI;
    return Math.max(0, (1 + Math.cos(phase)) / 2);
  },

  /**
   * L-shape: factor stays at 1 throughout, then snaps to 0 at durationMonths.
   * Models a permanent structural shift with no recovery.
   */
  L: (t, durationMonths) => {
    if (t < 0)               return 1;
    if (t >= durationMonths) return 0;
    return 1;
  },

  /**
   * V with a rebound. Linear fade 1 → 0 over the first `reboundStart` of the window,
   * then a half-sine EXCURSION BELOW ZERO to −`reboundPeak` and back to 0 at the end.
   *
   * The negative stretch is the point. Every other profile can only fade a drag toward
   * zero, so the best a shock can do is hand back the baseline — and real recoveries did
   * not creep back at baseline, they ran well above it (the S&P regained its 2007 peak in
   * 65 months while compounding at 7 % needs ~140). A negative factor multiplies the
   * regime's NEGATIVE returnAdjustment into a POSITIVE one, which is the only way this
   * framework can express an above-baseline recovery. See design 21 §22.
   */
  V_REBOUND: (t, durationMonths, regime) => _rebound(t, durationMonths, regime, 'V'),

  /**
   * U with a rebound: flat at full strength for the first half of the decline phase,
   * fade to zero, then the same below-zero excursion. The shape for an episode that
   * ground down before it snapped back.
   */
  U_REBOUND: (t, durationMonths, regime) => _rebound(t, durationMonths, regime, 'U'),
});

/**
 * Shared body of the rebound profiles.
 *
 * `reboundStart` (default 0.5) is the FRACTION of `durationMonths` at which the factor
 * reaches zero — i.e. where the drag is spent and the tailwind begins. `reboundPeak`
 * (default 0.5) is how far below zero the factor goes at the midpoint of what remains,
 * as a fraction of the original adjustment: 0.5 against a −20 pp drag is a +10 pp tailwind
 * at its peak.
 *
 * Both are read off the regime so a preset can tune them per leg without a new profile
 * per shape. Absent, the defaults give a symmetric fade-then-rebound.
 */
function _rebound(t, durationMonths, regime, declineShape) {
  if (t < 0)               return 1;
  if (t >= durationMonths) return 0;

  const startFrac = _clamp(regime?.reboundStart ?? 0.5, 0.05, 0.95);
  const peak      = Math.max(0, regime?.reboundPeak ?? 0.5);
  const declineMonths = durationMonths * startFrac;

  if (t < declineMonths) {
    if (declineShape === 'U') {
      const stagnation = declineMonths * 0.5;
      if (t < stagnation) return 1;
      return 1 - (t - stagnation) / (declineMonths - stagnation);
    }
    return 1 - t / declineMonths;
  }

  // Rebound phase: 0 → −peak → 0, smooth at both ends so the tailwind has no step change.
  const span = durationMonths - declineMonths;
  return -peak * Math.sin(Math.PI * (t - declineMonths) / span);
}

const _clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
