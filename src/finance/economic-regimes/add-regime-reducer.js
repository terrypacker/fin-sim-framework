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
 * AddRegimeReducer — appends an EconomicRegime to state.activeRegimes.
 *
 * Runs at CASH_FLOW (20) so that RegimeApplyReducer (PRE_PROCESS+1) can
 * recompute effective rates in the subsequent RECOMPUTE_REGIMES action that
 * EconomicShockHandler emits immediately after ADD_REGIME_APPLY.
 */
export class AddRegimeReducer extends Reducer {
  static type        = 'AddRegimeReducer';
  static description = 'Appends the incoming EconomicRegime to state.activeRegimes.';

  constructor() {
    super('Add Regime', PRIORITY.CASH_FLOW);
    this.reducedActionTypes = ['ADD_REGIME_APPLY'];
  }

  reduce(state, action) {
    const regime = action.regime;
    if (!regime) return this.newState(state);
    return this.newState(state, {
      activeRegimes: [...(state.activeRegimes ?? []), regime],
    });
  }
}
