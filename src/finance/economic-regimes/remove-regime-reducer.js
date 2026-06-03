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
 * RemoveRegimeReducer — removes an EconomicRegime from state.activeRegimes by ID.
 *
 * Runs at CASH_FLOW (20) alongside AddRegimeReducer. Typically followed by a
 * RECOMPUTE_REGIMES action so effective rates are refreshed on the same tick.
 */
export class RemoveRegimeReducer extends Reducer {
  static type        = 'RemoveRegimeReducer';
  static description = 'Removes the EconomicRegime with the given regimeId from state.activeRegimes.';

  constructor() {
    super('Remove Regime', PRIORITY.CASH_FLOW);
    this.reducedActionTypes = ['REMOVE_REGIME_APPLY'];
  }

  reduce(state, action) {
    const { regimeId } = action;
    if (!regimeId) return this.newState(state);
    return this.newState(state, {
      activeRegimes: (state.activeRegimes ?? []).filter(r => r.id !== regimeId),
    });
  }
}
