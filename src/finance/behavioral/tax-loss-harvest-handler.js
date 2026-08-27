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
import { resolveSubstitute, resolveSubstituteSecurity } from './substitute-holding.js';
import { RecordMetricAction } from '../../simulation-framework/actions.js';

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
 * Cap: taxLossHarvestCap bounds total dollar LOSS realized per year, and it now defaults
 * to NO CAP (design 94 §8.1h). It used to default to \$3,000 as a "US deduction cap proxy",
 * which limited the same loss twice: §1211(b)'s \$3,000 is the amount deductible against
 * ORDINARY income, and the return already applies it — with the §1212(b) carryforward for
 * the rest — in `_computeCapitalLossLimitation`. Capping the HARVEST there meant the
 * strategy could never build the carryforward that is most of its value. What remains is an
 * optional POLICY cap. If a holding's full loss would exceed it, only a partial position is
 * sold.
 *
 * ⚠️ **A skipped harvest is now RECORDED, not just warned about** (design 94 §8.1h). R2
 * measured 2.6–4.0 skips per lifetime path — every one a `console.warn` nobody reads, and
 * the reason the "uncapped" arm realised a single loss and then nothing for twenty years.
 * `state.taxLossHarvestSkipped` counts them so a scenario can see its strategy declining.
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
   * @param {number|null} [opts.taxLossHarvestCap=null] - optional policy cap on the dollar
   *   loss realized per year; null (the default) = uncapped. NOT the §1211(b) \$3,000.
   */
  constructor({ taxableStateKeys = [], taxLossHarvestCap = null } = {}) {
    super(null, 'Tax Loss Harvest');
    this.taxableStateKeys    = taxableStateKeys;
    this.taxLossHarvestCap   = taxLossHarvestCap;
    this.generatedActionTypes = ['STOCK_HARVEST_APPLY', 'RECORD_METRIC'];
  }

  call({ state }) {
    const actions = [];
    // `Infinity` when uncapped, so every `capRemaining <= 0` / `fullLoss <= capRemaining`
    // test below reads the same way in both modes.
    let capRemaining = Number.isFinite(this.taxLossHarvestCap) ? this.taxLossHarvestCap : Infinity;
    let skipped      = 0;

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

        // Preference order (design 94 §8.1h), best first:
        //   1. a lot the account already holds in a DIFFERENT identity group — a legal
        //      harvest with no §1091 exposure at all;
        //   2. a SECURITY in the same market and a different group, opened as a fresh lot —
        //      the two-fund rotation the model could not express before Option C, and what
        //      stops the strategy dying after its first harvest (R2, §8.1f);
        //   3. the same-group lot it would have picked before — a wash, preserved so an
        //      un-securitised book behaves exactly as it did;
        //   4. nothing: skip, and RECORD the skip.
        const securities   = state.securities ?? null;
        let substituteId   = resolveSubstitute(holdings, holding, securities, { requireDistinct: true });
        let substituteSec  = null;
        if (!substituteId) substituteSec = resolveSubstituteSecurity(holding, securities);
        if (!substituteId && !substituteSec) substituteId = resolveSubstitute(holdings, holding, securities);
        if (!substituteId && !substituteSec) {
          // R2 (§8.1f) found this skip firing 2.6–4.0 times per lifetime path, silently.
          // It is what stops an uncapped harvester dead after its first harvest: once the
          // sold lot is gone the sleeve holds one lot, and one lot has no partner.
          skipped++;
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
            substituteSecurityId: substituteSec,
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
              substituteSecurityId: substituteSec,
              purpose:             'LOSS',
              residency,
            });
          }
          capRemaining = 0;
        }
      }
    }

    // Recorded as a metric rather than left in the console: a strategy that declines to
    // act is indistinguishable from one that had nothing to do, and the difference is
    // whole years of unharvested loss.
    if (skipped > 0) actions.push(new RecordMetricAction('tlh_skipped_no_substitute', skipped));
    return actions;
  }
}

function _primaryResidency(state) {
  const people = state.people ?? {};
  for (const p of Object.values(people)) {
    if (p?.residency) return p.residency;
  }
  return 'US';
}
