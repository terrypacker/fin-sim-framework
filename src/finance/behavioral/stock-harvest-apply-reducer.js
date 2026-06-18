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
 * StockHarvestApplyReducer — dedicated sell+rebuy path for tax-loss and tax-gain
 * harvesting (design/29 §3.3, §3.8, Step 9).
 *
 * Unlike StockWithdrawalApplyReducer, this reducer:
 *   - Targets a specific source holding (sourceHoldingId), rather than FIFO-consuming
 *     the whole account, so the harvest hits exactly the holding with the unrealized loss.
 *   - Computes a SIGNED realizedGainLoss (no Math.max(0, …) floor), so losses reach
 *     the tax module's YTD capital-gain accumulator as negative deltas.
 *   - Immediately rebuys a substitute holding for the same proceeds, so the account
 *     stays invested. Cash balance is unchanged (sell + rebuy cancel out).
 *   - Chains STOCK_WITHDRAWAL_TAX with the signed gain — the tax module already
 *     accepts signed values and simply adds them to usCapitalGainsYTD / auCapitalGainsYTD.
 *
 * Action fields:
 *   stateKey          - account state key (e.g. 'usStockAccount')
 *   sellAmount        - dollar amount to realize from sourceHolding (≤ holding.marketValue)
 *   sourceHoldingId   - id of the holding to sell (must be < basis for LOSS; > for GAIN)
 *   substituteHoldingId - id of the holding to rebuy (same account; may equal source for GAIN)
 *   purpose           - 'LOSS' | 'GAIN'  (informational; no branch on this field)
 *   residency         - 'US' | 'AU'  (passed to STOCK_WITHDRAWAL_TAX)
 */
export class StockHarvestApplyReducer extends Reducer {
  static type        = 'StockHarvestApplyReducer';
  static description = 'Tax-harvest sell+rebuy: signed realized gain/loss on a target holding, immediate substitute rebuy, chains STOCK_WITHDRAWAL_TAX with the signed gain.';

  constructor() {
    super('Stock Harvest Apply', PRIORITY.CASH_FLOW);
    this.reducedActionTypes   = ['STOCK_HARVEST_APPLY'];
    this.generatedActionTypes = ['STOCK_WITHDRAWAL_TAX'];
  }

  reduce(state, action) {
    const { stateKey, sellAmount, sourceHoldingId, substituteHoldingId, purpose, residency } = action;
    const account = state[stateKey];
    if (!account) return state;

    const holdings = account.holdings ?? [];
    const source   = holdings.find(h => h.id === sourceHoldingId);
    if (!source) return state;

    // How much of the source holding to consume
    const consume     = +Math.min(sellAmount, source.marketValue).toFixed(2);
    const basisFrac   = source.marketValue > 0 ? consume / source.marketValue : 0;
    const basisShare  = +((source.costBasis ?? 0) * basisFrac).toFixed(2);

    // Signed gain/loss — NO Math.max(0, …) floor (the whole point vs normal withdrawal)
    const realizedGainLoss = +(consume - basisShare).toFixed(2);

    // Reduce/remove source holding
    const afterSell = holdings.map(h => {
      if (h.id !== sourceHoldingId) return h;
      const remainingMv    = +(h.marketValue - consume).toFixed(2);
      const remainingBasis = +((h.costBasis ?? 0) - basisShare).toFixed(2);
      if (remainingMv < 0.001) return null; // fully consumed
      return { ...h, marketValue: remainingMv, costBasis: remainingBasis };
    }).filter(Boolean);

    // Rebuy substitute: add proceeds to its marketValue and costBasis
    // (new lot at today's price — basis = market price, so gain resets to 0).
    //
    // Special case: when source === substitute (TaxGainHarvest rebuy of same holding),
    // the sell may have fully removed the holding from afterSell. Re-add it with the
    // rebuyed values so the position stays invested.
    let substituteFound = false;
    let afterRebuy = afterSell.map(h => {
      if (h.id !== substituteHoldingId) return h;
      substituteFound = true;
      return {
        ...h,
        marketValue: +(h.marketValue + consume).toFixed(2),
        costBasis:   +(h.costBasis   + consume).toFixed(2),
      };
    });

    if (!substituteFound) {
      if (substituteHoldingId === sourceHoldingId) {
        // Source was fully consumed; rebuy it with a fresh cost basis at market price
        afterRebuy = [
          ...afterSell,
          {
            ...source,
            marketValue: consume,
            costBasis:   consume,
          },
        ];
      } else {
        console.warn(`[StockHarvestApplyReducer] substitute holding '${substituteHoldingId}' not found in ${stateKey}; harvest skipped`);
        return state;
      }
    }

    const newBalance = +afterRebuy.reduce((s, h) => s + (h?.marketValue ?? 0), 0).toFixed(2);

    return this.newState(
      state,
      {
        [stateKey]: {
          ...account,
          holdings: afterRebuy,
          balance:  newBalance,
        },
      },
      [{
        type:        'STOCK_WITHDRAWAL_TAX',
        gain:        realizedGainLoss,
        residency:   residency ?? 'US',
        proceeds:    consume,
        costBasis:   basisShare,
        description: `${purpose ?? 'HARVEST'} harvest on ${stateKey}`,
      }],
    );
  }
}
