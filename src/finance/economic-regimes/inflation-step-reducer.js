/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { Reducer, PRIORITY }                     from '../../simulation-framework/reducers.js';
import { EQUITY_SLEEVES, EQUITY_SLEEVE_COUNTRY } from './rate-keys.js';

/**
 * InflationStepReducer — stores the stochastic inflation path from an INFLATION_STEP_APPLY
 * (design 103 §4.2). The pure counterpart to InflationTickHandler:
 *
 *   - `state.inflationDev[cc]` — each country's deviation from its anchor, which
 *     InflationPathReducer folds onto `effectiveInflationRates` and the next tick walks;
 *   - `state.inflationFloor` — the lowest effective rate the fold allows;
 *   - `state.equityInflationPassThrough[sleeve]` — only in joint mode: the deviation of
 *     the country each equity market is priced in, which EquityReturnReducer adds to that
 *     market's nominal return (design 103 §5.2);
 *   - `state.primeDev[cc]` / `state.primeFloor[cc]` — only with the prime-rate link
 *     (design 104): the policy rate's deviation from the prime setting, and its floor.
 *
 * Priority CASH_FLOW, matching the FX / yield-curve / equity step reducers: after the
 * pre-process rebuild, so the new deviation reaches the rates at the next period advance.
 */
export class InflationStepReducer extends Reducer {
  static type        = 'InflationStepReducer';
  static description = 'Stores the stochastic inflation deviation, its floor, (joint mode) the per-market nominal pass-through, and (prime link) the prime deviation and floor from an INFLATION_STEP_APPLY action (designs 103, 104).';

  constructor() {
    super('Inflation Step', PRIORITY.CASH_FLOW);
    this.reducedActionTypes = ['INFLATION_STEP_APPLY'];
  }

  reduce(state, action) {
    if (action?.deviation == null) return this.newState(state);
    const next = { inflationDev: { ...action.deviation } };
    // The global and per-country latent factors the next tick walks (design 103 §10).
    if (action.latent != null) next.inflationLatent = { ...action.latent };
    if (typeof action.floor === 'number') next.inflationFloor = action.floor;
    if (action.passThrough) {
      next.equityInflationPassThrough = Object.fromEntries(
        EQUITY_SLEEVES.map(s => [s, action.deviation[EQUITY_SLEEVE_COUNTRY[s]] ?? 0]));
    }
    if (action.primeDeviation != null) {
      next.primeDev   = { ...action.primeDeviation };
      next.primeFloor = { ...(action.primeFloor ?? {}) };
    }
    return this.newState(state, next);
  }
}
