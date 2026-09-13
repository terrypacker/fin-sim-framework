/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { HandlerEntry }                    from '../../simulation-framework/handlers.js';
import { FX_PROCESS_MODELS, FX_PROCESS_MODEL_IDS, gaussianFrom } from '../fx/fx-process-models.js';
import { EQUITY_SLEEVES, DEFAULT_EQUITY_BETA, DEFAULT_EQUITY_IDIO } from './rate-keys.js';
import { HISTORICAL_EQUITY_RETURNS }       from './historical-equity-returns.js';

/**
 * The equity market-factor processes: the shared FX process library (design 47) plus the
 * historical block bootstrap (design 102). The bootstrap is not in `FX_PROCESS_MODELS`
 * because it isn't a one-step function of the prior deviation: it carries a cursor into the
 * bundled series and draws a uniform only when a new block starts.
 */
export const EQUITY_RETURN_MODEL_IDS = [...FX_PROCESS_MODEL_IDS, 'HISTORICAL_BOOTSTRAP'];

/**
 * Dropdown labels for `equityReturnModel` (design 102 §3). The ids are what saved scenarios
 * store, so they stay put; these labels say what each process does TO A RETURN. That's the
 * part the FX-derived ids get wrong: an OU step applied to a return makes the return
 * persist, and design 97 §20.9 measured that as momentum.
 */
export const EQUITY_RETURN_MODEL_LABELS = Object.freeze({
  WHITE_NOISE:          'White noise — independent years (default)',
  HISTORICAL_BOOTSTRAP: 'Historical bootstrap — replay US years 1871–2023 in blocks',
  MEAN_REVERTING:       'Persistent returns (momentum) — stress test only',
  RANDOM_WALK:          'Random walk of the return — unbounded, not for equities',
  NONE:                 'None — no deviation (the anchor every year)',
});

/**
 * The bundled series, re-centred once at load (design 102 §4.2–4.4):
 *   - `deviations` — each year's return minus the series mean, so the scenario's anchor stays
 *     the centre and the bootstrap only contributes history's SHAPE;
 *   - `sd`         — the series' sample sd, the unit `vol` rescales against;
 *   - `dragVar`    — 2 × (arithmetic − geometric mean). This is the "variance" that makes the
 *     GEOMETRIC σ²/2 compensation exact on the historical data. History isn't Gaussian, so
 *     it differs from the sample σ² (about 4% smaller on this series).
 */
export const HISTORICAL_BOOTSTRAP_SERIES = (() => {
  const r    = HISTORICAL_EQUITY_RETURNS.returns;
  const n    = r.length;
  const mean = r.reduce((s, x) => s + x, 0) / n;
  const sd   = Math.sqrt(r.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1));
  const geo  = Math.exp(r.reduce((s, x) => s + Math.log(1 + x), 0) / n) - 1;
  return Object.freeze({
    firstYear:  HISTORICAL_EQUITY_RETURNS.firstYear,
    deviations: Object.freeze(r.map(x => x - mean)),
    sd,
    dragVar:    2 * (mean - geo),
  });
})();

