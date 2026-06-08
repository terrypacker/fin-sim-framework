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
 * Deterministic recovery curve functions. Each returns a factor in [0, 1]
 * that scales the regime's adjustments. When the factor reaches 0 and the
 * regime is past its endDate, RegimeApplyReducer drops the regime from the stack.
 *
 * @param {number} t              months since shock start (may be negative before shock)
 * @param {number} durationMonths total recovery duration in months
 * @returns {number} scale factor in [0, 1]
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
});
