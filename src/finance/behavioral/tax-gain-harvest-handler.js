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
import { TaxSettleService } from '../tax-settle-service.js';
import { isLongTerm } from '../holdings/holding-period.js';

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
 *
 * **US-resident years only.** The 0% band is a US rate, and a gain realised while anyone in
 * the household lives somewhere else is taxed there too: an Australian resident pays AU CGT on
 * it at marginal rates (with the 12-month discount at best), and Australia has no 0% band. In
 * those years US ordinary income is near zero, so the US-only test above saw the whole ceiling
 * as "room" and the handler sold and rebought every year — on one studied plan, every
 * AU-resident year from the move onward, raising lifetime tax by more than half again and
 * turning a surviving stagflation path into a failure. The check is at the event (31 Dec), so
 * the year of a move to AU, when the household is AU-resident at year end, is skipped too.
 *
 * **The room is measured where the band is defined: taxable income.** The 0% band is a
 * threshold on taxable income, so the room is `ceiling − (ordinary + short-term gains −
 * standard deduction) − long-term gains so far`. The event is scheduled at order 50 on
 * 31 Dec (after the day's dividends, interest and conversions at order 0, before the
 * settle at 100), so the year-to-date figures are the year's. Before this, the handler
 * fired among the order-0 events ahead of that day's income, left short-term gains out and
 * ignored the deduction: on one studied plan it realised $40k into a $22k band and paid
 * tax on the rest.
 *
 * **Long-term lots only.** The 0% rate is a long-term rate; a lot held one year or less
 * (§1222) realises ordinary income at the marginal rate. Such lots are skipped: in that
 * plan's stagflation run the harvest sold year-old bond-ladder rungs and paid $2.4k for it.
 *
 * **Not while a capital loss is on hand.** A gain realised in a year with a net capital loss,
 * or against a carryforward, nets against that loss first (§1211/§1212), so it spends the
 * loss's $3,000-a-year deduction against ordinary income rather than using the 0% band.
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

  call({ state, date }) {
    const ceiling   = this.taxGainHarvestBracketCeiling;
    if (ceiling <= 0) return [];
    if (!_householdUsResident(state)) return [];

    const netGainYtd = (state.usCapitalGainsYTD ?? 0) + (state.usShortTermCapitalGainsYTD ?? 0);
    const carried    = (state.usShortTermCapitalLossCarryforward ?? 0) + (state.usLongTermCapitalLossCarryforward ?? 0);
    if (netGainYtd < 0 || carried > 0) return [];

    // Gate: the 0% band's room in taxable-income space. Short-term gains are ordinary
    // income; a net short-term loss offsets long-term gains first (§1222).
    const shortTerm       = state.usShortTermCapitalGainsYTD ?? 0;
    const ordinaryTaxable = Math.max(0, (state.usOrdinaryIncomeYTD ?? 0) + Math.max(0, shortTerm)
                                        - _settle().usStandardDeduction(state));
    const alreadyRealized = Math.max(0, (state.usCapitalGainsYTD ?? 0) + Math.min(0, shortTerm));
    const roomRemaining   = ceiling - ordinaryTaxable - alreadyRealized;
    if (roomRemaining <= 0) return [];

    const actions  = [];
    const residency = _primaryResidency(state);
    const asOfMs    = date != null ? new Date(date).getTime() : null;
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
        const boughtMs = holding.purchaseDate != null ? new Date(holding.purchaseDate).getTime() : null;
        if (asOfMs != null && boughtMs != null && !isLongTerm('US', asOfMs - boughtMs)) continue;

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

let _settleService = null;
function _settle() { return (_settleService ??= new TaxSettleService()); }

/** True when every person in the household is US-resident (absent residency reads as US). */
function _householdUsResident(state) {
  const people = Object.values(state.people ?? {}).filter(Boolean);
  return people.every(p => (p.residency ?? 'US') === 'US');
}

function _primaryResidency(state) {
  const people = state.people ?? {};
  for (const p of Object.values(people)) {
    if (p?.residency) return p.residency;
  }
  return 'US';
}
