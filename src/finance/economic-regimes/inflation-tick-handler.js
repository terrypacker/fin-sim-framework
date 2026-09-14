/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { HandlerEntry }     from '../../simulation-framework/handlers.js';
import { gaussianFrom }     from '../fx/fx-process-models.js';
import { HISTORICAL_MACRO } from './historical-macro.js';

const COUNTRIES = ['US', 'AU'];

/** The inflation processes (design 103 §4.1, §5.1). */
export const INFLATION_MODEL_IDS = ['GAUSSIAN', 'HISTORICAL_JOINT'];

/** Dropdown labels for `inflationModel` (see design 102 §3 for `optionLabels`). */
export const INFLATION_MODEL_LABELS = Object.freeze({
  GAUSSIAN:         'Gaussian — persistent, US and AU correlated (default)',
  HISTORICAL_JOINT: 'Historical, joint with equity — the same post-war year as the equity bootstrap',
});

/**
 * The standard normal quantile (Acklam's rational approximation, relative error < 1.2e-9).
 * Used once at load, to normal-score the historical residuals.
 */
function inverseNormalCdf(p) {
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const tail = (q) => (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  if (p < 0.02425)     return  tail(Math.sqrt(-2 * Math.log(p)));
  if (p > 1 - 0.02425) return -tail(Math.sqrt(-2 * Math.log(1 - p)));
  const q = p - 0.5, r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

/**
 * The post-war joint window, 1951 onward (design 103 §2): each country's AR(1) fit to its
 * annual inflation, the fit's residuals, and the US 10-year yield changes, all indexed by
 * `year − firstYear`. Pre-1951 inflation is left out on purpose. Under the gold standard it
 * averaged −0.3% with no persistence, which isn't the monetary world a plan retires into.
 *
 *   - `residuals` / `sd` — (x_t − μ) − φ·(x_{t−1} − μ), re-centred to mean 0, and their sd.
 *   - `normalScores` — each residual replaced by the standard normal quantile of its rank
 *     (then scaled to sd 1). These are joint mode's surprises (§10.4): they keep WHICH years
 *     were surprises, how big by rank, and their same-year US–AU link, but drop history's
 *     fat, skewed tails. The skew map adds the skew back the same way as in GAUSSIAN mode,
 *     so it isn't applied twice.
 *   - `residualCorr` / `normalScoreCorr` — the US–AU correlation of the standardized
 *     residuals (≈ 0.26) and of the normal scores (≈ 0.23).
 *   - `gs10.shocks` / `gs10.sd` — the yield changes re-centred, for the yield-curve OU.
 */
export const HISTORICAL_JOINT_WINDOW = (() => {
  const mean = (x) => x.reduce((s, v) => s + v, 0) / x.length;
  const sdev = (x) => { const m = mean(x); return Math.sqrt(x.reduce((s, v) => s + (v - m) ** 2, 0) / (x.length - 1)); };
  const corr = (x, y) => { const mx = mean(x), my = mean(y); let s = 0, sx = 0, sy = 0; x.forEach((v, i) => { s += (v - mx) * (y[i] - my); sx += (v - mx) ** 2; sy += (y[i] - my) ** 2; }); return s / Math.sqrt(sx * sy); };
  const normalScore = (x) => {
    const order = x.map((_, i) => i).sort((i, j) => x[i] - x[j]);
    const out = new Array(x.length);
    order.forEach((i, rank) => { out[i] = inverseNormalCdf((rank + 0.5) / x.length); });
    const s = sdev(out);
    return Object.freeze(out.map(v => v / s));
  };
  const fit  = (x) => {
    const mu = mean(x.slice(1));
    let num = 0, den = 0;
    for (let i = 1; i < x.length; i++) { num += (x[i - 1] - mu) * (x[i] - mu); den += (x[i - 1] - mu) ** 2; }
    const phi = num / den;
    const raw = x.slice(1).map((v, i) => (v - mu) - phi * (x[i] - mu));
    const m   = mean(raw);
    const residuals = Object.freeze(raw.map(e => e - m));
    return Object.freeze({ mean: mu, phi, residuals, sd: sdev(residuals), normalScores: normalScore(residuals) });
  };
  const US = fit(HISTORICAL_MACRO.usInflation);
  const AU = fit(HISTORICAL_MACRO.auInflation);
  const gsWindow = HISTORICAL_MACRO.gs10Change.slice(1);
  const gsMean   = mean(gsWindow);
  const shocks   = Object.freeze(gsWindow.map(v => v - gsMean));
  return Object.freeze({
    firstYear:       HISTORICAL_MACRO.firstYear + 1,
    length:          gsWindow.length,
    US,
    AU,
    residualCorr:    corr(US.residuals, AU.residuals),
    normalScoreCorr: corr(US.normalScores, AU.normalScores),
    gs10:            Object.freeze({ shocks, sd: sdev(shocks) }),
  });
})();

/**
 * Whether a run's params put inflation in joint mode (design 103 §5.1): the inflation path
 * is on with HISTORICAL_JOINT, AND the equity path is on with the historical bootstrap
 * whose cursor joint mode reads. Anything else runs the inflation path as GAUSSIAN. One
 * rule, shared by the toolset's schedule and handler wiring so the two can't disagree.
 *
 * @param {object} p  the scenario's parameters
 * @returns {boolean}
 */
export function jointInflationActive(p) {
  return !!p?.inflationStochastic && p.inflationModel === 'HISTORICAL_JOINT'
    && !!p.equityReturnStochastic && p.equityReturnModel === 'HISTORICAL_BOOTSTRAP';
}

/** The joint window's index for a calendar year, or -1 when the year is outside it. */
export function jointWindowIndex(year) {
  const i = year - HISTORICAL_JOINT_WINDOW.firstYear;
  return Number.isInteger(i) && i >= 0 && i < HISTORICAL_JOINT_WINDOW.length ? i : -1;
}

/**
 * Map a standardized latent y (stationary mean 0, sd 1) to an inflation deviation from the
 * anchor, in rate units (design 103 §10.1). Inflation is modelled as a lower bound F plus a
 * lognormal distance above it:
 *
 *     inflation = F + (A − F)·exp(s·y − s²/2),   s = √ln(1 + (σ / (A − F))²)
 *
 * So the average stays at the anchor A, the stationary sd is σ, spikes run up while dips
 * flatten out as they near F, and the swings scale with how far inflation sits above F.
 * An anchor at or below the bound leaves no room to move, so the deviation is 0.
 *
 * @returns {number} inflation − A
 */
export function skewedInflationDeviation(y, { anchor, bound, vol }) {
  const span = anchor - bound;
  if (!(span > 0) || !(vol > 0)) return 0;
  const s = Math.sqrt(Math.log(1 + (vol / span) ** 2));
  return span * (Math.exp(s * y - s * s / 2) - 1);
}

/**
 * The sd of `√w·g + √(1−w)·x` in joint mode (design 103 §10.4), where the global factor's
 * surprise is the normalized average of the two countries' surprises. It therefore
 * correlates at λ = √((1 + r)/2) with each country's own surprise, so the two parts don't
 * split the variance as they do in GAUSSIAN mode (where they are independent):
 *
 *     Var = 1 + 2·√(w(1−w))·λ·√(1−a_g²)·√(1−a²) / (1 − a_g·a)
 *
 * Dividing by this puts the latent back at sd 1, so σ keeps its meaning in joint mode too.
 */
function jointLatentSd(w, ag, a) {
  const lambda = Math.sqrt((1 + HISTORICAL_JOINT_WINDOW.normalScoreCorr) / 2);
  return Math.sqrt(1 + 2 * Math.sqrt(w * (1 - w)) * lambda * Math.sqrt(1 - ag * ag) * Math.sqrt(1 - a * a) / (1 - ag * a));
}

/**
 * InflationTickHandler — the stochastic inflation path (design 103 §4, revised §10).
 * Another seeded, snapshot-safe in-loop consumer, gated like the others: it's only
 * *scheduled* when `inflationStochastic` is on, so default runs draw nothing and stay
 * byte-identical.
 *
 * Fires on the annual INFLATION_TICK, AFTER the equity tick on the same year-end (order 2).
 * Each country's inflation is driven by a standardized latent that combines a slow GLOBAL
 * factor g, shared by both countries, with the country's own factor x:
 *
 *     g_t     = a_g·g_{t−1}  + √(1 − a_g²)·ε_g        a_g = e^(−k_global)
 *     x_t[cc] = a·x_{t−1}[cc] + √(1 − a²)·ε[cc]       a   = e^(−k[cc])
 *     y[cc]   = √w·g + √(1 − w)·x[cc]                 w   = the global share
 *
 * Both are OUs on a LEVEL, so they mean-revert. (The equity misuse, design 102 §2, was an
 * OU on a return.) The slow shared factor is what makes the two countries' inflation move
 * together over decades (history's 0.59 level correlation), while their yearly surprises
 * stay only loosely linked (§10.2). `y` then maps through `skewedInflationDeviation`, so
 * inflation rarely dips below 0 and σ is the stationary sd at the anchor.
 *
 *   - GAUSSIAN: ε[US], ε[AU] from two standard normals correlated at ρ, then ε_g from a
 *     third, drawn only when w > 0: 4 or 6 uniforms a year, independent of the path.
 *   - HISTORICAL_JOINT (§10.4): ε[US] and ε[AU] are the normal-scored post-war residuals of
 *     the historical YEAR the equity bootstrap just replayed (`state.equityReturnBootstrap
 *     .year`), and ε_g is their normalized average, so the whole step is that year's and
 *     draws nothing. Its share is `globalShareJoint` (0.2), because a global surprise built
 *     from the countries' own already moves with each of them. The latent is divided by
 *     `jointLatentSd` to keep it at sd 1. No cursor, or a year outside 1951–, falls back to
 *     Gaussian surprises for that year (with the joint share and scaling).
 *
 * The factors live in `state.inflationLatent` and the resulting deviation from the anchor
 * in `state.inflationDev` (rate units, which the fold, the prime link and the equity
 * pass-through read). With `passThrough` set (joint mode), EquityReturnReducer adds each
 * market's local inflation deviation to its NOMINAL return (design 103 §5.2).
 *
 * **The prime-rate link (design 104).** With `prime` set (Prime Rate Mode "follows
 * inflation"), the same tick also walks each country's policy-rate deviation toward β times
 * its inflation deviation, closing (1 − ρ) of the gap a year:
 *
 *     primeDev_t[cc] = ρ·primeDev_{t−1}[cc] + (1 − ρ)·β·inflationDev_t[cc]  (+ noise·z)
 *
 * The optional noise, off by default, is drawn only when it is above 0, after the inflation
 * draws. The step carries `primeDeviation` and `primeFloor`; InflationPathReducer folds them.
 */
export class InflationTickHandler extends HandlerEntry {
  static description = 'Walks a shared global inflation factor and each country\'s own factor one mean-reverting step per year (Gaussian, or joint with the equity bootstrap\'s historical year), maps them through a skewed, level-scaled distribution, and optionally moves the prime rate in response (design 104). Emits INFLATION_STEP_APPLY (design 103 §4–5, §10).';
  static type        = 'InflationTickHandler';
  static eventType   = 'INFLATION_TICK';

  constructor({ vol = { US: 0.028, AU: 0.03 }, reversionSpeed = { US: 0.33, AU: 0.33 }, correlation = 0.35,
                globalShare = 0.4, globalShareJoint = 0.2, globalReversionSpeed = 0.1, lowerBound = { US: -0.01, AU: -0.01 },
                model = 'GAUSSIAN', floor = -0.05, passThrough = false, prime = null, dt = 1 } = {}) {
    super(null, 'Inflation Tick');
    this.vol                  = vol;                   // per-country STATIONARY sd of inflation, at its anchor
    this.reversionSpeed       = reversionSpeed;        // per-country OU pull-back speed k of its own factor
    this.correlation          = correlation;           // US–AU correlation of the own-factor surprises (GAUSSIAN only)
    this.globalShare          = globalShare;           // w in GAUSSIAN mode: the global factor's share of each latent
    this.globalShareJoint     = globalShareJoint;      // w in HISTORICAL_JOINT mode (§10.4)
    this.globalReversionSpeed = globalReversionSpeed;  // k of the slow global factor, per year
    this.lowerBound           = lowerBound;            // per-country F: inflation approaches it but never crosses it
    this.model                = model;                 // one of INFLATION_MODEL_IDS
    this.floor                = floor;                 // a hard clamp the fold applies on top (regimes included)
    this.passThrough          = passThrough;           // add the deviation to nominal equity (joint mode)
    this.prime                = prime;                 // design 104 link: { beta, rho, noise, floor } per country, or null
    this.dt                   = dt;                    // tick interval in years (annual)
    this.generatedActionTypes = ['INFLATION_STEP_APPLY'];
  }

  static fromJSON(d) {
    const h = new this({
      vol: d.vol, reversionSpeed: d.reversionSpeed, correlation: d.correlation,
      globalShare: d.globalShare, globalShareJoint: d.globalShareJoint, globalReversionSpeed: d.globalReversionSpeed,
      lowerBound: d.lowerBound, model: d.model, floor: d.floor, passThrough: d.passThrough, prime: d.prime ?? null, dt: d.dt,
    });
    h.id = d.id;
    return h;
  }

  toJSON() {
    return {
      ...super.toJSON(),
      vol: this.vol, reversionSpeed: this.reversionSpeed, correlation: this.correlation,
      globalShare: this.globalShare, globalShareJoint: this.globalShareJoint, globalReversionSpeed: this.globalReversionSpeed,
      lowerBound: this.lowerBound, model: this.model, floor: this.floor, passThrough: this.passThrough, prime: this.prime, dt: this.dt,
    };
  }

  call({ sim, state }) {
    const joint = this.model === 'HISTORICAL_JOINT';
    const w     = Math.min(1, Math.max(0, (joint ? this.globalShareJoint : this.globalShare) ?? 0));
    const year  = joint ? state.equityReturnBootstrap?.year : null;
    const idx   = year != null ? jointWindowIndex(year) : -1;

    // Standardized (unit-variance) surprises for each country's own factor and the global one.
    const e = {};
    let eg;
    if (idx >= 0) {
      const W = HISTORICAL_JOINT_WINDOW;
      e.US = W.US.normalScores[idx];
      e.AU = W.AU.normalScores[idx];
      eg   = (e.US + e.AU) / Math.sqrt(2 + 2 * W.normalScoreCorr);
    } else {
      // Both country normals are drawn every year so the cursor doesn't depend on ρ.
      const z1  = gaussianFrom(sim.rng);
      const z2  = gaussianFrom(sim.rng);
      const rho = this.correlation ?? 0;
      e.US = z1;
      e.AU = rho * z1 + Math.sqrt(1 - rho * rho) * z2;
      // Skipped entirely at w = 0 (design 74 §4's rule), so a single-factor run draws four.
      eg   = w > 0 ? gaussianFrom(sim.rng) : 0;
    }

    const prevL = state.inflationLatent ?? {};
    const ag    = Math.exp(-(this.globalReversionSpeed ?? 0.1) * this.dt);
    const latent = { g: ag * (prevL.g ?? 0) + Math.sqrt(1 - ag * ag) * eg };
    const anchors = state.baseInflationRates ?? state.inflationRates ?? {};
    const deviation = {};
    for (const cc of COUNTRIES) {
      const a = Math.exp(-(this.reversionSpeed?.[cc] ?? 0.33) * this.dt);
      latent[cc] = a * (prevL[cc] ?? 0) + Math.sqrt(1 - a * a) * e[cc];
      const scale = joint ? jointLatentSd(w, ag, a) : 1;
      const y = (Math.sqrt(w) * latent.g + Math.sqrt(1 - w) * latent[cc]) / scale;
      deviation[cc] = skewedInflationDeviation(y, {
        anchor: anchors[cc] ?? 0.03, bound: this.lowerBound?.[cc] ?? -0.01, vol: this.vol?.[cc] ?? 0,
      });
    }

    const out = { type: 'INFLATION_STEP_APPLY', deviation, latent, floor: this.floor };
    if (idx >= 0)         out.historicalYear = year;
    if (this.passThrough) out.passThrough    = true;
    if (this.prime) {
      const prevPrime = state.primeDev ?? {};
      const primeDeviation = {};
      for (const cc of COUNTRIES) {
        const rho   = this.prime.rho?.[cc]   ?? 0.6;
        const beta  = this.prime.beta?.[cc]  ?? 1.3;
        const noise = this.prime.noise?.[cc] ?? 0;
        let d = rho * (prevPrime[cc] ?? 0) + (1 - rho) * beta * deviation[cc];
        // Skipped entirely at 0, so the default link draws nothing (design 74 §4's rule).
        if (noise > 0) d += noise * gaussianFrom(sim.rng);
        primeDeviation[cc] = d;
      }
      out.primeDeviation = primeDeviation;
      out.primeFloor     = { ...(this.prime.floor ?? {}) };
    }
    return [out];
  }
}
