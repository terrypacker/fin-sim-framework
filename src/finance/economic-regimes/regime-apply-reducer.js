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
import { RecoveryCurves }    from './recovery-curves.js';

/**
 * Computes months elapsed between two Dates (fractional, positive = forward).
 */
function monthsBetween(start, end) {
  const years  = end.getUTCFullYear()  - start.getUTCFullYear();
  const months = end.getUTCMonth()     - start.getUTCMonth();
  const days   = (end.getUTCDate()     - start.getUTCDate()) / 31;
  return years * 12 + months + days;
}

/**
 * RegimeApplyReducer — runs on every period-advance and every regime
 * mutation action. It:
 *
 *  1. Computes the current recovery factor for each active regime.
 *  2. Drops fully-recovered regimes from state.activeRegimes.
 *  3. Sums scaled adjustments into state.effective*Rates.
 *
 * Priority: PRE_PROCESS + 1 (11) — after PeriodAdvanceReducer (10),
 * before InflationAdjustReducer (12, Phase 2).
 */
export class RegimeApplyReducer extends Reducer {
  static type        = 'RegimeApplyReducer';
  static description = 'Recomputes state.effective*Rates from state.activeRegimes and the current recovery factor for each regime.';

  constructor() {
    super('Regime Apply', PRIORITY.PRE_PROCESS + 1);
    this.reducedActionTypes = [
      'US_PERIOD_ADVANCE', 'AU_PERIOD_ADVANCE',
      'ADD_REGIME_APPLY', 'REMOVE_REGIME_APPLY',
      'RECOMPUTE_REGIMES',
    ];
  }

  reduce(state, action, currentDate) {
    const now  = currentDate ?? action.date ?? new Date();
    const live = [];

    for (const regime of state.activeRegimes ?? []) {
      const start   = regime.startDate instanceof Date ? regime.startDate : new Date(regime.startDate);
      const end     = regime.endDate   instanceof Date ? regime.endDate   : (regime.endDate ? new Date(regime.endDate) : null);
      const t       = monthsBetween(start, now);
      const curve   = RecoveryCurves[regime.recoveryProfile] ?? RecoveryCurves.V;
      const factor  = curve(t, regime.durationMonths);

      if (factor <= 0 && end && now >= end) continue;
      live.push({ ...regime, currentFactor: factor });
    }

    const effective = {
      effectiveGrowthRates:        { ...(state.baseGrowthRates ?? {}) },
      effectiveInterestRates:      { ...(state.baseInterestRates ?? {}) },
      effectiveInflationRates:     { ...(state.baseInflationRates ?? state.inflationRates ?? {}) },
      effectiveAppreciationRates:  { ...(state.baseAppreciationRates ?? {}) },
      effectiveDividendAdjustments:{},
      ...(state.baseExchangeRates && { effectiveExchangeRates: { ...state.baseExchangeRates } }),
      ...(state.baseFxFees        && { effectiveFxFees:        { ...state.baseFxFees } }),
    };

    for (const r of live) {
      _addScaled(effective.effectiveGrowthRates,        r.returnAdjustment,       r.currentFactor);
      _addScaled(effective.effectiveInterestRates,      r.interestRateAdjustment, r.currentFactor);
      _addScaled(effective.effectiveInflationRates,     r.inflationAdjustment,    r.currentFactor);
      _addScaled(effective.effectiveAppreciationRates,  r.appreciationAdjustment, r.currentFactor);
      _addScaled(effective.effectiveDividendAdjustments,r.dividendAdjustment,     r.currentFactor);
      if (effective.effectiveExchangeRates) {
        _addScaled(effective.effectiveExchangeRates, r.fxAdjustment, r.currentFactor);
      }
    }

    return this.newState(state, { activeRegimes: live, ...effective });
  }
}

function _addScaled(target, source, factor) {
  if (!source) return;
  for (const [k, v] of Object.entries(source)) {
    target[k] = (target[k] ?? 0) + v * factor;
  }
}
