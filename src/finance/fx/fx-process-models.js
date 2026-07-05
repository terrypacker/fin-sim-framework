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
 * Time-varying FX process models (design 47 §3.1).
 *
 * Each model is a pure step function that advances a mean-0 log-space
 * "deviation" one tick. The effective rate is composed elsewhere as
 * `anchor × exp(deviation)`, so a deviation of 0 leaves the rate at its
 * anchor (base + regime drift).
 *
 * Step signature: `step(prev, { sigma, dt, k, z }) → next`
 *   - prev   : previous deviation (log-space, mean 0)
 *   - sigma  : effective per-tick volatility (annualized; scaled by √dt here)
 *   - dt     : tick interval in years (e.g. 1/12 for monthly)
 *   - k      : mean-reversion speed per year (MEAN_REVERTING only)
 *   - z      : standard-normal draw (see gaussianFrom)
 *
 * The randomness enters only through `z`; the caller draws it from the
 * simulation's seeded, snapshot-safe RNG (design 47 §4).
 */
export const FX_PROCESS_MODELS = {
  /** Flat: no deviation. Rate stays at the anchor (bit-for-bit today). */
  NONE: () => 0,

  /** Memoryless jitter around the anchor (no autocorrelation). */
  WHITE_NOISE: (_prev, { sigma, dt, z }) => sigma * Math.sqrt(dt) * z,

  /** Log-random-walk: accumulates, no pull back toward the anchor. */
  RANDOM_WALK: (prev, { sigma, dt, z }) => prev + sigma * Math.sqrt(dt) * z,

  /**
   * Ornstein-Uhlenbeck: wanders but is pulled back toward 0 (the anchor)
   * with reversion speed k. Bounded over long horizons.
   */
  MEAN_REVERTING: (prev, { sigma, dt, k, z }) =>
    prev * Math.exp(-k * dt) + sigma * Math.sqrt(dt) * z,
};

/** Valid model ids, for param-schema options and validation. */
export const FX_PROCESS_MODEL_IDS = Object.keys(FX_PROCESS_MODELS);

/**
 * Draw a standard-normal (mean 0, sd 1) value from a uniform [0,1) RNG using
 * the Box-Muller transform. Consumes two uniforms per draw — identical to
 * NormalDistribution.sample() so the FX handler and MC sampling share one
 * construction.
 *
 * @param {() => number} rng  zero-arg uniform [0,1) generator (e.g. sim.rng)
 * @returns {number}
 */
export function gaussianFrom(rng) {
  const u1 = Math.max(rng(), 1e-10);
  const u2 = rng();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}
