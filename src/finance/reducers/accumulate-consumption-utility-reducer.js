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
 * AccumulateConsumptionUtilityReducer — accumulates lifetime **CRRA utility** of
 * consumption into state.cumulativeConsumptionUtility (design/39 §4).
 *
 * Where AccumulateConsumptionReducer sums *raw* real consumption (a linear
 * quantity), this sums the **per-period concave utility** of consumption:
 *
 *     u(c) = (c^(1-γ) − 1) / (1 − γ)      (γ ≠ 1)
 *     u(c) = ln c                          (γ = 1)
 *
 * CRRA (constant relative risk aversion, γ) is what makes **consumption
 * smoothing fall out for free** rather than being imposed: because u is concave,
 * Σ u(cₜ) for a smooth path beats the same total spent unevenly, so an MPC
 * objective built on this naturally prefers level real spending. (A linear
 * objective on Σ cₜ is indifferent to the path — it can't smooth.)
 *
 * It mirrors AccumulateConsumptionReducer's real-USD normalization exactly
 * (FX-convert AUD, deflate by the residence price level) so a dollar consumed at
 * 65 and at 90 enter the utility on equal real footing, then applies u per
 * EXPENSE_DEBIT. A pure-of-final-state accumulator, windowable via a snapshot
 * delta — no per-step objective callback (design/38 §5).
 *
 * **REALIZED, not intent** (design 89 §5.4) — it mirrors that reducer's
 * `action.realizedAmount` read too, and had to. This one is the sharper case:
 * `MAX_CRRA_UTILITY` is a bare `maximize Σ u(c)` with NO deficit penalty, and
 * `OptimizationProblem.feasibilityFirst` defaults to false outside MPC, so on that
 * objective NOTHING opposed the overstatement. With u(c) = 2 − 2/√c on [0, 2) at
 * γ=1.5 and floor=1, booking intent meant an empty-account month scored the same
 * utility as one that actually spent the money. Reading what moved is the only
 * ruin signal this objective has.
 */
export class AccumulateConsumptionUtilityReducer extends Reducer {
  static description = 'Accumulates cumulativeConsumptionUtility as lifetime CRRA utility of real (base-year USD) per-period consumption.';
  static type        = 'AccumulateConsumptionUtilityReducer';
  static actionType  = 'EXPENSE_DEBIT';

  /**
   * @param {object} [opts]
   * @param {number} [opts.gamma=1.5] relative risk aversion (γ). γ=1 ⇒ log utility.
   * @param {number} [opts.floor=1]   real-consumption floor, so u stays finite at c→0.
   */
  constructor({ gamma = 1.5, floor = 1 } = {}) {
    super('Accumulate Consumption Utility', PRIORITY.METRICS);
    this.reducedActionTypes = ['EXPENSE_DEBIT'];
    this.gamma = gamma;
    this.floor = floor;
  }

  /** CRRA utility of a single period's real consumption (normalized so u(1)=0). */
  static utility(c, gamma = 1.5, floor = 1) {
    const x = Math.max(floor, c);
    if (Math.abs(gamma - 1) < 1e-9) return Math.log(x);
    return (Math.pow(x, 1 - gamma) - 1) / (1 - gamma);
  }

  /**
   * Marginal utility of a period's real consumption, u'(c) = c^{-γ} (γ=1 ⇒ 1/c).
   * This is the shadow price of a dollar in utils — used to auto-scale the
   * Die-With-Target λ for the CRRA basis so switching basis needs no re-tune
   * (design/39 §11): the dollar terminal penalty is converted into utils via the
   * run's average marginal utility, matching the utility-valued running reward.
   */
  static marginalUtility(c, gamma = 1.5, floor = 1) {
    const x = Math.max(floor, c);
    return Math.abs(gamma - 1) < 1e-9 ? 1 / x : Math.pow(x, -gamma);
  }

  reduce(state, action) {
    // Design 89 §5.4 — the money that MOVED, not the money that was asked for.
    // Kept identical to AccumulateConsumptionReducer's read on purpose: these two
    // drifting apart is what made this defect a two-file fix (design 89 §5.3).
    const amount = action.realizedAmount ?? action.amount ?? 0;
    if (!amount) return this.newState(state);

    const account  = state[action.targetKey];
    const currency = account?.currency?.code ?? account?.currency ?? 'USD';

    // BASE-YEAR anchor rate, not spot — see AccumulateConsumptionReducer for the unit
    // argument and the 36%-phantom-variation measurement. Kept identical to that read on
    // purpose: these two drifting apart is what made the last defect a two-file fix.
    let usd = amount;
    if (currency === 'AUD') {
      const rate = state.baseExchangeRates?.['USD_AUD']
        ?? state.effectiveExchangeRates?.['USD_AUD'] ?? 1;
      usd = amount / rate;
    }

    // Design 89 §5.6 — the price level is STAMPED by the emitter, never inferred here.
    // CURRENCY is still read off the account (that IS the account's axis: `amount` is
    // denominated in it), but the price INDEX is a different axis entirely, and one
    // action can even blend two of them when several properties pay from one account.
    // The `?? currency-derived` fallback keeps a hand-dispatched EXPENSE_DEBIT working.
    const cc         = currency === 'AUD' ? 'AU' : 'US';
    const priceLevel = action.priceLevel ?? state.inflationAccumulator?.[cc] ?? 1;
    const real       = usd / (priceLevel || 1);

    return this.newState({
      ...state,
      cumulativeConsumptionUtility:
        (state.cumulativeConsumptionUtility ?? 0)
        + AccumulateConsumptionUtilityReducer.utility(real, this.gamma, this.floor),
      // Track marginal utility + a count so the objective can derive the run's
      // average u'(c̄), the dollars→utils conversion for the CRRA λ (design/39 §11).
      cumulativeConsumptionMarginalUtility:
        (state.cumulativeConsumptionMarginalUtility ?? 0)
        + AccumulateConsumptionUtilityReducer.marginalUtility(real, this.gamma, this.floor),
      cumulativeConsumptionUtilityCount:
        (state.cumulativeConsumptionUtilityCount ?? 0) + 1,
    });
  }
}
