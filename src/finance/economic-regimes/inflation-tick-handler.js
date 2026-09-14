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
 * The post-war joint window, 1951 onward (design 103 §2): each country's AR(1) fit to its
 * annual inflation, the fit's residuals, and the US 10-year yield changes, all indexed by
 * `year − firstYear`. Pre-1951 inflation is left out on purpose. Under the gold standard it
 * averaged −0.3% with no persistence, which isn't the monetary world a plan retires into.
 *
 *   - `residuals` — (x_t − μ) − φ·(x_{t−1} − μ), re-centred to mean 0. These are the
 *     innovations joint mode feeds into the inflation OU, so a year's inflation SURPRISE
 *     travels with that year's equity return, while persistence stays the model's own.
 *     Levels would jump at every block join (a 1974 level straight into a 1998 one).
 *   - `sd` — the residuals' sd, the unit the model's innovation sd rescales against.
 *   - `gs10.shocks` / `gs10.sd` — the yield changes re-centred, for the yield-curve OU.
 */
export const HISTORICAL_JOINT_WINDOW = (() => {
  const mean = (x) => x.reduce((s, v) => s + v, 0) / x.length;
  const sdev = (x) => { const m = mean(x); return Math.sqrt(x.reduce((s, v) => s + (v - m) ** 2, 0) / (x.length - 1)); };
  const fit  = (x) => {
    const mu = mean(x.slice(1));
    let num = 0, den = 0;
    for (let i = 1; i < x.length; i++) { num += (x[i - 1] - mu) * (x[i] - mu); den += (x[i - 1] - mu) ** 2; }
    const phi = num / den;
    const raw = x.slice(1).map((v, i) => (v - mu) - phi * (x[i] - mu));
    const m   = mean(raw);
    const residuals = Object.freeze(raw.map(e => e - m));
    return Object.freeze({ mean: mu, phi, residuals, sd: sdev(residuals) });
  };
  const gsWindow = HISTORICAL_MACRO.gs10Change.slice(1);
  const gsMean   = mean(gsWindow);
  const shocks   = Object.freeze(gsWindow.map(v => v - gsMean));
  return Object.freeze({
    firstYear: HISTORICAL_MACRO.firstYear + 1,
    length:    gsWindow.length,
    US:        fit(HISTORICAL_MACRO.usInflation),
    AU:        fit(HISTORICAL_MACRO.auInflation),
    gs10:      Object.freeze({ shocks, sd: sdev(shocks) }),
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
 * InflationTickHandler — the stochastic inflation path (design 103 §4). Another seeded,
 * snapshot-safe in-loop consumer, gated like the others: it's only *scheduled* when
 * `inflationStochastic` is on, so default runs draw nothing and stay byte-identical.
 *
 * Fires on the annual INFLATION_TICK, AFTER the equity tick on the same year-end (order 2),
 * and walks each country's deviation from its inflation anchor one OU step on the LEVEL:
 *
 *     dev_t[cc] = e^(−k·dt)·dev_{t−1}[cc] + ε_t[cc]
 *
 * An OU on a level does mean-revert. (The equity misuse, design 102 §2, was an OU on a
 * return.) The innovation sd is σ·√(1 − e^(−2k·dt)), so σ is the STATIONARY sd, "how far
 * inflation wanders", whatever k is.
 *
 *   - GAUSSIAN: ε from two standard normals, US and AU correlated at ρ (four uniforms a
 *     year, always, so the cursor doesn't depend on the path).
 *   - HISTORICAL_JOINT: ε is the post-war AR(1) residual for the historical YEAR the
 *     equity bootstrap just replayed (`state.equityReturnBootstrap.year`, the way the
 *     property path reuses the equity market factor), rescaled to the model's innovation
 *     sd. No RNG draw. US and AU keep their measured same-year correlation, so ρ doesn't
 *     apply. If there's no cursor, or its year is outside 1951–, the tick falls back to
 *     GAUSSIAN for that year, drawing as GAUSSIAN would.
 *
 * Emits INFLATION_STEP_APPLY carrying the deviation and the floor. With `passThrough` set
 * (joint mode) the step also tells EquityReturnReducer to add each market's local inflation
 * deviation to its NOMINAL return (design 103 §5.2): the bootstrap supplies a REAL return,
 * and real plus the year's inflation surprise rebuilds history's nominal return.
 *
 * **The prime-rate link (design 104).** With `prime` set (Prime Rate Mode "follows
 * inflation"), the same tick also walks each country's policy-rate deviation toward β times
 * its inflation deviation, closing (1 − ρ) of the gap a year:
 *
 *     primeDev_t[cc] = ρ·primeDev_{t−1}[cc] + (1 − ρ)·β·inflationDev_t[cc]  (+ noise·z)
 *
 * The partial-adjustment ("Taylor-style") rule policy rates have followed since 1955
 * (design 104 §2). It centres on the prime setting, so prime moves only when inflation
 * does. The optional noise, off by default, stands for the policy moves inflation doesn't
 * explain. Its Gaussian is drawn only when the noise is above 0, after the inflation draws.
 * The step carries `primeDeviation` and `primeFloor`; InflationPathReducer folds them.
 */
export class InflationTickHandler extends HandlerEntry {
  static description = 'Walks each country\'s inflation deviation one mean-reverting step per year: Gaussian and correlated, or joint with the equity bootstrap\'s historical year. Optionally moves the prime rate in response (design 104). Emits INFLATION_STEP_APPLY (design 103 §4–5).';
  static type        = 'InflationTickHandler';
  static eventType   = 'INFLATION_TICK';

  constructor({ vol = { US: 0.028, AU: 0.03 }, reversionSpeed = { US: 0.33, AU: 0.33 }, correlation = 0.35,
                model = 'GAUSSIAN', floor = -0.05, passThrough = false, prime = null, dt = 1 } = {}) {
    super(null, 'Inflation Tick');
    this.vol                  = vol;             // per-country STATIONARY sd of the deviation
    this.reversionSpeed       = reversionSpeed;  // per-country OU pull-back speed k, per year
    this.correlation          = correlation;     // US–AU innovation correlation (GAUSSIAN only)
    this.model                = model;           // one of INFLATION_MODEL_IDS
    this.floor                = floor;           // lowest effective inflation rate the fold allows
    this.passThrough          = passThrough;     // add the deviation to nominal equity (joint mode)
    this.prime                = prime;           // design 104 link: { beta, rho, noise, floor } per country, or null
    this.dt                   = dt;              // tick interval in years (annual)
    this.generatedActionTypes = ['INFLATION_STEP_APPLY'];
  }

  static fromJSON(d) {
    const h = new this({
      vol: d.vol, reversionSpeed: d.reversionSpeed, correlation: d.correlation,
      model: d.model, floor: d.floor, passThrough: d.passThrough, prime: d.prime ?? null, dt: d.dt,
    });
    h.id = d.id;
    return h;
  }

  toJSON() {
    return {
      ...super.toJSON(),
      vol: this.vol, reversionSpeed: this.reversionSpeed, correlation: this.correlation,
      model: this.model, floor: this.floor, passThrough: this.passThrough, prime: this.prime, dt: this.dt,
    };
  }

  /** The OU innovation sd that makes `vol[cc]` the stationary sd. */
  innovationSd(cc) {
    const k = this.reversionSpeed?.[cc] ?? 0.33;
    return (this.vol?.[cc] ?? 0) * Math.sqrt(1 - Math.exp(-2 * k * this.dt));
  }

  call({ sim, state }) {
    const prev = state.inflationDev ?? {};
    const year = this.model === 'HISTORICAL_JOINT' ? state.equityReturnBootstrap?.year : null;
    const idx  = year != null ? jointWindowIndex(year) : -1;

    const eps = {};
    if (idx >= 0) {
      for (const cc of COUNTRIES) {
        const w = HISTORICAL_JOINT_WINDOW[cc];
        eps[cc] = w.residuals[idx] * (this.innovationSd(cc) / w.sd);
      }
    } else {
      // Both normals are drawn every year so the cursor doesn't depend on ρ.
      const z1  = gaussianFrom(sim.rng);
      const z2  = gaussianFrom(sim.rng);
      const rho = this.correlation ?? 0;
      eps.US = this.innovationSd('US') * z1;
      eps.AU = this.innovationSd('AU') * (rho * z1 + Math.sqrt(1 - rho * rho) * z2);
    }

    const deviation = {};
    for (const cc of COUNTRIES) {
      const k = this.reversionSpeed?.[cc] ?? 0.33;
      deviation[cc] = (prev[cc] ?? 0) * Math.exp(-k * this.dt) + eps[cc];
    }

    const out = { type: 'INFLATION_STEP_APPLY', deviation, floor: this.floor };
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
