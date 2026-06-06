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

/**
 * TaxGainHarvestHandler — inverse of TaxLossHarvest (design/29 §3.8, Step 12).
 *
 * Triggered by the annual TAX_GAIN_HARVEST scheduled event (year-end).
 * In a low-income year (projectedTaxableIncome < taxGainHarvestBracketCeiling),
 * realize gains up to the 0% LTCG bracket ceiling and immediately rebuy the
 * SAME security — resetting cost basis upward at zero tax cost, shrinking
 * future taxable gains.
 *
 * No wash-sale rule applies to gains, so the rebuy can be the same holding.
 * sourceHoldingId === substituteHoldingId in each emitted STOCK_HARVEST_APPLY.
 *
 * Gating: the handler reads projectedTaxableIncome from state (written by the
 * tax module's period-advance step). If not present, the handler is a no-op.
 */
export class TaxGainHarvestHandler extends HandlerEntry {
  static type        = 'TaxGainHarvestHandler';
  static description = 'Annual tax-gain harvest: realizes LTCG up to the 0% bracket ceiling, rebuys same holding to reset basis, no wash-sale rule.';
  static eventType   = 'TAX_GAIN_HARVEST';

  /**
   * @param {object}   opts
   * @param {string[]} opts.taxableStateKeys                - state keys for taxable brokerage accounts
   * @param {number}   [opts.taxGainHarvestBracketCeiling]  - 0% LTCG bracket ceiling (USD)
   */
  constructor({ taxableStateKeys = [], taxGainHarvestBracketCeiling = 0 } = {}) {
    super(null, 'Tax Gain Harvest');
    this.taxableStateKeys              = taxableStateKeys;
    this.taxGainHarvestBracketCeiling  = taxGainHarvestBracketCeiling;
    this.generatedActionTypes = ['STOCK_HARVEST_APPLY'];
  }

  call({ state }) {
    const ceiling   = this.taxGainHarvestBracketCeiling;
    if (ceiling <= 0) return [];

    // Gate: projected taxable income must be below the ceiling
    const projectedIncome = state.usOrdinaryIncomeYTD ?? 0;
    const alreadyRealized = state.usCapitalGainsYTD   ?? 0;
    const roomRemaining   = ceiling - projectedIncome - alreadyRealized;
    if (roomRemaining <= 0) return [];

    const actions  = [];
    const residency = _primaryResidency(state);
    let gainCap    = roomRemaining;

    for (const stateKey of this.taxableStateKeys) {
      if (gainCap <= 0) break;
      const account = state[stateKey];
      if (!account) continue;

      const holdings = account.holdings ?? [];

      for (const holding of holdings) {
        if (gainCap <= 0) break;

        const mv    = holding.marketValue ?? 0;
        const basis = holding.costBasis  ?? 0;
        if (mv <= basis || mv <= 0) continue;  // not a gain

        const fullGain = mv - basis;

        if (fullGain <= gainCap) {
          gainCap -= fullGain;
          actions.push({
            type:                'STOCK_HARVEST_APPLY',
            stateKey,
            sellAmount:          mv,
            sourceHoldingId:     holding.id,
            substituteHoldingId: holding.id,  // same security — no wash-sale rule on gains
            purpose:             'GAIN',
            residency,
          });
        } else {
          // Partial harvest — sell enough to realize gainCap in gains
          // realizedGain = sellAmount * (1 - basis/mv) → sellAmount = gainCap / (1 - basis/mv)
          const gainRate = 1 - basis / mv;
          if (gainRate > 0) {
            const sellAmount = +Math.min(mv, gainCap / gainRate).toFixed(2);
            actions.push({
              type:                'STOCK_HARVEST_APPLY',
              stateKey,
              sellAmount,
              sourceHoldingId:     holding.id,
              substituteHoldingId: holding.id,
              purpose:             'GAIN',
              residency,
            });
          }
          gainCap = 0;
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
