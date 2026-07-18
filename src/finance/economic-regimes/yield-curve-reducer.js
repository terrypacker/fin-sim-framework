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
import { composeYieldCurve } from './yield-curve.js';
import { RATE_KEYS }         from './rate-keys.js';

const COUNTRIES = ['US', 'AU'];
const FIXED_INCOME_KEY = { US: RATE_KEYS.FIXED_INCOME_US, AU: RATE_KEYS.FIXED_INCOME_AU };

/**
 * YieldCurveReducer — propagates curve DYNAMICS each period (design 67 §6, Phase 3):
 *
 *  1. **Shape twists.** Rebuilds `state.yieldCurve[country]` = `baseYieldCurve[country]`
 *     plus the sum of every active regime's `yieldCurveTwist[country]`, each scaled by
 *     that regime's `currentFactor` (the recovery-curve weight RegimeApplyReducer has
 *     already stamped onto `state.activeRegimes`). So a scheduled twist or a named curve
 *     shock (bear-flattener / bull-steepener / inversion) *composes* with the level move
 *     and fades on its recovery profile — exactly the design-56 base+overlay pattern.
 *
 *  2. **Stochastic level.** When stochastic evolution is on, folds the mean-reverting
 *     level deviation `state.yieldCurveLevelDev[country]` (walked by YieldCurveTickHandler
 *     from the seeded sim.rng) onto `effectiveInterestRates[FIXED_INCOME_{country}]` and
 *     its per-account `<key>::<stateKey>` variants — a parallel shift of the whole curve.
 *
 * Priority PRE_PROCESS + 1.5 (11.5): strictly AFTER RegimeApplyReducer (11), which owns
 * the `activeRegimes` rebuild + `currentFactor` and the base→effective level reset, and
 * strictly BEFORE BondPriceAdjustReducer (12), which reads the composed `yieldCurve` and
 * the folded level to mark bonds. On the same action types as RegimeApplyReducer so it
 * recomposes whenever the regime stack changes.
 *
 * **No-op guard.** With no active twist and a zero level deviation the reducer returns
 * state unchanged — `yieldCurve` stays as seeded (== baseYieldCurve) and the level is
 * untouched — so a run with no curve dynamics is byte-for-byte identical to Phase 2.
 */
export class YieldCurveReducer extends Reducer {
  static type        = 'YieldCurveReducer';
  static description = 'Recomposes state.yieldCurve from baseYieldCurve + active-regime twists (scaled by recovery factor) and folds the stochastic level deviation onto the effective fixed-income level each period (design 67 §6).';

  constructor() {
    super('Yield Curve', PRIORITY.PRE_PROCESS + 1.5);
    this.reducedActionTypes = [
      'US_PERIOD_ADVANCE', 'AU_PERIOD_ADVANCE',
      'ADD_REGIME_APPLY', 'REMOVE_REGIME_APPLY',
      'RECOMPUTE_REGIMES',
    ];
  }

  reduce(state, _action, _date) {
    const base = state.baseYieldCurve;
    if (!base) return this.newState(state);

    // (1) Compose the shape: base + Σ active-regime twists (× currentFactor).
    const twistsByCC = { US: [], AU: [] };
    let hasTwist = false;
    for (const regime of state.activeRegimes ?? []) {
      const twist = regime?.yieldCurveTwist;
      if (!twist) continue;
      const factor = regime.currentFactor ?? 1;
      if (factor === 0) continue;
      for (const cc of COUNTRIES) {
        if (Array.isArray(twist[cc]) && twist[cc].length > 0) {
          twistsByCC[cc].push({ points: twist[cc], factor });
          hasTwist = true;
        }
      }
    }

    // (2) Stochastic level deviation (0 when evolution is off).
    const levelDev = state.yieldCurveLevelDev ?? {};
    const hasLevelDev = COUNTRIES.some(cc => (levelDev[cc] ?? 0) !== 0);

    if (!hasTwist && !hasLevelDev) return this.newState(state);   // no dynamics ⇒ no-op

    const patch = {};

    if (hasTwist) {
      const nextCurve = { ...(state.yieldCurve ?? {}) };
      for (const cc of COUNTRIES) {
        nextCurve[cc] = composeYieldCurve(base[cc], twistsByCC[cc]);
      }
      patch.yieldCurve = nextCurve;
    }

    if (hasLevelDev) {
      const eff = state.effectiveInterestRates ?? {};
      const nextEff = { ...eff };
      for (const cc of COUNTRIES) {
        const dev = levelDev[cc] ?? 0;
        if (dev === 0) continue;
        const key = FIXED_INCOME_KEY[cc];
        if (nextEff[key] != null) nextEff[key] = nextEff[key] + dev;
        // Sweep per-account `<key>::<stateKey>` variants so individual bonds priced off
        // their own rate also see the parallel shift (cf. RegimeApply's class fan-out).
        const prefix = key + '::';
        for (const k of Object.keys(eff)) {
          if (k.startsWith(prefix)) nextEff[k] = eff[k] + dev;
        }
      }
      patch.effectiveInterestRates = nextEff;
    }

    return this.newState(state, patch);
  }
}
