/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { Reducer, PRIORITY } from '../../simulation-framework/reducers.js';

/**
 * PropertyReturnStepReducer — stores the stochastic real-property deviations from a
 * PROPERTY_RETURN_STEP_APPLY action (design 75 §4). The pure counterpart to
 * PropertyReturnTickHandler: the handler owns the seeded-RNG draws, this reducer records the
 * results into `state.propertyReturnDev[<sleeve>]` (the per-sleeve mean-0 deviation),
 * `state.propertyReturnDriftComp[<sleeve>]` (the deterministic σ²/2 volatility-drag
 * compensation, 0 under NONE), and `state.propertyReturnMarketDev` (the market factor — used
 * as the OU `prev` on the next tick only in standalone mode; when the equity path is shared
 * it is stored but never read).
 *
 * Unlike the equity path there is NO fold reducer: property appreciation does not flow
 * through effectiveGrowthRates. AssetAppreciationHandler reads propertyReturnDev directly and
 * adds `deviation + driftComp` to each property's resolved appreciation rate (design 75 §4.2
 * A2). Priority CASH_FLOW (20), matching the FX / yield-curve / equity step reducers.
 */
export class PropertyReturnStepReducer extends Reducer {
  static type        = 'PropertyReturnStepReducer';
  static description = 'Stores the stochastic per-sleeve real-property deviations, drift compensation and market factor from a PROPERTY_RETURN_STEP_APPLY action into state.propertyReturnDev / state.propertyReturnDriftComp / state.propertyReturnMarketDev (design 75 §4).';

  constructor() {
    super('Property Return Step', PRIORITY.CASH_FLOW);
    this.reducedActionTypes = ['PROPERTY_RETURN_STEP_APPLY'];
  }

  reduce(state, action) {
    if (action?.deviation == null) return this.newState(state);
    return this.newState(state, {
      propertyReturnDev:       { ...action.deviation },
      propertyReturnDriftComp: { ...(action.driftComp ?? {}) },
      propertyReturnMarketDev: action.marketDev ?? 0,
    });
  }
}
