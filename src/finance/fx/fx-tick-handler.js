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
  // AR(1) estimate (design 92 §8.1), not a guess. See scripts/lab/calibrate-fx.mjs.
  constructor({ model = 'MEAN_REVERTING', reversionSpeed = 0.296, dt = 1 / 12, pairs = ['USD_AUD'] } = {}) {
    super(null, 'FX Tick');
    this.model                = model;
    this.reversionSpeed       = reversionSpeed;
    this.dt                   = dt;
    this.pairs                = pairs;
    this.generatedActionTypes = ['FX_STEP_APPLY'];
  }

  static fromJSON(d) {
    const h = new this({
      model:          d.model,
      reversionSpeed: d.reversionSpeed,
      dt:             d.dt,
      pairs:          d.pairs,
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
    };
  }

  call({ sim, state }) {
    const stepFn = FX_PROCESS_MODELS[this.model] ?? FX_PROCESS_MODELS.NONE;
    return this.pairs.map((pair) => {
      const prev  = state.fxDeviation?.[pair]   ?? 0;
      const sigma = state.effectiveFxVol?.[pair] ?? 0;
      const z     = gaussianFrom(sim.rng);
      const next  = stepFn(prev, { sigma, dt: this.dt, k: this.reversionSpeed, z });
      return { type: 'FX_STEP_APPLY', pair, deviation: next };
    });
  }
}
