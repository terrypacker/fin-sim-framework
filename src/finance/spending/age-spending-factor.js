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
 * age-spending-factor.js — the pure core of the AGE_BANDED spending strategy
 * (design/33 §5.1).
 *
 * `ageSpendingFactor(age, bands)` returns a real multiplier where 1.0 means
 * "pre-retirement baseline real spending." It encodes the empirical
 * "retirement spending smile": discrete step drops between go-go / slow-go /
 * no-go phases (the per-band `multiplier`) plus a continuous within-phase glide
 * (the per-band `annualRealDrift`).
 *
 * `bands` is a sorted (ascending `startAge`) array of:
 *   { startAge, multiplier, annualRealDrift }
 * where `multiplier` is the *relative* drop entering that band and the
 * cumulative product of multipliers through band i is band i's absolute base
 * level. Ages below the first band's `startAge` return 1.0.
 */

/**
 * Locate the index of the band whose [startAge, nextStartAge) contains `age`.
 * Returns -1 when `age` is below the first band's startAge (pre-baseline).
 *
 * @param {number} age
 * @param {Array<{startAge:number}>} bands  sorted ascending by startAge
 * @returns {number}
 */
function bandIndexForAge(age, bands) {
  if (!Array.isArray(bands) || bands.length === 0) return -1;
  if (age < bands[0].startAge) return -1;
  let idx = 0;
  for (let i = 0; i < bands.length; i++) {
    if (age >= bands[i].startAge) idx = i;
    else break;
  }
  return idx;
}

/**
 * The age multiplier for the band containing `age`.
 * Returns `null` when `age` is below the first band (pre-baseline).
 *
 * @param {number} age
 * @param {Array} bands
 * @returns {number|null}
 */
export function ageBandStartAge(age, bands) {
  const idx = bandIndexForAge(age, bands);
  return idx < 0 ? null : bands[idx].startAge;
}

/**
 * Deterministic real spending multiplier as a function of age (design/33 §5.1).
 *
 * @param {number} age   whole years of age
 * @param {Array<{startAge:number, multiplier?:number, annualRealDrift?:number}>} bands
 * @returns {number}     1.0 = baseline real spending
 */
export function ageSpendingFactor(age, bands) {
  const idx = bandIndexForAge(age, bands);
  if (idx < 0) return 1.0;

  // Absolute level entering the band = product of step multipliers ≤ idx.
  let cumulative = 1.0;
  for (let i = 0; i <= idx; i++) {
    cumulative *= bands[i].multiplier ?? 1.0;
  }

  const band  = bands[idx];
  const drift = band.annualRealDrift ?? 0;
  return cumulative * Math.pow(1 + drift, age - band.startAge);
}
