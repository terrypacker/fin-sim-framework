/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { Reducer, PRIORITY } from '../../../simulation-framework/reducers.js';
import { ageSpendingFactor, ageBandStartAge } from '../age-spending-factor.js';

/**
 * Research-calibrated default band table (design/33 §5.1). Encodes the
 * three-phase ("go-go / slow-go / no-go") discretionary glide of the
 * retirement spending smile; the terminal health upturn is deliberately left
 * to the HEALTHCARE strategy / design 27 late-life care (§7), so the no-go
 * band plateaus rather than spiking.
 */
export const DEFAULT_AGE_BANDS = [
  { startAge: 0,  multiplier: 1.00, annualRealDrift:  0.000 }, // pre-retirement: baseline
  { startAge: 65, multiplier: 1.00, annualRealDrift: -0.010 }, // go-go:   gentle real decline (~1%/yr)
  { startAge: 75, multiplier: 0.90, annualRealDrift: -0.015 }, // slow-go: step down, faster decline
  { startAge: 85, multiplier: 0.90, annualRealDrift:  0.000 }, // no-go:   plateau (health spike handled elsewhere)
];

/** Whole years of age as of asOfDate (matches the RMD handlers' _getAge). */
function getAge(birthDate, asOfDate) {
  const years = asOfDate.getUTCFullYear() - birthDate.getUTCFullYear();
  const hadBirthday =
    asOfDate.getUTCMonth() > birthDate.getUTCMonth() ||
    (asOfDate.getUTCMonth() === birthDate.getUTCMonth() &&
      asOfDate.getUTCDate() >= birthDate.getUTCDate());
  return hadBirthday ? years : years - 1;
}

/**
 * AgeBandedSpendingReducer — layers an age-driven *real* multiplier on top of
 * inflation, modeling the empirical "retirement spending smile" (design/33).
 *
 * On each annual period advance it pins the slice to the band table's target
 * factor for the primary person's age by dividing out the previously applied
 * factor and multiplying in the new one (state.ageBandSpending.appliedFactor).
 * This is the RegimeAwareSpendingReducer apply/revert trick generalized to a
 * continuous factor: idempotent within a year, stable across years, never
 * compounding on top of itself.
 *
 * Runs at PRE_PROCESS + 4, after InflationAdjustReducer (+2) and
 * RegimeAwareSpendingReducer (+3), so it operates on the already-inflated,
 * already-regime-adjusted slice for the new year. Acts only on the advance for
 * the primary person's country of residence (the same gate
 * InflationAdjustReducer uses) so a US+AU couple is not adjusted twice/year.
 */
export class AgeBandedSpendingReducer extends Reducer {
  static description = 'Applies a deterministic age-driven real multiplier (the retirement spending smile) to the discretionary expense slice on each period advance; reconciles against the prior factor so it never compounds.';
  static type        = 'AgeBandedSpendingReducer';
  static actionType  = null;

  /**
   * @param {object} [opts]
   * @param {Array}  [opts.bands=DEFAULT_AGE_BANDS] sorted band table (design/33 §5.1).
   * @param {'discretionary'|'both'} [opts.slice='discretionary'] expense slice(s) to bend.
   */
  constructor({ bands = DEFAULT_AGE_BANDS, slice = 'discretionary' } = {}) {
    super('Age-Banded Spending', PRIORITY.PRE_PROCESS + 4);
    this.reducedActionTypes = ['US_PERIOD_ADVANCE', 'AU_PERIOD_ADVANCE'];
    this.bands = bands;
    this.slice = slice;
  }

  reduce(state, action) {
    if (!state.expenses) return this.newState(state);

    // Residence gate — identical to InflationAdjustReducer.
    const cc          = action.type === 'US_PERIOD_ADVANCE' ? 'US' : 'AU';
    const primaryKey  = Object.keys(state.people ?? {})[0];
    const residency   = state.people?.[primaryKey]?.residency ?? null;
    const residenceCC = residency === 'AUS' ? 'AU' : 'US';
    if (cc !== residenceCC) return this.newState(state);

    const birthDate = state.people?.[primaryKey]?.birthDate;
    // The period-advance action carries no date; the current date is the start
    // of the just-advanced period (state.currentPeriods[cc], updated by
    // PeriodAdvanceReducer before this reducer runs). action.date is a fallback
    // so the reducer is unit-testable in isolation.
    const asOfMs = action.date != null
      ? new Date(action.date).getTime()
      : state.currentPeriods?.[cc]?.startMs;
    if (!birthDate || asOfMs == null) return this.newState(state);

    const age    = getAge(new Date(birthDate), new Date(asOfMs));
    const target = ageSpendingFactor(age, this.bands);

    const applied = state.ageBandSpending?.appliedFactor ?? 1.0;
    if (Math.abs(target - applied) < 1e-12) return this.newState(state);

    // Reconcile: divide out the prior factor, multiply in the new one. Prevents
    // year-over-year compounding while re-pinning the real age multiplier.
    const ratio    = target / applied;
    const expenses = { ...state.expenses };
    expenses.discretionary *= ratio;
    if (this.slice === 'both') expenses.essential *= ratio;

    return this.newState(state, {
      expenses,
      monthlyExpenses: expenses.essential + expenses.discretionary,
      ageBandSpending: {
        appliedFactor:     target,
        currentBandStartAge: ageBandStartAge(age, this.bands),
      },
    });
  }
}
