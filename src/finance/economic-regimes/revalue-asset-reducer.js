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
 * RevalueAssetReducer — applies a multiplier to the marketValue of every
 * holding under each targeted state key (Account), or to the scalar `value`
 * of asset-level state entries (RealProperty / Collectible — design 25 §5.3
 * keeps these scalar until design 28).
 *
 * For Accounts: post-design-25, balance is denormalized from Σ holdings, so
 * shocking balance directly would be wiped out the next time a holdings
 * reducer re-syncs. Instead we apply the multiplier to every holding's
 * marketValue and re-sync balance from Σ holdings — the §4.4 invariant.
 *
 * Action fields:
 *   - targetStateKeys: string[]  — state keys to revalue
 *   - multiplier: number         — e.g. -0.40 to drop 40%
 *
 * Runs at POSITION_UPDATE (30) so it executes after the regime is pushed and
 * after any cash-flow actions from the same handler batch.
 */
export class RevalueAssetReducer extends Reducer {
  static type        = 'RevalueAssetReducer';
  static description = 'Applies the shock multiplier to every holding\'s marketValue (Account) or to the scalar value (RealProperty/Collectible), and re-syncs account.balance.';

  constructor() {
    super('Revalue Asset', PRIORITY.POSITION_UPDATE);
    this.reducedActionTypes = ['REVALUE_ASSET_APPLY'];
  }

  reduce(state, action) {
    const { targetStateKeys, multiplier } = action;
    if (!targetStateKeys?.length || multiplier == null) return this.newState(state);

    const updates = {};
    for (const key of targetStateKeys) {
      const entry = state[key];
      if (!entry) continue;

      if (Array.isArray(entry.holdings) && entry.holdings.length > 0) {
        // Account with holdings — shock every holding's marketValue and
        // re-sync balance from Σ. Each holding clamps at zero.
        const nextHoldings = entry.holdings.map(h => {
          if (!h) return h;
          const drop = +((h.marketValue ?? 0) * multiplier).toFixed(2);
          return { ...h, marketValue: Math.max(0, (h.marketValue ?? 0) + drop) };
        });
        const nextBalance = +nextHoldings.reduce((s, h) => s + (h?.marketValue ?? 0), 0).toFixed(2);
        updates[key] = { ...entry, holdings: nextHoldings, balance: nextBalance };
      } else if (entry.balance != null) {
        // Account without holdings (degenerate): preserve legacy behavior.
        const drop = +(entry.balance * multiplier).toFixed(2);
        updates[key] = { ...entry, balance: Math.max(0, entry.balance + drop) };
      } else if (entry.value != null) {
        // Asset-level (RealProperty / Collectible) — scalar value.
        const drop = +(entry.value * multiplier).toFixed(2);
        updates[key] = { ...entry, value: Math.max(0, entry.value + drop) };
      }
    }

    return this.newState(state, updates);
  }
}
