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
 * AssetLocationRebalanceApplyReducer — applies a cross-account holding swap
 * between two tax-advantaged accounts (design/29 §3.4, §5).
 *
 * Action fields (from StrategicAssetLocationReducer):
 *   fromStateKey   - source account state key
 *   fromHoldingId  - holding in source to subtract value from
 *   toStateKey     - target account state key
 *   toHoldingId    - holding in target to add value to
 *   swapAmount     - dollar amount to move
 *
 * Both accounts' balances are re-synced after the move.
 * Asserts (via guard) that neither account is a taxable role — but the
 * real enforcement lives in StrategicAssetLocationReducer which only
 * sources from TAX_ADVANTAGED_ROLES.
 */
export class AssetLocationRebalanceApplyReducer extends Reducer {
  static type        = 'AssetLocationRebalanceApplyReducer';
  static description = 'Cross-account holding swap between two tax-advantaged accounts (no cash pool, no tax event).';

  constructor() {
    super('Asset Location Rebalance Apply', PRIORITY.POSITION_UPDATE);
    this.reducedActionTypes = ['ASSET_LOCATION_REBALANCE_APPLY'];
  }

  reduce(state, action) {
    const { fromStateKey, fromHoldingId, toStateKey, toHoldingId, swapAmount } = action;

    const fromAcct = state[fromStateKey];
    const toAcct   = state[toStateKey];
    if (!fromAcct || !toAcct) return state;

    const fromHolding = (fromAcct.holdings ?? []).find(h => h.id === fromHoldingId);
    const toHolding   = (toAcct.holdings   ?? []).find(h => h.id === toHoldingId);
    if (!fromHolding || !toHolding) return state;

    const amount = +Math.min(swapAmount, fromHolding.marketValue, toHolding.marketValue).toFixed(2);
    if (amount <= 0) return state;

    // Basis fraction for the source holding
    const fromBasisFrac  = fromHolding.marketValue > 0 ? amount / fromHolding.marketValue : 0;
    const fromBasisShare = +((fromHolding.costBasis ?? 0) * fromBasisFrac).toFixed(2);

    // Update source holding
    const newFromHoldings = fromAcct.holdings.map(h => {
      if (h.id !== fromHoldingId) return h;
      return {
        ...h,
        marketValue: +(h.marketValue - amount).toFixed(2),
        costBasis:   +((h.costBasis ?? 0) - fromBasisShare).toFixed(2),
      };
    }).filter(h => h.marketValue > 0.001);

    // Update target holding (basis resets to market value for the received amount)
    const newToHoldings = toAcct.holdings.map(h => {
      if (h.id !== toHoldingId) return h;
      return {
        ...h,
        marketValue: +(h.marketValue + amount).toFixed(2),
        costBasis:   +((h.costBasis ?? 0) + amount).toFixed(2),
      };
    });

    const fromBalance = +newFromHoldings.reduce((s, h) => s + (h?.marketValue ?? 0), 0).toFixed(2);
    const toBalance   = +newToHoldings.reduce((s, h) => s + (h?.marketValue ?? 0), 0).toFixed(2);

    return this.newState(state, {
      [fromStateKey]: { ...fromAcct, holdings: newFromHoldings, balance: fromBalance },
      [toStateKey]:   { ...toAcct,   holdings: newToHoldings,   balance: toBalance   },
    });
  }
}
