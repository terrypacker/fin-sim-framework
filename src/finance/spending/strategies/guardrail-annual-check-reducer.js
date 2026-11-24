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
import { guardrailPortfolioInExpenseUnits } from '../guardrail-portfolio-value.js';

/**
 * The shortest gap between two checks. Guyton-Klinger is an ANNUAL rule, but the reducer
 * listens to both countries' period advances, and a plan with both toolsets fires both:
 * US on 1 Jan and AU on 1 Jul. Before this gate such a plan checked, and could cut or
 * raise, twice a year, so its guardrail stepped twice as fast as a US-only plan's. Eleven
 * months rather than twelve so an annual cadence never misses a year to day-count drift.
 */
export const GUARDRAIL_MIN_CHECK_GAP_MS = 335 * 24 * 3600 * 1000;

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
 * the configured bands. It checks at most once a year (GUARDRAIL_MIN_CHECK_GAP_MS): the first
 * period advance after the last check runs it and stamps `state.guardrail.lastCheckDate`.
 * A single-country plan, which has one advance a year, is unaffected by the gate:
 *
 *   Cut  — currentRate > initialRate * (1 + cutThreshold)  → discretionary *= (1 - cutPct)
 *   Raise — currentRate < initialRate * (1 - raiseThreshold) → discretionary *= (1 + raisePct)
 *
 * @param {object} [opts]
 * @param {number} [opts.cutThreshold=0.20]   Rate above initial (fraction) that triggers a cut
 * @param {number} [opts.raiseThreshold=0.20] Rate below initial (fraction) that triggers a raise
 * @param {number} [opts.cutPct=0.10]         Fraction of discretionary to cut (0.10 = 10%)
 * @param {number} [opts.raisePct=0.10]       Fraction to raise discretionary (0.10 = 10%)
 * @param {string} [opts.baseCurrency='USD']  Kept for the config surface; the rate is currency-free
 * @param {string} [opts.expensesCurrency='RESIDENCE']  Units of state.expenses (see
 *                 guardrailPortfolioInExpenseUnits): the portfolio is converted into them.
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
    expensesCurrency = 'RESIDENCE',
  } = {}) {
    super('Guardrail Annual Check', PRIORITY.PRE_PROCESS + 3);
    this.reducedActionTypes = ['US_PERIOD_ADVANCE', 'AU_PERIOD_ADVANCE'];
    this.cutThreshold       = cutThreshold;
    this.raiseThreshold     = raiseThreshold;
    this.cutPct             = cutPct;
    this.raisePct           = raisePct;
    this.baseCurrency       = baseCurrency;
    this.expensesCurrency   = expensesCurrency;
  }

  reduce(state, action, tickDate) {
    const initialRate = state.guardrail?.initialWithdrawalRate;
    if (!initialRate || !state.expenses) return this.newState(state);

    // The tick date is the reducer's third argument; a period-advance action carries none.
    const when      = tickDate ?? action.date ?? null;
    const whenMs    = when != null ? new Date(when).getTime() : null;
    const lastMs    = state.guardrail.lastCheckDate != null ? new Date(state.guardrail.lastCheckDate).getTime() : null;
    if (whenMs != null && lastMs != null && whenMs - lastMs < GUARDRAIL_MIN_CHECK_GAP_MS) {
      return this.newState(state);
    }
    const stamped = whenMs != null
      ? { guardrail: { ...state.guardrail, lastCheckDate: new Date(whenMs) } }
      : {};

    const portfolioValue = guardrailPortfolioInExpenseUnits(state, this.expensesCurrency);
    if (!portfolioValue) return this.newState(state, stamped);

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

    if (multiplier == null) return this.newState(state, stamped);

    const date = action.date ?? null;

    return this.newState(state, stamped, [
      { type: 'GUARDRAIL_ADJUST_APPLY', multiplier, cause, date },
    ]);
  }
}
