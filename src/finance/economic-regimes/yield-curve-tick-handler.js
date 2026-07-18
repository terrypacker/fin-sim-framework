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

const COUNTRIES = ['US', 'AU'];

/**
 * YieldCurveTickHandler — optional stochastic evolution of the fixed-income LEVEL
 * (design 67 §6, Phase 3). The second in-loop consumer of the seeded simulation RNG
 * (after FxTickHandler, design 47 §4), and gated the same way: it is only *scheduled*
 * when `yieldCurveStochastic` is on, so default scenarios draw no randomness and stay
 * bit-for-bit identical.
 *
 * Fires on the pre-scheduled YIELD_CURVE_TICK EventSeries (annual). For each country it
 * walks the stored level deviation one Ornstein-Uhlenbeck step — pulled back toward 0
 * (the regime-driven anchor) with speed `k`, kicked by a standard-normal from `sim.rng`
 * — and emits YIELD_CURVE_STEP_APPLY so a pure reducer stores the new deviation. The
 * YieldCurveReducer then folds that deviation onto `effectiveInterestRates[FIXED_INCOME_*]`
 * each period as a parallel curve shift. Because the deviation is a mean-0 OU process the
 * long-run level stays anchored while bonds see realistic year-to-year rate risk.
 *
 * Determinism: the only randomness is `z`, drawn from the snapshot-safe sim.rng (its
 * cursor is captured/restored in every history snapshot), so replays and MPC/optimizer
 * forward rollouts reproduce the same path byte-for-byte.
 */
export class YieldCurveTickHandler extends HandlerEntry {
  static description = 'Walks the fixed-income level deviation one mean-reverting step per country from the seeded sim.rng; emits YIELD_CURVE_STEP_APPLY (design 67 §6).';
  static type        = 'YieldCurveTickHandler';
  static eventType   = 'YIELD_CURVE_TICK';

  constructor({ vol = 0.01, reversionSpeed = 0.3, dt = 1 } = {}) {
    super(null, 'Yield Curve Tick');
    this.vol                  = vol;             // annualized sd of the level (in rate units)
    this.reversionSpeed       = reversionSpeed;  // OU pull-back speed per year
    this.dt                   = dt;              // tick interval in years (annual)
    this.generatedActionTypes = ['YIELD_CURVE_STEP_APPLY'];
  }

  static fromJSON(d) {
    const h = new this({ vol: d.vol, reversionSpeed: d.reversionSpeed, dt: d.dt });
    h.id = d.id;
    return h;
  }

  toJSON() {
    return { ...super.toJSON(), vol: this.vol, reversionSpeed: this.reversionSpeed, dt: this.dt };
  }

  call({ sim, state }) {
    const step = FX_PROCESS_MODELS.MEAN_REVERTING;
    return COUNTRIES.map((cc) => {
      const prev = state.yieldCurveLevelDev?.[cc] ?? 0;
      const z    = gaussianFrom(sim.rng);
      const next = step(prev, { sigma: this.vol, dt: this.dt, k: this.reversionSpeed, z });
      return { type: 'YIELD_CURVE_STEP_APPLY', country: cc, deviation: next };
    });
  }
}
