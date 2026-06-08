/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { HandlerEntry } from '../../simulation-framework/handlers.js';
import { resolveSubstitute } from './substitute-holding.js';

/**
 * TaxLossHarvestHandler — flagship behavioral strategy (design/29 §3.3, Step 11).
 *
 * Triggered by the annual TAX_LOSS_HARVEST scheduled event (year-end).
 * Scans taxable brokerage accounts (US_STOCK, AU_STOCK) for holdings where
 * marketValue < costBasis, and for each such holding emits STOCK_HARVEST_APPLY
 * to realize the loss against the YTD capital-gain accumulator and immediately
 * rebuy a substitute holding (resetting the position but "washing" the loss into
 * the tax account).
 *
 * The signed realized loss flows to STOCK_WITHDRAWAL_TAX → usCapitalGainsYTD,
 * bypassing the Math.max(0,…) floor that normal withdrawals impose.
 *
 * Cap: taxLossHarvestCap (default 3000) bounds total dollar LOSS realized per year.
 * If a holding's full loss would exceed the cap, only a partial position is sold.
 *
 * Constructed with taxableStateKeys so the handler targets the right accounts
 * without hard-coding state key strings. Pass residency string for the tax chain.
 */
export class TaxLossHarvestHandler extends HandlerEntry {
  static type        = 'TaxLossHarvestHandler';
  static description = 'Annual tax-loss harvest: sells holdings below basis in taxable accounts, chains STOCK_HARVEST_APPLY with signed realized loss, rebuys substitute.';
  static eventType   = 'TAX_LOSS_HARVEST';

  /**
   * @param {object} opts
   * @param {string[]}  opts.taxableStateKeys       - state keys for taxable brokerage accounts
   * @param {number}    [opts.taxLossHarvestCap=3000] - max dollar loss to realize per year
   */
  constructor({ taxableStateKeys = [], taxLossHarvestCap = 3000 } = {}) {
    super(null, 'Tax Loss Harvest');
    this.taxableStateKeys    = taxableStateKeys;
    this.taxLossHarvestCap   = taxLossHarvestCap;
    this.generatedActionTypes = ['STOCK_HARVEST_APPLY'];
  }

  call({ state }) {
    const actions = [];
    let capRemaining = this.taxLossHarvestCap;

    const residency = _primaryResidency(state);

    for (const stateKey of this.taxableStateKeys) {
      if (capRemaining <= 0) break;
      const account = state[stateKey];
      if (!account) continue;

      const holdings = account.holdings ?? [];

      for (const holding of holdings) {
        if (capRemaining <= 0) break;

        const mv    = holding.marketValue ?? 0;
        const basis = holding.costBasis  ?? 0;
        if (mv >= basis || mv <= 0) continue;  // not a loss or empty

        const fullLoss = basis - mv;

        const substituteId = resolveSubstitute(holdings, holding);
        if (!substituteId) {
          console.warn(`[TaxLossHarvestHandler] no substitute for holding '${holding.id}' (${holding.label ?? holding.id}) in ${stateKey}; skipping`);
          continue;
        }

        if (fullLoss <= capRemaining) {
          // Harvest the entire position
          capRemaining -= fullLoss;
          actions.push({
            type:                'STOCK_HARVEST_APPLY',
            stateKey,
            sellAmount:          mv,
            sourceHoldingId:     holding.id,
            substituteHoldingId: substituteId,
            purpose:             'LOSS',
            residency,
          });
        } else {
          // Partial harvest — sell only enough to realize capRemaining in losses
          // realizedLoss per $ sold = fullLoss / mv = (basis - mv) / mv
          const lossRate = fullLoss / mv;  // (basis - mv) / mv
          if (lossRate > 0) {
            const sellAmount = +Math.min(mv, capRemaining / lossRate).toFixed(2);
            actions.push({
              type:                'STOCK_HARVEST_APPLY',
              stateKey,
              sellAmount,
              sourceHoldingId:     holding.id,
              substituteHoldingId: substituteId,
              purpose:             'LOSS',
              residency,
            });
          }
          capRemaining = 0;
        }
      }
    }

    return actions;
  }
}

function _primaryResidency(state) {
  const people = state.people ?? {};
  for (const p of Object.values(people)) {
    if (p?.residency) return p.residency;
  }
  return 'USA';
}
