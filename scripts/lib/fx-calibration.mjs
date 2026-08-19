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
 * Analytic sd of an OU process's change over `h` YEARS, started from its stationary
 * distribution: `σ/√(2k) · √(2(1−e^{−kh}))`.
 *
 * Checked against the engine's own `FX_PROCESS_MODELS.MEAN_REVERTING` step function
 * (they agree within 3% at horizons 1–44y), so fitting against this formula is fitting
 * against what the simulation will actually do.
 */
export function ouChangeSd(sigmaAnnual, k, h) {
  if (!(k > 0)) return sigmaAnnual * Math.sqrt(h);   // k → 0 is the random walk
  return (sigmaAnnual / Math.sqrt(2 * k)) * Math.sqrt(2 * (1 - Math.exp(-k * h)));
}

/**
 * Observed sd of log level changes at each horizon in `horizonsYears`, from overlapping
 * windows.
 *
 * @param {number[]} levels  monthly rate levels
 * @param {number[]} horizonsYears
 */
export function empiricalTermStructure(levels, horizonsYears) {
  const logs = levels.map(Math.log);
  return horizonsYears.map((h) => {
    const m = h * 12;
    const ch = [];
    for (let i = 0; i + m < logs.length; i++) ch.push(logs[i + m] - logs[i]);
    const mean = ch.reduce((a, b) => a + b, 0) / ch.length;
    const v = ch.reduce((a, b) => a + (b - mean) ** 2, 0) / (ch.length - 1);
    return Math.sqrt(v);
  });
}

/**
 * Horizons a window can actually speak to: those with at least `minIndependent`
 * NON-OVERLAPPING windows.
 *
 * This filter is not fussiness, it is the difference between two opposite conclusions.
 * The post-float window's 20-year dispersion is computed from ~2 independent
 * observations and comes out *lower* than its 10-year figure — which cannot happen in
 * any diffusion. Fitting against that point says the shipped k is fine; dropping it says
 * the shipped k over-reverts by a factor of three. Overlapping windows make a
 * meaningless number look like 271 data points.
 */
export function estimableHorizons(months, candidates = [1, 2, 3, 5, 7, 10, 15, 20], minIndependent = 4) {
  return candidates.filter((h) => Math.floor(months / (h * 12)) >= minIndependent);
}

/**
 * Fit (σ, k) so the OU reproduces the OBSERVED TERM STRUCTURE of dispersion, rather than
 * the lag-1 autocorrelation.
 *
 * ─── why this and not the AR(1) estimator below ─────────────────────────────────────
 *
 * `estimateFxProcess`'s `k̂ = −12·ln(ρ̂₁)` is the maximum-likelihood estimator *if the
 * series really is an OU*. FX is not, and under that misspecification the lag-1
 * statistic is the worst available choice for this purpose: it is the one most sensitive
 * to month-to-month noise and least informative about the multi-year behaviour a
 * long-horizon projection exists to model. On the post-float window it returns k=0.296
 * (half-life 2.3y) while the dispersion actually observed at 5–10 years implies k≈0.11
 * (half-life ~6y) — the shipped value over-reverts, and understates 44-year FX
 * dispersion by roughly 40%.
 *
 * When a model is known to be misspecified, fit it to the moments you intend to use. For
 * a retirement projection those are the multi-year ones, which is exactly what this
 * targets. The standard variance-ratio statistic agrees: at 10 years the post-float
 * history gives 0.650, this fit gives 0.634, and the AR(1) fit gives 0.370.
 *
 * @param {number[]} levels
 * @param {{ horizonsYears?: number[], minIndependent?: number }} [opts]
 */
export function fitFxTermStructure(levels, { horizonsYears = null, minIndependent = 4 } = {}) {
  if (!Array.isArray(levels) || levels.length < MIN_MONTHS) {
    throw new Error(
      `Need at least ${MIN_MONTHS} monthly observations to fit a term structure, got `
      + `${Array.isArray(levels) ? levels.length : 'none'}.`,
    );
  }
  const H = horizonsYears ?? estimableHorizons(levels.length, undefined, minIndependent);
  if (H.length < 3) {
    throw new Error(
      `Only ${H.length} horizon(s) have ${minIndependent}+ independent windows in a `
      + `${levels.length}-month series; a term-structure fit needs at least 3.`,
    );
  }
  const target = empiricalTermStructure(levels, H);

  // Squared error in LOG ratio, so every horizon counts equally rather than the longest
  // (largest sd) dominating a plain least-squares.
  const loss = (s, k) => Math.sqrt(
    H.reduce((a, h, i) => a + Math.log(ouChangeSd(s, k, h) / target[i]) ** 2, 0) / H.length,
  );

  // Coarse grid then refine. The surface is smooth and two-dimensional; this is cheaper
  // to read and to trust than pulling in an optimiser.
  let best = { s: 0.11, k: 0.15, e: Infinity };
  const scan = (s0, s1, ds, k0, k1, dk) => {
    for (let s = s0; s <= s1; s += ds) {
      for (let k = k0; k <= k1; k += dk) {
        const e = loss(s, k);
        if (e < best.e) best = { s, k, e };
      }
    }
  };
  scan(0.04, 0.30, 0.002, 0.01, 0.80, 0.005);
  scan(Math.max(0.01, best.s - 0.004), best.s + 0.004, 0.0002,
       Math.max(0.005, best.k - 0.01), best.k + 0.01, 0.0005);

  return {
    sigmaAnnual:    best.s,
    reversionSpeed: best.k,
    halfLifeYears:  Math.log(2) / best.k,
    rmse:           best.e,
    horizonsYears:  H,
    empirical:      target,
    fitted:         H.map((h) => ouChangeSd(best.s, best.k, h)),
  };
}

/**
 * Estimate the process parameters from a monthly level series.
 *
 * NOTE: `reversionSpeed` here is the LAG-1 AR(1) estimate, which is *not* what the
 * shipped default uses any more — see `fitFxTermStructure` for why it is the wrong
 * target for a long-horizon projection. This is kept because σ̂ and μ̂ are unaffected by
 * that argument and because the comparison between the two k estimates is itself
 * informative.
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

  const ar1 = estimateFxProcess(levels);
  let term = null;
  try {
    term = fitFxTermStructure(levels);
  } catch {
    // A window too short for a term-structure fit still yields a usable σ̂ and μ̂; the
    // caller reports the k as unavailable rather than silently falling back to the AR(1)
    // value, which is the one this exists to replace.
  }

  return {
    from: months[0],
    to:   months[months.length - 1],
    ...ar1,
    /** Lag-1 AR(1) k, kept for comparison. NOT the shipped default. */
    ar1ReversionSpeed: ar1.reversionSpeed,
    ar1HalfLifeYears:  ar1.halfLifeYears,
    /** The term-structure fit — what `fxVolatility` / `fxReversionSpeed` ship from. */
    term,
    // Promote the term-structure estimates to the primary fields, so a caller that just
    // reads `sigmaAnnual` / `reversionSpeed` gets the ones we actually stand behind.
    ...(term ? {
      sigmaAnnual:    term.sigmaAnnual,
      reversionSpeed: term.reversionSpeed,
      halfLifeYears:  term.halfLifeYears,
    } : {}),
  };
}
