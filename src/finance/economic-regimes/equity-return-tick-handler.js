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
import { FX_PROCESS_MODELS, gaussianFrom } from '../fx/fx-process-models.js';
import { EQUITY_SLEEVES, DEFAULT_EQUITY_BETA } from './rate-keys.js';

/**
 * EquityReturnTickHandler — stochastic equity RETURN PATH (design 74 §4/§5.1). The
 * third in-loop consumer of the seeded simulation RNG (after FxTickHandler, design 47,
 * and YieldCurveTickHandler, design 67), gated the same way: it is only *scheduled*
 * when `equityReturnStochastic` is on, so default scenarios draw no randomness and stay
 * bit-for-bit identical.
 *
 * Fires on the pre-scheduled EQUITY_RETURN_TICK EventSeries (annual). Draws ONE market
 * factor `zMarket` from `sim.rng` and walks a shared market deviation one process step
 * (WHITE_NOISE by default — equity returns are close to IID; MEAN_REVERTING offered for
 * a valuation-based view). Each equity sleeve then loads on that single shock via its
 * beta, plus an optional idiosyncratic term:
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
 * ⚠️ RNG-cursor ordering (design 74 §4). Idiosyncratic draws consume extra uniforms, so
 * enabling them shifts every subsequent draw. Sleeves are iterated in the stable sorted
 * `EQUITY_SLEEVES` order, and the idio draw is **skipped entirely** (not drawn-and-
 * multiplied-by-zero) when `σ_idio` is 0 — otherwise the idio-off path would not
 * reproduce the market-only path.
 *
 * Determinism: the only randomness is drawn from the snapshot-safe sim.rng (its cursor
 * is captured/restored in every history snapshot), so replays and MPC/optimizer forward
 * rollouts reproduce the same path byte-for-byte.
 */
export class EquityReturnTickHandler extends HandlerEntry {
  static description = 'Draws one market factor from the seeded sim.rng, loads each equity sleeve on it via beta (+ optional idiosyncratic term), and emits EQUITY_RETURN_STEP_APPLY (design 74 §5.1).';
  static type        = 'EquityReturnTickHandler';
  static eventType   = 'EQUITY_RETURN_TICK';

  constructor({ vol = 0.18, model = 'WHITE_NOISE', reversionSpeed = 0.3, beta = {}, idioVol = {}, driftComp = 'GEOMETRIC', dt = 1 } = {}) {
    super(null, 'Equity Return Tick');
    this.vol                  = vol;             // annualized market-factor sd (rate units)
    this.model                = model;           // one of FX_PROCESS_MODEL_IDS
    this.reversionSpeed       = reversionSpeed;  // OU pull-back speed (MEAN_REVERTING only)
    this.beta                 = beta ?? {};      // per-sleeve override of DEFAULT_EQUITY_BETA
    this.idioVol              = idioVol ?? {};   // per-sleeve idiosyncratic sd; absent ⇒ 0
    this.driftComp            = driftComp;       // 'GEOMETRIC' (add σ²/2) or 'NONE' (design 74 §5.3)
    this.dt                   = dt;              // tick interval in years (annual)
    this.generatedActionTypes = ['EQUITY_RETURN_STEP_APPLY'];
  }

  static fromJSON(d) {
    const h = new this({
      vol: d.vol, model: d.model, reversionSpeed: d.reversionSpeed,
      beta: d.beta, idioVol: d.idioVol, driftComp: d.driftComp, dt: d.dt,
    });
    h.id = d.id;
    return h;
  }

  toJSON() {
    return {
      ...super.toJSON(),
      vol: this.vol, model: this.model, reversionSpeed: this.reversionSpeed,
      beta: this.beta, idioVol: this.idioVol, driftComp: this.driftComp, dt: this.dt,
    };
  }

  call({ sim, state }) {
    const step   = FX_PROCESS_MODELS[this.model] ?? FX_PROCESS_MODELS.WHITE_NOISE;
    const prev   = state.equityReturnMarketDev ?? 0;
    // ONE market draw, shared across all sleeves (design 74 §4).
    const zMarket   = gaussianFrom(sim.rng);
    const marketDev = step(prev, { sigma: this.vol, dt: this.dt, k: this.reversionSpeed, z: zMarket });

    const geometric = this.driftComp === 'GEOMETRIC';
    const deviation = {};
    const driftComp = {};
    for (const sleeve of EQUITY_SLEEVES) {
      const beta    = this.beta[sleeve]    ?? DEFAULT_EQUITY_BETA[sleeve] ?? 1.0;
      const idioVol = this.idioVol[sleeve] ?? 0;
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
      // where σ² is the sleeve's annualized return variance (β·σ_market)² + σ_idio².
      // GEOMETRIC adds it back so the anchor reads as the CAGR the user intends and the
      // flag changes only the SPREAD, not the centre; NONE interprets the anchor as an
      // arithmetic mean and leaves the drag in. This is a deterministic, mean-nonzero
      // term kept SEPARATE from the stochastic deviation so `equityReturnDev` stays
      // pure mean-0. (Exact for WHITE_NOISE; for MEAN_REVERTING the stationary variance
      // is lower, so GEOMETRIC slightly over-compensates — an accepted approximation.)
      driftComp[sleeve] = geometric
        ? (Math.pow(beta * this.vol, 2) + idioVol * idioVol) / 2
        : 0;
    }

    return [{ type: 'EQUITY_RETURN_STEP_APPLY', marketDev, deviation, driftComp }];
  }
}
