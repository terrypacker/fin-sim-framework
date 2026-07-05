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

/**
 * Default absolute monthly-amount band table (design/38 §6.1). Base-year USD
 * monthly spend per age phase; the reducer compounds it by the residence price
 * level at the band transition.
 */
export const DEFAULT_EXPENSE_BANDS = [
  { startAge: 65, monthlyAmount: 7000 },
  { startAge: 75, monthlyAmount: 6000 },
  { startAge: 85, monthlyAmount: 5500 },
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

/** The last band whose startAge ≤ age, or null when age is below the first band. */
function bandForAge(age, bands) {
  let chosen = null;
  for (const b of bands) {
    if (age >= b.startAge) chosen = b;
    else break;
  }
  return chosen;
}

/**
 * Compute the spending state patch for a band: `monthlyExpenses = monthlyAmount ×
 * residence price level`, with the essential/discretionary split preserving the
 * current ratio (falling back to `discretionaryShare`). Pure; shared by the
 * reducer's period-advance re-pin and the immediate re-pin below.
 */
export function pinExpensesForBand(state, band, cc, discretionaryShare = 0.30) {
  const priceLevel = state.inflationAccumulator?.[cc] ?? 1;
  const nominal    = band.monthlyAmount * priceLevel;
  const cur        = state.expenses ?? {};
  const curTotal   = (cur.essential ?? 0) + (cur.discretionary ?? 0);
  const ratio      = curTotal > 0 ? (cur.discretionary ?? 0) / curTotal : discretionaryShare;
  return {
    expenses: { ...cur, essential: nominal * (1 - ratio), discretionary: nominal * ratio },
    monthlyExpenses: nominal,
    explicitBandSpending: { appliedStartAge: band.startAge, appliedAmount: band.monthlyAmount },
  };
}

/**
 * Re-pin spending for the band active at `asOfMs` **immediately**, off the period-
 * advance grid — the actuation primitive for a forward-effective EXPLICIT_BANDS
 * edit at "now" (design 39 §5 / Step 5b). The reducer only re-pins at the annual
 * `*_PERIOD_ADVANCE`, so a mid-year edit would otherwise not bite until the next
 * year boundary; this lets the cockpit's live Apply and the projection rollout
 * both actuate from "now" instead, keeping them matched.
 *
 * Returns the state patch, or **null** when there's nothing to do — no active
 * EXPLICIT_BANDS pin yet (`state.explicitBandSpending` absent ⇒ not an
 * EXPLICIT_BANDS run, or the first period advance hasn't pinned), or the active
 * band is unchanged (same startAge AND amount) so reactive within-band
 * adjustments must be preserved. Mirrors the reducer's own skip condition.
 *
 * @param {object} state   live or snapshot sim state.
 * @param {Array}  bands   the NEW band table (post-edit).
 * @param {number} asOfMs  "now" in epoch ms.
 */
export function repinExpensesIfChanged(state, bands, asOfMs, { discretionaryShare = 0.30 } = {}) {
  if (!state?.expenses || asOfMs == null || !Array.isArray(bands)) return null;
  const applied = state.explicitBandSpending;
  if (!applied) return null;                       // not an active EXPLICIT_BANDS pin → leave alone
  const primaryKey  = Object.keys(state.people ?? {})[0];
  const residenceCC = state.people?.[primaryKey]?.residency ?? 'US';
  const birthDate   = state.people?.[primaryKey]?.birthDate;
  if (!birthDate) return null;
  const age  = getAge(new Date(birthDate), new Date(asOfMs));
  const band = bandForAge(age, bands);
  if (!band) return null;
  if (band.startAge === applied.appliedStartAge && band.monthlyAmount === applied.appliedAmount) {
    return null;                                   // unchanged → preserve reactive within-band drift
  }
  return pinExpensesForBand(state, band, residenceCC, discretionaryShare);
}

/**
 * ExplicitBandsSpendingReducer — the EXPLICIT_BANDS spending strategy (design/38
 * §6.1), a design-33 sibling of AgeBandedSpendingReducer.
 *
 * Where AGE_BANDED applies a *multiplier* table on a base expense, EXPLICIT_BANDS
 * carries **absolute monthly amounts** per band and materializes state.expenses
 * directly — the natural lever for "optimal monthly expense amount per age band."
 *
 * Re-pins only at band *transitions*: on entering a band it sets monthlyExpenses
 * to `monthlyAmount × inflationAccumulator[cc]` (the base-year amount compounded
 * to nominal at the transition). Within a band it is hands-off, so InflationAdjust
 * compounds it nominally and the portfolio-reactive strategies (regime/guardrail)
 * bend it on top. The essential/discretionary split preserves the current ratio
 * (falling back to `discretionaryShare`) so downstream discretionary cuts still
 * have a slice to act on.
 *
 * Runs at PRE_PROCESS + 4 (AGE_BANDED's slot — they are alternative levers),
 * residence-gated like InflationAdjustReducer, idempotent within a band via
 * state.explicitBandSpending.appliedStartAge.
 */
export class ExplicitBandsSpendingReducer extends Reducer {
  static description = 'Materializes state.expenses from an absolute monthly-amount age-band table on each period advance, compounding the base-year amount by the residence price level at band transitions.';
  static type        = 'ExplicitBandsSpendingReducer';
  static actionType  = null;

  /**
   * @param {object} [opts]
   * @param {Array}  [opts.bands=DEFAULT_EXPENSE_BANDS] sorted [{ startAge, monthlyAmount }].
   * @param {number} [opts.discretionaryShare=0.30] fallback discretionary fraction.
   */
  constructor({ bands = DEFAULT_EXPENSE_BANDS, discretionaryShare = 0.30 } = {}) {
    super('Explicit Bands Spending', PRIORITY.PRE_PROCESS + 4);
    this.reducedActionTypes  = ['US_PERIOD_ADVANCE', 'AU_PERIOD_ADVANCE'];
    this.bands               = bands;
    this.discretionaryShare  = discretionaryShare;
  }

  reduce(state, action) {
    if (!state.expenses) return this.newState(state);

    // Residence gate — identical to InflationAdjustReducer / AgeBandedSpendingReducer.
    const cc          = action.type === 'US_PERIOD_ADVANCE' ? 'US' : 'AU';
    const primaryKey  = Object.keys(state.people ?? {})[0];
    const residenceCC = state.people?.[primaryKey]?.residency ?? 'US';
    if (cc !== residenceCC) return this.newState(state);

    const birthDate = state.people?.[primaryKey]?.birthDate;
    const asOfMs = action.date != null
      ? new Date(action.date).getTime()
      : state.currentPeriods?.[cc]?.startMs;
    if (!birthDate || asOfMs == null) return this.newState(state);

    const age  = getAge(new Date(birthDate), new Date(asOfMs));
    const band = bandForAge(age, this.bands);
    if (!band) return this.newState(state);

    // Re-pin on entering a new band OR when the band's amount itself changed —
    // the latter is how a forward-effective edit at "now" (apply-forward / MPC
    // cockpit, design 39 §5) actuates an already-entered band: the freshly
    // compiled reducer carries the new amount, the injected snapshot still holds
    // the old appliedAmount, so the next period advance re-pins. Within an
    // unchanged band it stays hands-off (amount is constant ⇒ no re-pin), so
    // inflation + the reactive strategies keep their say.
    const applied = state.explicitBandSpending;
    if (band.startAge === applied?.appliedStartAge && band.monthlyAmount === applied?.appliedAmount) {
      return this.newState(state);
    }

    return this.newState(state, pinExpensesForBand(state, band, cc, this.discretionaryShare));
  }
}
