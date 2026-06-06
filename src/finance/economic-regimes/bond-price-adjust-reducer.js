/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { Reducer, PRIORITY }  from '../../simulation-framework/reducers.js';
import { ALLOCATION }         from '../holdings/allocation.js';
import { RATE_KEY_META }      from './rate-keys.js';
import { _syncBalance }       from '../holdings/holding-reducers.js';

/**
 * BondPriceAdjustReducer — marks BOND-allocation holdings to market whenever
 * `state.effectiveInterestRates` changes (design 28 §5).
 *
 * Fires on every period-advance at PRE_PROCESS + 2 (12) — after RegimeApplyReducer
 * (PRE_PROCESS + 1 = 11) has written the new effective rates, before coupon-income
 * handlers compute earnings off the adjusted price.
 *
 * Algorithm per BOND holding:
 *   effDuration = holding.duration ?? RATE_KEY_META[holding.rateKey]?.defaultDuration ?? 0
 *   Δrate       = effectiveInterestRates[rateKey] - priorMarkRates[rateKey]
 *   Δprice      = -effDuration × Δrate × holding.marketValue
 *   marketValue = max(0, marketValue + Δprice)
 *
 * On the first period, priorMarkRates is empty so Δrate = 0 for all keys → no-op.
 * costBasis is not adjusted (mark-to-market only; design 28 §13 Q4).
 *
 * Maintains `state.priorMarkRates` as a snapshot of the effective rates AFTER
 * each mark application, ready for next period's Δ computation.
 */
export class BondPriceAdjustReducer extends Reducer {
  static type        = 'BondPriceAdjustReducer';
  static description = 'Marks BOND holdings to market using modified duration and the period-over-period interest-rate delta.';

  constructor() {
    super('Bond Price Adjust', PRIORITY.PRE_PROCESS + 2);
    this.reducedActionTypes = ['US_PERIOD_ADVANCE', 'AU_PERIOD_ADVANCE'];
  }

  reduce(state, _action) {
    const effectiveRates = state.effectiveInterestRates ?? {};
    const priorRates     = state.priorMarkRates         ?? {};

    const accountUpdates = {};

    for (const key of Object.keys(state)) {
      const account = state[key];
      if (!account || !Array.isArray(account.holdings) || account.holdings.length === 0) continue;

      const hasBond = account.holdings.some(h => h?.allocation === ALLOCATION.BOND);
      if (!hasBond) continue;

      let holdingsTouched = false;
      const nextHoldings = account.holdings.map(h => {
        if (!h || h.allocation !== ALLOCATION.BOND || !h.rateKey) return h;
        const effectiveDuration = h.duration ?? RATE_KEY_META[h.rateKey]?.defaultDuration ?? 0;
        if (effectiveDuration === 0) return h;
        const curRate  = effectiveRates[h.rateKey] ?? 0;
        const prevRate = priorRates[h.rateKey]     ?? curRate;
        const deltaRate = curRate - prevRate;
        if (deltaRate === 0) return h;
        const delta = +(-(effectiveDuration * deltaRate * (h.marketValue ?? 0))).toFixed(2);
        if (delta === 0) return h;
        holdingsTouched = true;
        return { ...h, marketValue: Math.max(0, (h.marketValue ?? 0) + delta) };
      });

      if (holdingsTouched) {
        accountUpdates[key] = _syncBalance({ ...account, holdings: nextHoldings });
      }
    }

    return this.newState(state, {
      ...accountUpdates,
      priorMarkRates: { ...effectiveRates },
    });
  }
}
