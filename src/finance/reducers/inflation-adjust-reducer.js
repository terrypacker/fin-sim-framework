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
 * InflationAdjustReducer — applies annual inflation adjustments when a
 * US_PERIOD_ADVANCE or AU_PERIOD_ADVANCE action fires at each year boundary.
 *
 * Reads state.inflationRates[cc] to determine the annual rate for the
 * advancing country.  On each advance it:
 *
 *   - Updates state.inflationAccumulator[cc] (cumulative factor from sim start).
 *   - If cc === 'US': inflates each person's monthlyWage and socialSecurityMonthly
 *     (both are USD amounts tied to US economic conditions), and inflates
 *     state.monthlyExpenses once per year at the *residence* country's rate.
 *     Expenses are driven off the (always-annual) US advance rather than "the
 *     residence country's advance" so a mid-year US→AU move doesn't drop a year's
 *     expense increment at the US↔AU period handoff.
 *
 * Runs at PRE_PROCESS + 1 so it executes after PeriodAdvanceReducer has
 * updated state.currentPeriods, but still in the pre-process phase.
 */
export class InflationAdjustReducer extends Reducer {
  static description = 'Applies annual inflation to wages, Social Security, and expenses on each US_PERIOD_ADVANCE or AU_PERIOD_ADVANCE; maintains state.inflationAccumulator per country.';
  static type        = 'InflationAdjustReducer';
  static actionType  = null;

  constructor() {
    super('Inflation Adjust', PRIORITY.PRE_PROCESS + 2);
    this.reducedActionTypes = ['US_PERIOD_ADVANCE', 'AU_PERIOD_ADVANCE'];
  }

  reduce(state, action) {
    const cc = action.type === 'US_PERIOD_ADVANCE' ? 'US' : 'AU';
    const rate = state.effectiveInflationRates?.[cc] ?? state.inflationRates?.[cc] ?? 0;
    if (rate === 0) return this.newState(state);

    const factor = 1 + rate;

    const inflationAccumulator = {
      ...(state.inflationAccumulator ?? {}),
      [cc]: ((state.inflationAccumulator?.[cc]) ?? 1.0) * factor,
    };

    const updates = { inflationAccumulator };

    if (cc === 'US') {
      // Wages and SS are USD amounts — inflate at the US rate
      const people = {};
      for (const [key, person] of Object.entries(state.people ?? {})) {
        people[key] = {
          ...person,
          monthlyWage:           (person.monthlyWage           ?? 0) * factor,
          socialSecurityMonthly: (person.socialSecurityMonthly ?? 0) * factor,
        };
      }
      updates.people = people;

      // Inflate expenses once per year, here on the US advance (which fires every
      // year — it already drives wage/SS inflation), at the *residence* country's
      // rate. Earlier this was gated on the advancing country matching residence
      // (US advance pre-move, AU advance post-move). A mid-year US→AU move dropped
      // a full year's increment at the handoff: the post-move US advance was
      // skipped (residence already AU) and the AU period — which only starts at the
      // move — doesn't complete its first cycle until a year later, so the
      // transition year's inflation was lost and expenses stayed ~3% low forever.
      // Driving expenses off the single annual US advance, at the residence rate,
      // keeps exactly one increment per year across the move (design 34 caveat:
      // assumes US periods always advance, which holds for US citizens/filers).
      const primaryKey    = Object.keys(state.people ?? {})[0];
      const residenceCC   = state.people?.[primaryKey]?.residency ?? 'US';
      const residenceRate = state.effectiveInflationRates?.[residenceCC]
                         ?? state.inflationRates?.[residenceCC] ?? 0;
      const expFactor     = 1 + residenceRate;
      if (expFactor !== 1) {
        if (state.expenses) {
          // Materialized-slice path (design/26): inflate both slices and keep the
          // scalar in sync as their sum.
          const essential     = (state.expenses.essential     ?? 0) * expFactor;
          const discretionary = (state.expenses.discretionary ?? 0) * expFactor;
          updates.expenses        = { essential, discretionary };
          updates.monthlyExpenses = essential + discretionary;
        } else {
          // Legacy path: scalar only (pre-design-26 state or old snapshots).
          updates.monthlyExpenses = (state.monthlyExpenses ?? 0) * expFactor;
        }
      }
    }

    return this.newState(state, updates);
  }
}
