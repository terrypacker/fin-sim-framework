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
 * records the results into `state.equityReturnDev[<sleeve>]` (the per-sleeve applied
 * deviation) and `state.equityReturnMarketDev` (the shared market factor, so a
 * MEAN_REVERTING process can walk it next tick). EquityReturnReducer then folds the
 * per-sleeve deviations onto the effective growth rates. Priority CASH_FLOW (20),
 * matching the FX / yield-curve step reducers — after the pre-process rate rebuild, so
 * the deviation is picked up on the next period's EquityReturnReducer pass.
 */
export class EquityReturnStepReducer extends Reducer {
  static type        = 'EquityReturnStepReducer';
  static description = 'Stores the stochastic equity per-sleeve deviations and market factor from an EQUITY_RETURN_STEP_APPLY action into state.equityReturnDev / state.equityReturnMarketDev (design 74 §5.1).';

  constructor() {
    super('Equity Return Step', PRIORITY.CASH_FLOW);
    this.reducedActionTypes = ['EQUITY_RETURN_STEP_APPLY'];
  }

  reduce(state, action) {
    if (action?.deviation == null) return this.newState(state);
    return this.newState(state, {
      equityReturnDev:       { ...action.deviation },
      equityReturnMarketDev: action.marketDev ?? 0,
    });
  }
}
