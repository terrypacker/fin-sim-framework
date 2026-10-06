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
import { FX_PROCESS_MODELS, gaussianFrom } from './fx-process-models.js';

/**
 * FxTickHandler — the sole in-loop consumer of the simulation RNG (design 47 §4).
 *
 * Fires on the pre-scheduled FX_TICK EventSeries (monthly by default). For each
 * registered pair it walks the stored log-space deviation one step using the
 * selected process model, drawing a standard-normal from the seeded sim.rng,
 * and emits FX_STEP_APPLY so a pure reducer stores the new deviation.
 *
 * Only scheduled when fxProcessModel !== 'NONE', so default scenarios draw no
 * randomness and remain bit-for-bit identical to today.
 */
export class FxTickHandler extends HandlerEntry {
  static description = 'Walks the FX log-deviation one step per pair from the seeded sim.rng; emits FX_STEP_APPLY.';
  static type        = 'FxTickHandler';
  static eventType   = 'FX_TICK';

  // reversionSpeed default matches FxService.DEFAULT_FX_REVERSION — the post-float
  // TERM-STRUCTURE fit (design 92 §8.1), not a guess and not the lag-1 AR(1) value.
  // See scripts/lab/calibrate-fx.mjs.
  constructor({ model = 'MEAN_REVERTING', reversionSpeed = 0.114, dt = 1 / 12, pairs = ['USD_AUD'], equityCorrelation = 0 } = {}) {
    super(null, 'FX Tick');
    this.model                = model;
    this.reversionSpeed       = reversionSpeed;
    this.dt                   = dt;
    this.pairs                = pairs;
    // Design 120 §4, §5.4 — the ANNUAL correlation of the FX move with the year's equity
    // market shock (`state.equityMarketShock`). 0 reads nothing.
    this.equityCorrelation    = equityCorrelation;
    this.generatedActionTypes = ['FX_STEP_APPLY'];
  }

  static fromJSON(d) {
    const h = new this({
      model:          d.model,
      reversionSpeed: d.reversionSpeed,
      dt:             d.dt,
      pairs:          d.pairs,
      equityCorrelation: d.equityCorrelation ?? 0,
    });
    h.id = d.id;
    return h;
  }

  toJSON() {
    return {
      ...super.toJSON(),
      model:          this.model,
      reversionSpeed: this.reversionSpeed,
      dt:             this.dt,
      pairs:          this.pairs,
      equityCorrelation: this.equityCorrelation,
    };
  }

  call({ sim, state }) {
    // Design 107 §15.5 — draw from this process's OWN year-keyed substream, so an unrelated
    // process drawing more or fewer times cannot shift which year this value lands on. Falls
    // back to the shared cursor unless `useRngStreams` is on, so default runs are unchanged.
    const rng = sim.rngStream?.('fx', (sim.currentDate ?? new Date()).getUTCFullYear()) ?? sim.rng;

    const stepFn = FX_PROCESS_MODELS[this.model] ?? FX_PROCESS_MODELS.NONE;
    const zMarket = this._marketShock(sim, state);
    return this.pairs.map((pair) => {
      const prev  = state.fxDeviation?.[pair]   ?? 0;
      const sigma = state.effectiveFxVol?.[pair] ?? 0;
      const zFx   = gaussianFrom(rng);
      // Design 120 §5.4 — spread the year's correlated part evenly over its steps: each
      // takes ρ·√dt of the market shock and √(1 − ρ²) of its own draw. Over a year the
      // correlated parts sum to ρ·z_market and the variance to (ρ² + 1 − ρ²), so the FX
      // path's volatility is unchanged. Still ONE draw per step, so the cursor — and every
      // other process's draws — are the same with ρ on or off.
      const z     = zMarket == null ? zFx
        : this.equityCorrelation * Math.sqrt(this.dt) * zMarket
          + Math.sqrt(1 - this.equityCorrelation * this.equityCorrelation) * zFx;
      const next  = stepFn(prev, { sigma, dt: this.dt, k: this.reversionSpeed, z });
      return { type: 'FX_STEP_APPLY', pair, deviation: next };
    });
  }

  /**
   * The current calendar year's standardized equity market shock, or null when the FX
   * path does not correlate (ρ = 0) or no shock drives this year (stochastic equity off,
   * or the run's first year, whose growth carries no draw).
   * @private
   */
  _marketShock(sim, state) {
    if (!this.equityCorrelation) return null;
    const shock = state.equityMarketShock;
    const year  = (sim.currentDate ?? new Date()).getUTCFullYear();
    return shock?.year === year && Number.isFinite(shock.z) ? shock.z : null;
  }
}
