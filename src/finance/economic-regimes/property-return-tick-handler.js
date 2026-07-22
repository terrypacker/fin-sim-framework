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
import { PROPERTY_SLEEVES, DEFAULT_RE_BETA, DEFAULT_RE_IDIO } from './rate-keys.js';

/**
 * PropertyReturnTickHandler — stochastic real-property RETURN PATH (design 75 §4). The
 * house-price sibling of EquityReturnTickHandler (design 74): where that gives equity
 * sleeves a per-year seeded return, this gives `RealProperty.appreciationRate` a per-year
 * deviation so a house rises and falls year to year instead of ramping at a constant rate.
 * Gated the same way — only *scheduled* when `propertyReturnStochastic` is on, so default
 * scenarios draw no randomness and stay bit-for-bit identical.
 *
 * Correlation is the whole point (design 74 §7, design 75 §1.1/§4.1): a soft housing market
 * that co-occurs with a weak equity market is what breaks a plan. So when the equity return
 * path is ALSO active (`shareMarketFactor: true`), this handler does **not** draw its own
 * market shock — it REUSES `state.equityReturnMarketDev`, the market deviation the equity
 * tick already walked this year. The property tick is scheduled with `order: 1` (after the
 * equity tick's default order 0) and each event fully reduces before the next runs, so
 * `equityReturnMarketDev` is already updated when this fires. When the equity path is OFF
 * there is nothing to share, so the handler draws its own `zMarket` and walks its own
 * `state.propertyReturnMarketDev` — making Part A usable standalone (design 75 §4.4 Q2), at
 * the cost that the correlation benefit only materializes when both flags are on.
 *
 * Each real-estate sleeve then loads on the (shared or own) market shock via its beta, plus
 * an optional idiosyncratic term:
 *
 *     dev[sleeve] = beta[sleeve] · marketDev  +  σ_idio[sleeve] · √dt · z_sleeve
 *
 * Per design 75 §4.1 the default betas are deliberately **near zero** (US 0.03 / AU 0.05)
 * because the empirical contemporaneous house↔equity correlation is ~0.04 — the joint crash
 * is a tail event authored via `shocks[]`, not a standing beta. Housing is therefore ~99%
 * idiosyncratic by default (DEFAULT_RE_IDIO US 0.09 / AU 0.10), so unlike equity sleeves the
 * idio term is normally ON. It emits PROPERTY_RETURN_STEP_APPLY carrying the mean-0
 * `deviation` and a separate deterministic `driftComp` (the σ²/2 volatility-drag correction,
 * design 74 §5.3): under GEOMETRIC (default, inherited from `equityReturnDriftComp`) each
 * sleeve gets +((β·σ)²+σ_idio²)/2 so the appreciation anchor reads as the CAGR the user
 * intends; under NONE the drag is left in. PropertyReturnStepReducer stores both;
 * AssetAppreciationHandler adds `deviation + driftComp` to the property's resolved rate
 * (design 75 §4.2 A2) — property does NOT flow through effectiveGrowthRates, so there is no
 * fold reducer.
 *
 * ⚠️ RNG-cursor ordering (design 74 §4). Sleeves are iterated in the stable sorted
 * PROPERTY_SLEEVES order and the idio draw is **skipped entirely** (not drawn-and-
 * multiplied-by-zero) when σ_idio is 0, so enabling idio vol on one sleeve does not shift
 * another's draws. Determinism: the only randomness is from the snapshot-safe sim.rng.
 */
export class PropertyReturnTickHandler extends HandlerEntry {
  static description = 'Loads each real-estate sleeve on the shared market factor (reused from the equity path, or drawn standalone) via beta + optional idiosyncratic term, and emits PROPERTY_RETURN_STEP_APPLY (design 75 §4).';
  static type        = 'PropertyReturnTickHandler';
  static eventType   = 'PROPERTY_RETURN_TICK';

