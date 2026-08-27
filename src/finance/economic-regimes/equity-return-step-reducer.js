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
 * EquityReturnStepReducer — stores the stochastic equity deviations from an
 * EQUITY_RETURN_STEP_APPLY action (design 74 §5.1). The pure counterpart to
 * EquityReturnTickHandler: the handler owns the seeded-RNG draws, this reducer just
 * records the results into `state.equityReturnDev[<sleeve>]` (the per-sleeve mean-0
 * deviation), `state.equityReturnDriftComp[<sleeve>]` (the deterministic σ²/2 volatility-
 * drag compensation, 0 under NONE — design 74 §5.3), and `state.equityReturnMarketDev`
 * (the shared market factor, so a MEAN_REVERTING process can walk it next tick).
 * EquityReturnReducer then folds `deviation + driftComp` onto the effective growth rates.
 * Priority CASH_FLOW (20),
 * matching the FX / yield-curve step reducers — after the pre-process rate rebuild, so
 * the deviation is picked up on the next period's EquityReturnReducer pass.
 */
export class EquityReturnStepReducer extends Reducer {
  static type        = 'EquityReturnStepReducer';
  static description = 'Stores the stochastic equity per-sleeve deviations, drift compensation and market factor from an EQUITY_RETURN_STEP_APPLY action into state.equityReturnDev / state.equityReturnDriftComp / state.equityReturnMarketDev (design 74 §5.1/§5.3).';

  constructor() {
    super('Equity Return Step', PRIORITY.CASH_FLOW);
    this.reducedActionTypes = ['EQUITY_RETURN_STEP_APPLY'];
  }

  reduce(state, action) {
    if (action?.deviation == null) return this.newState(state);
    const next = {
      equityReturnDev:       { ...action.deviation },
      equityReturnDriftComp: { ...(action.driftComp ?? {}) },
      equityReturnMarketDev: action.marketDev ?? 0,
    };
    // The per-security overlay (design 94 §6.2/§6.3), stored the same way and read the
    // same way property returns are — `computeHoldingsGrowth` adds it to the holding's
    // resolved rate DIRECTLY rather than folding it onto `effectiveGrowthRates`, so the
    // rates map keeps its shape and its two-deep precedence and no `<securityId>` fan-out
    // is created (design 75 §4.2 A2's precedent).
    //
    // The pair is written only when the handler sent it, i.e. only when the registry
    // carries a security that is not the β=1/σ=0 identity — so a scenario whose
    // securities are all identities gains NO state key at all. Both are replaced whole
    // each tick, which is what clears a security whose overlay evaluated to zero this year.
    if (action.securityDeviation != null) {
      next.securityReturnDev       = { ...action.securityDeviation };
      next.securityReturnDriftComp = { ...(action.securityDriftComp ?? {}) };
    }
    return this.newState(state, next);
  }
}
