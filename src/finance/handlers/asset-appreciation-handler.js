/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { HandlerEntry }          from '../../simulation-framework/handlers.js';
import { Reducer, PRIORITY }     from '../../simulation-framework/reducers.js';
import { resolveScheduledRate }  from '../holdings/appreciation-schedule-utils.js';

/**
 * AssetAppreciationHandler — fired annually to grow standalone RealProperty and
 * Collectible asset values (design 28 §3, Step 4b).
 *
 * Each asset's effective rate is `resolveScheduledRate(asset.appreciationSchedule,
 * date, asset.appreciationRate)`. When no schedule is set and appreciationRate is 0
 * the delta is 0 and no action is emitted (no-op, backward-compatible).
 *
 * @param {object} opts
 * @param {Array<{stateKey: string, appreciationRate: number, appreciationSchedule: Array|null}>} opts.assets
 *   Projection of real-property and collectible fields needed at runtime.
 */
export class AssetAppreciationHandler extends HandlerEntry {
  static type      = 'AssetAppreciationHandler';
  static eventType = 'ASSET_APPRECIATE';
  static description = 'Grows RealProperty / Collectible value annually via appreciationRate or appreciationSchedule.';

  constructor(opts = {}) {
    super(null, 'Asset Appreciation');
    this.assets = (opts != null ? opts.assets : null) ?? [];
    this.generatedActionTypes = ['ASSET_APPRECIATE_APPLY'];
  }

  static fromJSON(d, _ctx) {
    const h = new AssetAppreciationHandler({ assets: [] });
    h.id = d.id;
    h.name = d.name ?? 'Asset Appreciation';
    return h;
  }

  call({ state, date }) {
    const currentDate = date ?? new Date();
    const actions     = [];
    for (const asset of this.assets) {
      const entry = state?.[asset.stateKey];
      if (!entry) continue;
      const value = entry.value ?? 0;
      const rate  = resolveScheduledRate(asset.appreciationSchedule, currentDate, asset.appreciationRate ?? 0);
      // Stochastic property return path (design 75 §4.2 A2): add the per-sleeve market
      // deviation + drift compensation to the deterministic rate. `reKey` is set only for
      // real property (REAL_ESTATE_US/AU); collectibles have no reKey and stay deterministic.
      // Absent maps (flag off) ⇒ dev 0, so the delta and golden are byte-identical.
      const dev = asset.reKey
        ? (state.propertyReturnDev?.[asset.reKey] ?? 0) + (state.propertyReturnDriftComp?.[asset.reKey] ?? 0)
        : 0;
      const delta = +(value * (rate + dev)).toFixed(2);
      if (delta === 0) continue;
      actions.push({
        type:     'ASSET_APPRECIATE_APPLY',
        stateKey: asset.stateKey,
        delta,
      });
    }
    return actions;
  }
}

/**
 * AssetAppreciateReducer — applies an appreciation delta to `state[stateKey].value`.
 * Clamps at 0; does not touch costBasis (mark-to-market only).
 */
export class AssetAppreciateReducer extends Reducer {
  static type        = 'AssetAppreciateReducer';
  static description = 'Applies annual appreciation delta to a RealProperty or Collectible state value.';

  constructor() {
    super('Asset Appreciate', PRIORITY.POSITION_UPDATE);
    this.reducedActionTypes = ['ASSET_APPRECIATE_APPLY'];
  }

  reduce(state, action) {
    const { stateKey, delta } = action;
    if (!stateKey || delta == null) return this.newState(state);
    const entry = state[stateKey];
    if (!entry || entry.value == null) return this.newState(state);
    return this.newState(state, {
      [stateKey]: { ...entry, value: Math.max(0, (entry.value ?? 0) + delta) },
    });
  }
}