/**
 * EquityReturnTickHandler — stochastic equity RETURN PATH (design 74 §4/§5.1). The
 * third in-loop consumer of the seeded simulation RNG (after FxTickHandler, design 47,
 * and YieldCurveTickHandler, design 67), gated the same way: it is only *scheduled*
 * when `equityReturnStochastic` is on, so default scenarios draw no randomness and stay
 * bit-for-bit identical.
 *
 * Fires on the pre-scheduled EQUITY_RETURN_TICK EventSeries (annual). Produces ONE market
 * deviation per year from the chosen process:
 *   - WHITE_NOISE (default): an independent Gaussian draw. Equity returns are close to IID.
 *   - HISTORICAL_BOOTSTRAP (design 102): the next year of a block of consecutive historical
 *     years, re-centred on the anchor and rescaled to `vol`. Fat tails, skew and multi-year
 *     runs come from the data rather than from a fitted parameter.
 *   - MEAN_REVERTING: an OU step applied to the RETURN, which makes returns PERSIST
 *     (momentum, design 97 §20.9). Kept as a stress test.
 * Each equity sleeve then loads on that single deviation via its beta, plus an optional
 * idiosyncratic term:
 *
 *     dev[sleeve] = beta[sleeve] · marketDev  +  σ_idio[sleeve] · √dt · z_sleeve
 *
 * One market draw drives every sleeve, so the *systematic* risk survives portfolio
 * aggregation (design 74 §4 rejects independent per-sleeve draws — they diversify away
 * the very risk the exercise measures). It emits EQUITY_RETURN_STEP_APPLY carrying the
 * mean-0 `deviation` AND a separate deterministic `driftComp` term (design 74 §5.3): under
 * GEOMETRIC (default) each sleeve gets +σ²/2 added back so the anchor reads as the CAGR
 * the user intends and the flag changes only the spread, not the centre; under NONE the
 * anchor is an arithmetic mean and the ≈σ²/2 volatility drag is left in. A pure reducer
 * stores both; EquityReturnReducer folds `deviation + driftComp` onto
 * `effectiveGrowthRates[<sleeve>]` (and its `<sleeve>::<stateKey>` variants) each period.
 *
 * After the sleeve loop it applies the PER-SECURITY overlay (design 94 §6.2): a security
 * loads on its SLEEVE's total deviation and carries only its DIFFERENCE from it, so β = 1
 * with σ_idio = 0 — every synthetic market security, and therefore every migrated equity
 * lot — is exactly the identity and costs nothing. The overlay rides on the action as
 * `securityDeviation` / `securityDriftComp`, and `computeHoldingsGrowth` adds it to the
 * holding's resolved rate directly rather than folding it onto `effectiveGrowthRates`
 * (design 94 §6.3, following design 75 §4.2 A2's property precedent).
 *
 * ⚠️ RNG-cursor ordering (design 74 §4). Idiosyncratic draws consume extra uniforms, so
 * enabling them shifts every subsequent draw. Sleeves are iterated in the stable sorted
 * `EQUITY_SLEEVES` order, and the idio draw is **skipped entirely** (not drawn-and-
 * multiplied-by-zero) when `σ_idio` is 0 — otherwise the idio-off path would not
 * reproduce the market-only path. **The same rule, and the same skip, now govern the
 * security loop — which iterates the REGISTRY in sorted `id` order, not the portfolio.
 * Declaring a security with idiosyncratic vol perturbs the run whether or not anything
 * holds it** (design 94 §6.2: conditioning the cursor on holdings would make the random
 * path a function of portfolio state, which changes under every MPC rollout, optimizer
 * probe and replay branch). The bootstrap draws its market uniform only in a year that
 * starts a block, so it consumes fewer uniforms than the Gaussian models.
 *
 * Determinism: the only randomness is drawn from the snapshot-safe sim.rng (its cursor
 * is captured/restored in every history snapshot), and the bootstrap's block cursor lives
 * in `state.equityReturnBootstrap`, so replays and MPC/optimizer forward rollouts
 * reproduce the same path byte-for-byte.
 */
export class EquityReturnTickHandler extends HandlerEntry {
  static description = 'Draws one market factor from the seeded sim.rng (or the next year of a historical block, design 102), loads each equity sleeve on it via beta (+ optional idiosyncratic term), applies the per-security overlay, and emits EQUITY_RETURN_STEP_APPLY (design 74 §5.1, design 94 §6.2).';
  static type        = 'EquityReturnTickHandler';
  static eventType   = 'EQUITY_RETURN_TICK';

  constructor({ vol = 0.18, model = 'WHITE_NOISE', reversionSpeed = 0.3, beta = {}, idioVol = {}, driftComp = 'GEOMETRIC', blockLength = 5, dt = 1 } = {}) {
    super(null, 'Equity Return Tick');
    this.vol                  = vol;             // annualized market-factor sd (rate units)
    this.model                = model;           // one of EQUITY_RETURN_MODEL_IDS
    this.reversionSpeed       = reversionSpeed;  // OU pull-back speed (MEAN_REVERTING only)
    this.beta                 = beta ?? {};      // per-sleeve override of DEFAULT_EQUITY_BETA
    this.idioVol              = idioVol ?? {};   // per-sleeve idiosyncratic sd; absent ⇒ 0
    this.driftComp            = driftComp;       // 'GEOMETRIC' (add σ²/2) or 'NONE' (design 74 §5.3)
    this.blockLength          = blockLength;     // consecutive historical years per block (HISTORICAL_BOOTSTRAP only)
    this.dt                   = dt;              // tick interval in years (annual)
    this.generatedActionTypes = ['EQUITY_RETURN_STEP_APPLY'];
  }

