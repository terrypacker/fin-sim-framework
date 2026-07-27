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
 * PrimeRelinkReducer — propagates a time-varying Prime move onto every
 * Prime-linked cash account each period (design 56 §5, Phase 2b).
 *
 * The static problem (design 56 §13): `seedPerAccountRates` bakes
 * `SAVINGS_*::<stateKey> = Prime_seed + spread` into `baseInterestRates` **once at
 * compile**. `RegimeApplyReducer` then rebuilds `effectiveInterestRates` from that base
 * every period and fans class-level interest shocks onto the per-account keys — but a
 * `PRIME_US`/`PRIME_AU` regime adjustment only moves `effectiveInterestRates[PRIME_*]`,
 * which no runtime handler reads. So a schedule/shock that hikes Prime mid-run never
 * reaches the cash accounts. This reducer closes that gap.
 *
 * For each link in `state.primeLinks` (`{ stateKey, savKey, primeKey, spread }`, seeded
 * by the ECONOMIC_REGIMES toolset), it adds the runtime **Prime delta** —
 * `effective[primeKey] − base[primeKey]`, i.e. the accumulated Prime regime movement —
 * onto the per-account cash key `effective[savKey::stateKey]`. Using the delta (rather
 * than overwriting with `Prime + spread`) preserves both the baked-in spread and any
 * SAVINGS-class market shock `RegimeApplyReducer` already fanned onto the same key, so a
 * Prime move and a separate savings-market shock **compose** (design 56 §5). When Prime
 * has not moved (delta 0) the pass is a no-op, keeping non-time-varying runs
 * byte-for-byte identical to Phase 1.
 *
 * Priority PRE_PROCESS + 2 (12) — strictly after RegimeApplyReducer (11), which owns the
 * base→effective rebuild, and on the same action types so it re-derives whenever the
 * effective map is recomputed.
 */
export class PrimeRelinkReducer extends Reducer {
  static type        = 'PrimeRelinkReducer';
  static description = 'Adds the runtime Prime delta (effective − base) onto every Prime-linked cash account key each period, so a time-varying Prime reaches cash accounts (design 56 §5).';

  constructor() {
    super('Prime Relink', PRIORITY.PRE_PROCESS + 2);
    this.reducedActionTypes = [
      'US_PERIOD_ADVANCE', 'AU_PERIOD_ADVANCE',
      'ADD_REGIME_APPLY', 'REMOVE_REGIME_APPLY',
      'RECOMPUTE_REGIMES',
    ];
  }

  reduce(state, _action, _date) {
    const links = state.primeLinks;
    const eff   = state.effectiveInterestRates;
    const base  = state.baseInterestRates;
    if (!links?.length || !eff || !base) return this.newState(state);

    let next    = eff;
    let changed = false;
    for (const { stateKey, savKey, primeKey } of links) {
      const primeEff  = eff[primeKey];
      const primeBase = base[primeKey];
      if (primeEff == null || primeBase == null) continue;
      const delta = primeEff - primeBase;
      if (delta === 0) continue;                 // Prime hasn't moved → no-op
      const perKey = `${savKey}::${stateKey}`;
      if (eff[perKey] == null) continue;         // account not seeded (defensive)
      if (!changed) { next = { ...eff }; changed = true; }
      next[perKey] = eff[perKey] + delta;
    }

    if (!changed) return this.newState(state);
    return this.newState(state, { effectiveInterestRates: next });
  }
}
