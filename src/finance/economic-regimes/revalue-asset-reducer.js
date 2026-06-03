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
 * RevalueAssetReducer — applies a multiplier to the balance (Account) or
 * value (RealProperty / Collectible) of targeted state keys.
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
  static description = 'Applies the shock multiplier to balance or value of each targeted state key.';

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

      if (entry.balance != null) {
        const drop = +(entry.balance * multiplier).toFixed(2);
        updates[key] = { ...entry, balance: Math.max(0, entry.balance + drop) };
      } else if (entry.value != null) {
        const drop = +(entry.value * multiplier).toFixed(2);
        updates[key] = { ...entry, value: Math.max(0, entry.value + drop) };
      }
    }

    return this.newState(state, updates);
  }
}