  constructor({ marketVol = 0.18, model = 'WHITE_NOISE', reversionSpeed = 0.3, beta = {}, idioVol = {}, idioScale = 1, driftComp = 'GEOMETRIC', shareMarketFactor = false, dt = 1 } = {}) {
    super(null, 'Property Return Tick');
    this.marketVol         = marketVol;         // annualized market-factor sd (matches equityReturnVol so betas mean the same)
    this.model             = model;             // standalone process model (ignored when sharing)
    this.reversionSpeed    = reversionSpeed;    // OU pull-back speed (standalone MEAN_REVERTING only)
    this.beta              = beta ?? {};        // per-sleeve override of DEFAULT_RE_BETA
    this.idioVol           = idioVol ?? {};     // per-sleeve override of DEFAULT_RE_IDIO
    this.idioScale         = idioScale ?? 1;    // MC multiplier on every sleeve's idio vol (design 75 §6.4 B) — most of a house's variance is idiosyncratic, so this is the housing-vol MC axis
    this.driftComp         = driftComp;         // 'GEOMETRIC' (add σ²/2) or 'NONE' — inherited from the equity decision
    this.shareMarketFactor = shareMarketFactor; // reuse state.equityReturnMarketDev (equity path on) vs draw own
    this.dt                = dt;                // tick interval in years (annual)
    this.generatedActionTypes = ['PROPERTY_RETURN_STEP_APPLY'];
  }

  static fromJSON(d) {
    const h = new this({
      marketVol: d.marketVol, model: d.model, reversionSpeed: d.reversionSpeed,
      beta: d.beta, idioVol: d.idioVol, idioScale: d.idioScale, driftComp: d.driftComp,
      shareMarketFactor: d.shareMarketFactor, dt: d.dt,
    });
    h.id = d.id;
    return h;
  }

  toJSON() {
    return {
      ...super.toJSON(),
      marketVol: this.marketVol, model: this.model, reversionSpeed: this.reversionSpeed,
      beta: this.beta, idioVol: this.idioVol, idioScale: this.idioScale, driftComp: this.driftComp,
      shareMarketFactor: this.shareMarketFactor, dt: this.dt,
    };
  }

  call({ sim, state }) {
    // Systematic market factor: reuse the equity path's shock (perfect co-movement) or, when
    // equity is off, draw our own so the house still has systematic variance (design 75 §4.4).
    let marketDev;
    if (this.shareMarketFactor) {
      marketDev = state.equityReturnMarketDev ?? 0;   // no RNG draw — reuse the equity market shock
    } else {
      const step    = FX_PROCESS_MODELS[this.model] ?? FX_PROCESS_MODELS.WHITE_NOISE;
      const prev    = state.propertyReturnMarketDev ?? 0;
      const zMarket = gaussianFrom(sim.rng);
      marketDev     = step(prev, { sigma: this.marketVol, dt: this.dt, k: this.reversionSpeed, z: zMarket });
    }

    const geometric = this.driftComp === 'GEOMETRIC';
    const deviation = {};
    const driftComp = {};
    for (const sleeve of PROPERTY_SLEEVES) {
      const beta    = this.beta[sleeve]    ?? DEFAULT_RE_BETA[sleeve] ?? 1.0;
      // idioScale (default 1) multiplies every sleeve's idiosyncratic vol so MC can sweep the
      // WIDTH of house-price variance (design 75 §6.4 B). Housing is ~99% idiosyncratic under
      // the near-zero betas, so this — not equityReturnVol — is the honest housing-vol axis.
      const idioVol = (this.idioVol[sleeve] ?? DEFAULT_RE_IDIO[sleeve] ?? 0) * this.idioScale;
      let dev = beta * marketDev;
      // Skip the idio draw entirely when its vol is 0 so the RNG cursor is unadvanced and
      // the market-only path reproduces exactly (design 74 §4 ⚠️).
      if (idioVol > 0) {
        const zIdio = gaussianFrom(sim.rng);
        dev += idioVol * Math.sqrt(this.dt) * zIdio;
      }
      deviation[sleeve] = dev;
      // Volatility-drag compensation (design 74 §5.3, inherited): σ² is the sleeve's
      // annualized return variance (β·σ_market)² + σ_idio². Kept SEPARATE from the mean-0
      // deviation so telemetry stays pure.
      driftComp[sleeve] = geometric
        ? (Math.pow(beta * this.marketVol, 2) + idioVol * idioVol) / 2
        : 0;
    }

    return [{ type: 'PROPERTY_RETURN_STEP_APPLY', marketDev, deviation, driftComp }];
  }
}