  static fromJSON(d) {
    const h = new this({
      vol: d.vol, model: d.model, reversionSpeed: d.reversionSpeed,
      beta: d.beta, idioVol: d.idioVol, driftComp: d.driftComp, blockLength: d.blockLength, dt: d.dt,
    });
    h.id = d.id;
    return h;
  }

  toJSON() {
    return {
      ...super.toJSON(),
      vol: this.vol, model: this.model, reversionSpeed: this.reversionSpeed,
      beta: this.beta, idioVol: this.idioVol, driftComp: this.driftComp, blockLength: this.blockLength, dt: this.dt,
    };
  }

  call({ sim, state }) {
    const bootstrapping = this.model === 'HISTORICAL_BOOTSTRAP';
    let marketDev, marketVar, bootstrap = null;
    if (bootstrapping) {
      ({ marketDev, bootstrap } = this._bootstrapStep(sim, state));
      // The drag the rescaled series actually has (design 102 §4.4). Scaling by s scales
      // the arithmetic-minus-geometric gap by ≈ s², the same way it scales a variance.
      const scale = this.vol / HISTORICAL_BOOTSTRAP_SERIES.sd;
      marketVar   = scale * scale * HISTORICAL_BOOTSTRAP_SERIES.dragVar;
    } else {
      const step = FX_PROCESS_MODELS[this.model] ?? FX_PROCESS_MODELS.WHITE_NOISE;
      const prev = state.equityReturnMarketDev ?? 0;
      // ONE market draw, shared across all sleeves (design 74 §4).
      const zMarket = gaussianFrom(sim.rng);
      marketDev = step(prev, { sigma: this.vol, dt: this.dt, k: this.reversionSpeed, z: zMarket });
      marketVar = this.vol * this.vol;
    }

    const geometric = this.driftComp === 'GEOMETRIC';
    const deviation = {};
    const driftComp = {};
    // Var(sleeveDev[k]) = β_k²·Var(market) + σ_idio,k² — captured in the sleeve loop
    // because the per-security drift compensation (§6.2) needs the variance of the
    // sleeve a security loads on, not the market factor's.
    const sleeveVar = {};
    for (const sleeve of EQUITY_SLEEVES) {
      const beta    = this.beta[sleeve]    ?? DEFAULT_EQUITY_BETA[sleeve] ?? 1.0;
      // Design 90 §7.4 — absent ⇒ the sourced default, not 0. An explicit 0 still skips.
      const idioVol = this.idioVol[sleeve] ?? DEFAULT_EQUITY_IDIO[sleeve] ?? 0;
      let dev = beta * marketDev;
      // Skip the idio draw entirely when its vol is 0 so the RNG cursor is unadvanced
      // and the market-only path reproduces exactly (design 74 §4 ⚠️).
      if (idioVol > 0) {
        const zIdio = gaussianFrom(sim.rng);
        dev += idioVol * Math.sqrt(this.dt) * zIdio;
      }
      deviation[sleeve] = dev;
      // Volatility-drag compensation (design 74 §5.3). Adding a mean-0 shock to a
      // multiplicatively-applied rate lowers the realized geometric return by ≈σ²/2,
      // where σ² is the sleeve's annualized return variance β²·Var(market) + σ_idio².
      // GEOMETRIC adds it back so the anchor reads as the CAGR the user intends and the
      // flag changes only the SPREAD, not the centre; NONE interprets the anchor as an
      // arithmetic mean and leaves the drag in. This is a deterministic, mean-nonzero
      // term kept SEPARATE from the stochastic deviation so `equityReturnDev` stays
      // pure mean-0. (Exact for WHITE_NOISE. For HISTORICAL_BOOTSTRAP the market "variance"
      // is the series' measured drag, which is exact on history itself. For MEAN_REVERTING
      // the stationary variance is HIGHER than σ², so GEOMETRIC under-compensates.)
      sleeveVar[sleeve]  = beta * beta * marketVar + idioVol * idioVol;
      driftComp[sleeve] = geometric
        ? sleeveVar[sleeve] / 2
        : 0;
    }

    // ── The per-security overlay (design 94 §6.2) ─────────────────────────────────
    //
    // A security loads on its SLEEVE's total deviation and stores only its DIFFERENCE
    // from it, so β=1 with σ_idio=0 — every synthetic market security, and therefore
    // every migrated lot — stores exactly zero and draws nothing:
    //
    //     secDev[s]  = (β_s − 1)·sleeveDev[s.rateKey] + (σ_idio,s > 0 ? σ_idio,s·√dt·z_s : 0)
    //     secComp[s] = geometric ? ((β_s² − 1)·Var(sleeveDev[s.rateKey]) + σ_idio,s²)/2 : 0
    //
    // Expressed as a deviation FROM the sleeve rather than as an absolute rate, so a
    // security tracks whatever its sleeve does — including design 90 §7.4's sleeve
    // dispersion when that arrives. The two compose instead of racing.
    //
    // ⚠️ **The draw set is the REGISTRY, not the portfolio.** Securities are iterated in
    // sorted `id` order, AFTER the sleeve loop, and a σ_idio > 0 security draws whether or
    // not any position currently holds it. Conditioning the cursor on holdings would make
    // the random path depend on portfolio state — which changes under every MPC rollout,
    // every optimizer probe and every replay branch — and the determinism guarantee would
    // not survive it. The price, which belongs wherever a registry is authored: **declaring
    // an unheld security with idiosyncratic vol perturbs the whole run.**
    const securities        = state.securities ?? null;
    const securityDeviation = {};
    const securityDriftComp = {};
    let   hasOverlay        = false;
    for (const id of Object.keys(securities ?? {}).sort()) {
      const sec     = securities[id];
      const secBeta = sec?.beta ?? 1.0;
      const secIdio = sec?.idioVol ?? 0;
      // The identity. Not "a small number" — exactly zero on both terms, so it takes no
      // draw, gets no state entry and costs no growth-path arithmetic. This is what keeps
      // §9's migration inert and a plan holding six index funds free.
      if (secBeta === 1 && !(secIdio > 0)) continue;
      hasOverlay = true;
      let dev = (secBeta - 1) * (deviation[sec.rateKey] ?? 0);
      // Same skip discipline as the sleeve loop: SKIPPED entirely at σ_idio = 0, not
      // drawn-and-multiplied-by-zero, so a beta-only security leaves the cursor alone.
      if (secIdio > 0) {
        const zIdio = gaussianFrom(sim.rng);
        dev += secIdio * Math.sqrt(this.dt) * zIdio;
      }
      const comp = geometric
        ? ((secBeta * secBeta - 1) * (sleeveVar[sec.rateKey] ?? 0) + secIdio * secIdio) / 2
        : 0;
      // Sparse: an entry exists only where the overlay is non-zero.
      if (dev  !== 0) securityDeviation[id] = dev;
      if (comp !== 0) securityDriftComp[id] = comp;
    }

    const out = { type: 'EQUITY_RETURN_STEP_APPLY', marketDev, deviation, driftComp };
    // Emitted as a PAIR and only when the registry actually carries a non-identity
    // security, so a scenario whose securities are all identities gains no action field
    // and no state key. Once present they are emitted every tick even when empty, so a
    // year in which the overlay evaluates to zero CLEARS last year's entries rather than
    // leaving them to persist.
    if (hasOverlay) {
      out.securityDeviation = securityDeviation;
      out.securityDriftComp = securityDriftComp;
    }
    // Only the bootstrap carries a cursor, so every other model's action (and state) keeps
    // its exact pre-design-102 shape.
    if (bootstrap) out.bootstrap = bootstrap;
    return [out];
  }

  /**
   * One year of the circular block bootstrap (design 102 §4.3). While a block has years
   * left, replay the next consecutive historical year; once it's exhausted, draw ONE
   * uniform for a new start year and replay a fresh block of `blockLength` years. The
   * series wraps from its last year to its first.
   *
   * The cursor comes back as `{ index, year, remaining }`: the series index and calendar
   * year just replayed, and how many more years of this block are left to replay.
   *
   * @private
   */
  _bootstrapStep(sim, state) {
    const { deviations, sd, firstYear } = HISTORICAL_BOOTSTRAP_SERIES;
    const n     = deviations.length;
    const prior = state.equityReturnBootstrap;
    let index, remaining;
    if (prior?.remaining > 0) {
      index     = (prior.index + 1) % n;
      remaining = prior.remaining - 1;
    } else {
      index     = Math.floor(sim.rng() * n);
      remaining = Math.max(1, Math.round(this.blockLength)) - 1;
    }
    return {
      marketDev: deviations[index] * (this.vol / sd),
      bootstrap: { index, year: firstYear + index, remaining },
    };
  }
}
