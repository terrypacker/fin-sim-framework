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
 * OpportunisticRebalanceApplyReducer — applies within-account HOLDING_TRANSACT
 * pairs to move holdings toward target allocation (design/29 §3.5, §5).
 *
 * Action fields:
 *   stateKey  - account state key
 *   legs      - [{ allocation, delta }] — positive = buy more, negative = sell some
 *
 * For each leg, adjust holdings of that allocation proportionally:
 *   - If delta > 0: add to existing holdings of that allocation (pro-rata across them)
 *   - If delta < 0: reduce existing holdings of that allocation (pro-rata)
 *
 * The total value is conserved (positive deltas sum = negative deltas sum).
 * Balance is re-synced after all adjustments.
 */
export class OpportunisticRebalanceApplyReducer extends Reducer {
  static type        = 'OpportunisticRebalanceApplyReducer';
  static description = 'Within-account allocation rebalance: adjusts holding values proportionally per leg delta.';

  constructor() {
    super('Opportunistic Rebalance Apply', PRIORITY.POSITION_UPDATE);
    this.reducedActionTypes = ['OPPORTUNISTIC_REBALANCE_APPLY'];
  }

  reduce(state, action) {
    const { stateKey, legs } = action;
    const account = state[stateKey];
    if (!account || !Array.isArray(account.holdings)) return state;

    let holdings = [...account.holdings];

    for (const { allocation, delta } of legs) {
      if (Math.abs(delta) < 0.01) continue;

      const matching = holdings.filter(h => h.allocation === allocation);
      if (matching.length === 0) continue;

      const totalMv = matching.reduce((s, h) => s + (h?.marketValue ?? 0), 0);
      if (totalMv <= 0 && delta < 0) continue;

      // Distribute the delta pro-rata across matching holdings
      holdings = holdings.map(h => {
        if (h.allocation !== allocation) return h;
        const fraction = totalMv > 0 ? (h.marketValue / totalMv) : (1 / matching.length);
        const mv       = +(h.marketValue   + delta * fraction).toFixed(2);
        const basis    = delta > 0
          ? +((h.costBasis ?? 0) + delta * fraction).toFixed(2)  // buying: basis tracks market
          : +((h.costBasis ?? 0) * (mv / Math.max(h.marketValue, 0.001))).toFixed(2);  // selling: pro-rata basis
        if (mv < 0.001) return null;
        return { ...h, marketValue: mv, costBasis: basis };
      }).filter(Boolean);
    }

    const newBalance = +holdings.reduce((s, h) => s + (h?.marketValue ?? 0), 0).toFixed(2);

    return this.newState(state, {
      [stateKey]: { ...account, holdings, balance: newBalance },
    });
  }
}
