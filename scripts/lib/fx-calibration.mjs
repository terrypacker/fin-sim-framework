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
 * fx-calibration.mjs — estimate the FX process parameters from a monthly rate series
 * (design 92 §8.1).
 *
 * Pure functions over arrays, deliberately independent of the packaged series, so the
 * estimator can be pointed at a SYNTHETIC path with known σ and k and checked for
 * recovery. An estimator only ever run against real data is an estimator nobody has
 * verified — it will return a number for any input and the number will look reasonable.
 *
 *   σ̂  = sd( monthly log returns ) × √12          → fxVolatility
 *   k̂  = −12 · ln( ρ̂₁ )                            → fxReversionSpeed
 *          from an AR(1) fit of the log level about its window mean
 *   μ̂  = mean( monthly log returns ) × 12          → REPORTED, never applied
 *
 * μ̂ is report-only by design. Drift belongs in the anchor (`exchangeRateUsdToAud`) and
 * the regime FX lever where it is visible and authored; folding a window's realised
 * drift into a "volatility" calibration smuggles a currency view in under a statistical
 * label (design 92 §5).
 */

/** December 1983 float; the first full month of a freely floating AUD is 1984-01. */
export const POST_FLOAT_MONTH = '1984-01';

/**
 * Minimum months for an AR(1) fit. Below this the reversion estimate is describing
 * sampling noise, and printing it would be a confident-looking number computed from
 * nothing.
 */
export const MIN_MONTHS = 36;

/**
 * Estimate the process parameters from a monthly level series.
 *
 * The AR(1) is fitted on the log LEVEL about its window mean — the same object the
 * engine's `fxDeviation` is: a mean-0 log deviation from an anchor. Fitting the returns
 * instead would estimate the autocorrelation of increments, a different quantity, and
 * not what `MEAN_REVERTING`'s k parameterises.
 *
 * @param {number[]} levels  monthly rate levels, contiguous and in order
 * @returns {{ months: number, sigmaAnnual: number, driftAnnual: number, rho1: number,
 *             reversionSpeed: number|null, halfLifeYears: number|null }}
 */
export function estimateFxProcess(levels) {
  if (!Array.isArray(levels) || levels.length < MIN_MONTHS) {
    throw new Error(
      `Need at least ${MIN_MONTHS} monthly observations for an AR(1) fit, got `
      + `${Array.isArray(levels) ? levels.length : 'none'}.`,
    );
  }
  if (levels.some((v) => !Number.isFinite(v) || v <= 0)) {
    throw new Error('All levels must be finite and positive (log space).');
  }

  const logs    = levels.map(Math.log);
  const returns = logs.slice(1).map((v, i) => v - logs[i]);

  const meanR = returns.reduce((a, b) => a + b, 0) / returns.length;
  const varR  = returns.reduce((a, b) => a + (b - meanR) ** 2, 0) / (returns.length - 1);
  const sdR   = Math.sqrt(varR);

  const meanL = logs.reduce((a, b) => a + b, 0) / logs.length;
  const dev   = logs.map((v) => v - meanL);
  let num = 0;
  let den = 0;
  for (let i = 1; i < dev.length; i++) num += dev[i] * dev[i - 1];
  for (let i = 0; i < dev.length - 1; i++) den += dev[i] * dev[i];
  const rho = den > 0 ? num / den : 0;

  // ρ̂ outside (0,1) means the fit found no mean reversion at all — a random walk or
  // worse. k is then undefined rather than large, and reporting a number would be a lie.
  const k        = rho > 0 && rho < 1 ? -12 * Math.log(rho) : null;
  const halfLife = k != null && k > 0 ? Math.log(2) / k : null;

  return {
    months:         levels.length,
    sigmaAnnual:    sdR * Math.sqrt(12),
    driftAnnual:    meanR * 12,
    rho1:           rho,
    reversionSpeed: k,
    halfLifeYears:  halfLife,
  };
}

/**
 * Estimate over a window of a packaged series object (the shape emitted by
 * `scripts/dev/build-fx-series.mjs`).
 *
 * @param {{ months: string[], audPerUsd: number[], firstMonth: string, lastMonth: string }} series
 * @param {string|null} from  inclusive first month 'YYYY-MM', or null for the series start
 * @param {string|null} to    inclusive last month, or null for the series end
 */
export function calibrateWindow(series, from = null, to = null) {
  const lo = from ?? series.firstMonth;
  const hi = to   ?? series.lastMonth;

  const months = [];
  const levels = [];
  for (let i = 0; i < series.months.length; i++) {
    const m = series.months[i];
    if (m < lo || m > hi) continue;
    months.push(m);
    levels.push(series.audPerUsd[i]);
  }

  if (levels.length < MIN_MONTHS) {
    throw new Error(
      `Window ${lo}..${hi} has ${levels.length} months; at least ${MIN_MONTHS} are needed `
      + `for an AR(1) fit. Series covers ${series.firstMonth}..${series.lastMonth}.`,
    );
  }

  return {
    from: months[0],
    to:   months[months.length - 1],
    ...estimateFxProcess(levels),
  };
}
