/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { Reducer, PRIORITY }    from '../../simulation-framework/reducers.js';
import { PRIME_KEY_BY_COUNTRY } from './rate-keys.js';

/**
 * InflationPathReducer — folds the stochastic inflation deviation onto
 * `effectiveInflationRates` each period (design 103 §4.2), and, with the prime-rate link on,
 * the policy rate's response onto `effectiveInterestRates[PRIME_*]` (design 104). The
 * inflation analogue of EquityReturnReducer and YieldCurveReducer.
 *
 * Priority PRE_PROCESS + 1.5: strictly AFTER RegimeApplyReducer (+1), which resets both
 * effective maps from their bases and adds any regime's adjustments, and strictly BEFORE
 * InflationAdjustReducer and PrimeRelinkReducer (+2). The first compounds the accumulators
 * from the effective inflation rate; the second fans the prime move onto every prime-linked
 * cash account. Variable loans read the effective prime live. So the path composes on top
 * of a regime, and every consumer follows it: expenses, wages, Social Security, bracket
 * projection, the CPI index, TIPS accretion and house running costs, then cash accounts and
 * mortgages through prime. The trigger list is RegimeApplyReducer's, so each fold is
 * re-applied to a freshly reset rate and never accumulates.
 *
 * Floors: inflation at `state.inflationFloor` (design 103 §8 Q3); each country's prime at
 * `state.primeFloor[cc]` (design 104), the policy rate's effective zero. A floor applies
 * only where a deviation is folded, so a run without the link keeps its prime untouched.
 *
 * **No-op guard.** With no stored deviation the reducer returns state unchanged, so a run
 * with the path off is byte-identical. (YieldCurveReducer shares the +1.5 slot and also
 * writes `effectiveInterestRates`, but only its FIXED_INCOME keys, so the order between
 * the two doesn't matter.)
 */
export class InflationPathReducer extends Reducer {
  static type        = 'InflationPathReducer';
  static description = 'Folds the stochastic inflation deviation onto effectiveInflationRates, and the prime-rate link\'s deviation onto effectiveInterestRates[PRIME_*], each clamped at its floor (designs 103 §4.2, 104).';

  constructor() {
    super('Inflation Path', PRIORITY.PRE_PROCESS + 1.5);
    this.reducedActionTypes = [
      'US_PERIOD_ADVANCE', 'AU_PERIOD_ADVANCE',
      'ADD_REGIME_APPLY', 'REMOVE_REGIME_APPLY',
      'RECOMPUTE_REGIMES',
    ];
  }

  reduce(state) {
    const dev = state.inflationDev;
    if (!dev) return this.newState(state);
    const patch = {};

    const eff   = state.effectiveInflationRates ?? {};
    const floor = state.inflationFloor ?? -Infinity;
    const next  = { ...eff };
    let changed = false;
    for (const cc of Object.keys(dev)) {
      const d = dev[cc] ?? 0;
      if (d === 0 || eff[cc] == null) continue;
      next[cc] = Math.max(floor, eff[cc] + d);
      changed  = true;
    }
    if (changed) patch.effectiveInflationRates = next;

    // Design 104: the prime rate's response to the inflation path.
    const pdev = state.primeDev;
    if (pdev) {
      const ir     = state.effectiveInterestRates ?? {};
      const nextIr = { ...ir };
      let movedIr  = false;
      for (const cc of Object.keys(pdev)) {
        const key = PRIME_KEY_BY_COUNTRY[cc];
        const d   = pdev[cc] ?? 0;
        if (!key || d === 0 || ir[key] == null) continue;
        nextIr[key] = Math.max(state.primeFloor?.[cc] ?? -Infinity, ir[key] + d);
        movedIr = true;
      }
      if (movedIr) patch.effectiveInterestRates = nextIr;
    }

    return Object.keys(patch).length ? this.newState(state, patch) : this.newState(state);
  }
}
