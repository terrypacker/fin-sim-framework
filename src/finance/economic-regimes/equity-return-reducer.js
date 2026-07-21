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
import { EQUITY_SLEEVES }    from './rate-keys.js';

/**
 * EquityReturnReducer — folds the stochastic equity RETURN PATH onto effective growth
 * rates each period (design 74 §5.1). Direct structural analogue of YieldCurveReducer:
 * where that folds `yieldCurveLevelDev` onto `effectiveInterestRates`, this folds the
 * per-sleeve `state.equityReturnDev[<sleeve>]` (walked by EquityReturnTickHandler from
 * the seeded sim.rng) onto `effectiveGrowthRates[<sleeve>]` and its per-account
 * `<sleeve>::<stateKey>` variants (design 55 §8) — so each equity account sees the
 * year's market shock on top of its own baseline.
 *
 * Priority PRE_PROCESS + 1.5 (11.5): strictly AFTER RegimeApplyReducer (11), which owns
 * the base→effective growth-rate reset and fans regime shocks onto the member keys, so
 * the stochastic term composes ON TOP of the regime-adjusted anchor (a scheduled crash
 * and a stochastic path apply once each — design 74 §6 test 8). It touches
 * `effectiveGrowthRates` only, disjoint from YieldCurveReducer's `effectiveInterestRates`,
 * so their shared priority slot is order-independent.
 *
 * **No-op guard.** With no stored deviation (or all-zero), returns state unchanged —
 * growth rates stay exactly as RegimeApplyReducer left them — so a run with the flag off
 * is byte-for-byte identical (design 74 §3, §6 test 1).
 */
export class EquityReturnReducer extends Reducer {
  static type        = 'EquityReturnReducer';
  static description = 'Folds the stochastic per-sleeve equity deviation onto effectiveGrowthRates (and its per-account variants) each period (design 74 §5.1).';

  constructor() {
    super('Equity Return', PRIORITY.PRE_PROCESS + 1.5);
    this.reducedActionTypes = [
      'US_PERIOD_ADVANCE', 'AU_PERIOD_ADVANCE',
      'ADD_REGIME_APPLY', 'REMOVE_REGIME_APPLY',
      'RECOMPUTE_REGIMES',
    ];
  }

  reduce(state, _action, _date) {
    const dev = state.equityReturnDev;
    if (!dev) return this.newState(state);
    const hasDev = EQUITY_SLEEVES.some(k => (dev[k] ?? 0) !== 0);
    if (!hasDev) return this.newState(state);   // no path ⇒ no-op

    const eff     = state.effectiveGrowthRates ?? {};
    const nextEff = { ...eff };
    for (const sleeve of EQUITY_SLEEVES) {
      const d = dev[sleeve] ?? 0;
      if (d === 0) continue;
      if (nextEff[sleeve] != null) nextEff[sleeve] = nextEff[sleeve] + d;
      // Sweep per-account `<sleeve>::<stateKey>` variants so each account priced off its
      // own seeded rate also sees the shock (cf. RegimeApply's class fan-out, design 55 §8).
      const prefix = sleeve + '::';
      for (const k of Object.keys(eff)) {
        if (k.startsWith(prefix)) nextEff[k] = eff[k] + d;
      }
    }
    return this.newState(state, { effectiveGrowthRates: nextEff });
  }
}
