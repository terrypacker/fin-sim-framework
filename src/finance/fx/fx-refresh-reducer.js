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
 * Runs at PRE_PROCESS (10) on every US or AU period advance.
 *
 * Copies state.baseExchangeRates → state.effectiveExchangeRates and
 * state.baseFxFees → state.effectiveFxFees so that consumers always read
 * a consistent "effective" path regardless of whether the regime toolset
 * is loaded.
 *
 * When RegimeApplyReducer is present it runs at PRE_PROCESS + 1 (11) and
 * overwrites the effective fields with regime-composed values — this reducer
 * then acts as the first pass that the regime overwrites.
 */
export class FxRefreshReducer extends Reducer {
  static description = 'Mirrors baseExchangeRates → effectiveExchangeRates and baseFxFees → effectiveFxFees on each period advance; also syncs legacy flat fields.';
  static type        = 'FxRefreshReducer';

  constructor() {
    super('FX Refresh', PRIORITY.PRE_PROCESS);
    this.reducedActionTypes   = ['US_PERIOD_ADVANCE', 'AU_PERIOD_ADVANCE'];
    this.generatedActionTypes = [];
  }

  static fromJSON(d) {
    const r = new this();
    r.id = d.id;
    return r;
  }

  reduce(state, _action, _date) {
    if (!state.baseExchangeRates && !state.baseFxFees) return this.newState(state);

    const effectiveRates = { ...(state.baseExchangeRates ?? {}) };
    const effectiveFees  = { ...(state.baseFxFees        ?? {}) };

    return this.newState(state, {
      effectiveExchangeRates: effectiveRates,
      effectiveFxFees:        effectiveFees,
    });
  }
}
