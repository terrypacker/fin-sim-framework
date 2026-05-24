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
 * Handles ACCUMULATE_DEFICIT actions emitted by OutOfFundsHandler.
 *
 * Increments state.cumulativeDeficit by the deficit amount and increments
 * state.deficitMonths by 1, building a running total of how much money
 * was missing and for how many months.  These fields power Monte Carlo
 * failure-severity reporting via ScenarioRunner.summarize().
 */
export class AccumulateDeficitReducer extends Reducer {
  static description = 'Accumulates cumulativeDeficit and deficitMonths in state on each out-of-funds occurrence.';

  static actionType = 'ACCUMULATE_DEFICIT';

  constructor() {
    super('Accumulate Deficit', PRIORITY.PRE_PROCESS);
    this.reducedActionTypes = ['ACCUMULATE_DEFICIT'];
  }

  reduce(state, action) {
    return this.newState({
      ...state,
      cumulativeDeficit: (state.cumulativeDeficit ?? 0) + (action.amount ?? 0),
      deficitMonths:     (state.deficitMonths     ?? 0) + 1,
    });
  }
}
