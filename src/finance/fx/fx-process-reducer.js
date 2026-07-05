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
 * FxProcessReducer — composes the final effective rate from the deterministic
 * anchor and the stochastic deviation (design 47 §3, §6.4):
 *
 *     effectiveExchangeRates[pair] = anchor[pair] × exp(fxDeviation[pair])
 *
 * Runs at PRIORITY.PRE_PROCESS + 2 (12), after FxRefreshReducer (10) and
 * RegimeApplyReducer (11) have written the anchor into effectiveExchangeRates.
 *
 * The pristine anchor is captured into state.fxAnchorRates on every action that
 * (re)writes it — the period advances (FxRefreshReducer/RegimeApplyReducer at
 * priority 10/11) AND the regime-recompute events (RegimeApplyReducer rewrites
 * effectiveExchangeRates = base + drift on ADD/REMOVE/RECOMPUTE). Because US/AU
 * period advances are annual (US Jan 1, AU Jul 1) but regimes decay monthly via
 * RECOMPUTE_REGIMES recovery ticks, listening to the regime events is required
 * for the drift to track the recovery curve instead of lagging to the next
 * fiscal boundary. On a mid-period FX_STEP_APPLY (when effectiveExchangeRates
 * already holds a composed value) the stored fxAnchorRates is read back, so
 * composition stays idempotent and order-independent.
 *
 * With the NONE process model, fxDeviation stays 0, exp(0) === 1, and the rate
 * is left exactly at its anchor — bit-for-bit identical to today.
 */
export class FxProcessReducer extends Reducer {
  static description = 'Composes effectiveExchangeRates = anchor × exp(fxDeviation); recaptures the pristine anchor into fxAnchorRates on every period advance and regime recompute.';
  static type        = 'FxProcessReducer';

  constructor() {
    super('FX Process', PRIORITY.PRE_PROCESS + 2);
    this.reducedActionTypes   = [
      'US_PERIOD_ADVANCE', 'AU_PERIOD_ADVANCE',
      'ADD_REGIME_APPLY', 'REMOVE_REGIME_APPLY', 'RECOMPUTE_REGIMES',
      'FX_STEP_APPLY',
    ];
    this.generatedActionTypes = [];
  }

  static fromJSON(d) {
    const r = new this();
    r.id = d.id;
    return r;
  }

  toJSON() {
    return { ...super.toJSON() };
  }

  reduce(state, action) {
    if (!state.effectiveExchangeRates) return this.newState(state);

    // Every trigger except FX_STEP_APPLY runs immediately after FxRefreshReducer
    // (10) / RegimeApplyReducer (11) have (re)written effectiveExchangeRates to
    // the pristine anchor (base + regime drift), so it IS the anchor and we
    // recapture it. On FX_STEP_APPLY it holds a previously-composed value, so we
    // read the stored anchor instead — avoiding a double exp(dev).
    const anchorIsFresh = action.type !== 'FX_STEP_APPLY';

    const anchor = anchorIsFresh
      ? { ...state.effectiveExchangeRates }
      : { ...(state.fxAnchorRates ?? state.effectiveExchangeRates) };

    const deviations = state.fxDeviation ?? {};
    const composed   = {};
    for (const [pair, a] of Object.entries(anchor)) {
      composed[pair] = a * Math.exp(deviations[pair] ?? 0);
    }

    const patch = { effectiveExchangeRates: composed };
    if (anchorIsFresh) patch.fxAnchorRates = anchor;
    return this.newState(state, patch);
  }
}
