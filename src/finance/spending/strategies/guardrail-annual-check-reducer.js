/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { Reducer, PRIORITY }              from '../../../simulation-framework/reducers.js';
import { computeGuardrailPortfolioValue } from '../guardrail-portfolio-value.js';

/**
 * GuardrailAnnualCheckReducer — Guyton-Klinger Guardrail annual withdrawal-rate check.
 *
 * Runs at PRE_PROCESS + 3 on each annual period advance, after:
 *   - InflationAdjustReducer (PRE_PROCESS + 2) has inflated the slices
 *   - RegimeAwareSpendingReducer (PRE_PROCESS + 3, same priority — order within
 *     priority depends on registration order)
 *
 * Once the Guardrail baseline is captured (state.guardrail.initialWithdrawalRate),
 * this reducer computes:
 *
 *   currentRate = annualSpending / portfolioValue
 *
 * and fires GUARDRAIL_ADJUST_APPLY via state.next if the rate drifts outside
 * the configured bands:
 *
 *   Cut  — currentRate > initialRate * (1 + cutThreshold)  → discretionary *= (1 - cutPct)
 *   Raise — currentRate < initialRate * (1 - raiseThreshold) → discretionary *= (1 + raisePct)
 *
 * @param {object} [opts]
 * @param {number} [opts.cutThreshold=0.20]   Rate above initial (fraction) that triggers a cut
 * @param {number} [opts.raiseThreshold=0.20] Rate below initial (fraction) that triggers a raise
 * @param {number} [opts.cutPct=0.10]         Fraction of discretionary to cut (0.10 = 10%)
 * @param {number} [opts.raisePct=0.10]       Fraction to raise discretionary (0.10 = 10%)
 * @param {string} [opts.baseCurrency='USD']  Currency for portfolio FX conversion
 */
export class GuardrailAnnualCheckReducer extends Reducer {
  static description = 'Annual Guyton-Klinger check: cuts or raises discretionary spending when withdrawal rate drifts outside configured bands.';
  static type        = 'GuardrailAnnualCheckReducer';
  static actionType  = null;

  constructor({
    cutThreshold   = 0.20,
    raiseThreshold = 0.20,
    cutPct         = 0.10,
    raisePct       = 0.10,
    baseCurrency   = 'USD',
  } = {}) {
    super('Guardrail Annual Check', PRIORITY.PRE_PROCESS + 3);
    this.reducedActionTypes = ['US_PERIOD_ADVANCE', 'AU_PERIOD_ADVANCE'];
    this.cutThreshold       = cutThreshold;
    this.raiseThreshold     = raiseThreshold;
    this.cutPct             = cutPct;
    this.raisePct           = raisePct;
    this.baseCurrency       = baseCurrency;
  }

  reduce(state, action) {
    const initialRate = state.guardrail?.initialWithdrawalRate;
    if (!initialRate || !state.expenses) return this.newState(state);

    const portfolioValue = computeGuardrailPortfolioValue(state, this.baseCurrency);
    if (!portfolioValue) return this.newState(state);

    const annualSpending = (state.expenses.essential + state.expenses.discretionary) * 12;
    const currentRate    = annualSpending / portfolioValue;

    const cutBand   = initialRate * (1 + this.cutThreshold);
    const raiseBand = initialRate * (1 - this.raiseThreshold);

    let multiplier = null;
    let cause      = null;

    if (currentRate > cutBand) {
      multiplier = 1 - this.cutPct;
      cause      = 'cut';
    } else if (currentRate < raiseBand) {
      multiplier = 1 + this.raisePct;
      cause      = 'raise';
    }

    if (multiplier == null) return this.newState(state);

    const date = action.date ?? null;

    return this.newState(state, {}, [
      { type: 'GUARDRAIL_ADJUST_APPLY', multiplier, cause, date },
    ]);
  }
}
