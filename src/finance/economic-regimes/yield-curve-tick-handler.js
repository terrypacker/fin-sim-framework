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
import { HISTORICAL_JOINT_WINDOW, jointWindowIndex } from './inflation-tick-handler.js';

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

  constructor({ vol = 0.01, reversionSpeed = 0.3, historical = false, dt = 1, equityCorrelation = 0 } = {}) {
    super(null, 'Yield Curve Tick');
    this.vol                  = vol;             // annualized sd of the level (in rate units)
    this.reversionSpeed       = reversionSpeed;  // OU pull-back speed per year
    this.historical           = historical;      // joint mode: the equity bootstrap's year supplies the shock (design 103 §5.1)
    this.dt                   = dt;              // tick interval in years (annual)
    this.equityCorrelation    = equityCorrelation; // design 129: stock–bond ρ; 0 ⇒ today's independent draw
    this.generatedActionTypes = ['YIELD_CURVE_STEP_APPLY'];
  }

  static fromJSON(d) {
    const h = new this({ vol: d.vol, reversionSpeed: d.reversionSpeed, historical: d.historical, dt: d.dt, equityCorrelation: d.equityCorrelation ?? 0 });
    h.id = d.id;
    return h;
  }

  toJSON() {
    // `equityCorrelation` only when set, so a run without it serializes exactly as before.
    return { ...super.toJSON(), vol: this.vol, reversionSpeed: this.reversionSpeed, historical: this.historical, dt: this.dt,
      ...(this.equityCorrelation ? { equityCorrelation: this.equityCorrelation } : {}) };
  }

  call({ sim, state }) {
    // Design 107 §15.5 — draw from this process's OWN year-keyed substream, so an unrelated
    // process drawing more or fewer times cannot shift which year this value lands on. Falls
    // back to the shared cursor unless `useRngStreams` is on, so default runs are unchanged.
    const rng = sim.rngStream?.('yield', (sim.currentDate ?? new Date()).getUTCFullYear()) ?? sim.rng;

    const step = FX_PROCESS_MODELS.MEAN_REVERTING;
    // Design 103 §5.1 (B2): in joint mode the shock is the US 10-year yield change of the
    // historical year the equity bootstrap just replayed, re-centred and rescaled to `vol`,
    // so a 1970s year raises yields while it raises inflation. No RNG draw. There's no
    // AU 10-year series before 1969, so AU takes the same-year US change (a global-rates
    // assumption). No cursor, or a year outside 1951–, falls back to the Gaussian draw.
    const idx = this.historical ? jointWindowIndex(state.equityReturnBootstrap?.year) : -1;
    const shock = idx >= 0
      ? HISTORICAL_JOINT_WINDOW.gs10.shocks[idx] * (this.vol / HISTORICAL_JOINT_WINDOW.gs10.sd)
      : null;
    const zEq = shock == null ? this._marketShock(sim, state) : null;
    return COUNTRIES.map((cc) => {
      const prev = state.yieldCurveLevelDev?.[cc] ?? 0;
      const next = shock != null
        ? prev * Math.exp(-this.reversionSpeed * this.dt) + shock
        : step(prev, { sigma: this.vol, dt: this.dt, k: this.reversionSpeed, z: this._correlated(gaussianFrom(rng), zEq) });
      return { type: 'YIELD_CURVE_STEP_APPLY', country: cc, deviation: next };
    });
  }

  /**
   * Design 129 §3.1 — the yield innovation, correlated with the equity market shock:
   *
   *     z_yield = −ρ·z_eq + √(1 − ρ²)·ε
   *
   * −ρ because a bond's return is ≈ −D·Δy, so ρ is the STOCK–BOND correlation. ε is the draw
   * the tick has always taken, from the same stream in the same place, so the draw count is
   * unchanged and every other process sees the same numbers with ρ on or off. With no shock
   * (ρ = 0, or no stamp for this year) ε is returned as is, not as `0·z + 1·ε`.
   * @private
   */
  _correlated(eps, zEq) {
    if (zEq == null) return eps;
    const rho = this.equityCorrelation;
    return -rho * zEq + Math.sqrt(1 - rho * rho) * eps;
  }

  /**
   * Next year's standardized equity market shock (design 120 §5.4), or null when ρ is 0 or no
   * stamp labels next year. The equity tick on the same 31 Dec stamps `year + 1` and, with
   * correlation in play, fires first (`order: 3` on this series), so a missing stamp is a
   * guard rather than a path an in-play run takes (design 129 §3.3).
   * @private
   */
  _marketShock(sim, state) {
    if (!this.equityCorrelation) return null;
    const shock = state.equityMarketShock;
    const year  = (sim.currentDate ?? new Date()).getUTCFullYear() + 1;
    return shock?.year === year && Number.isFinite(shock.z) ? shock.z : null;
  }
}
