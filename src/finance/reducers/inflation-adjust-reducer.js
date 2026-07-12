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
    // Dedicated ATO CPI indexation series (design 57 Part 2, Item A). A per-country
    // cpiRates decouples the CGT cost-base index from household wage/expense
    // inflation. When cpiRates[cc] is unset it falls back to the *same* effective
    // inflation `rate`, so cpiAccumulator stays byte-identical to inflationAccumulator
    // until a distinct CPI is chosen.
    const cpiRate = state.cpiRates?.[cc] ?? rate;
    if (rate === 0 && cpiRate === 0) return this.newState(state);

    const factor    = 1 + rate;
    const cpiFactor = 1 + cpiRate;

    const inflationAccumulator = {
      ...(state.inflationAccumulator ?? {}),
      [cc]: ((state.inflationAccumulator?.[cc]) ?? 1.0) * factor,
    };
    const cpiAccumulator = {
      ...(state.cpiAccumulator ?? {}),
      [cc]: ((state.cpiAccumulator?.[cc]) ?? 1.0) * cpiFactor,
    };

    const updates = { inflationAccumulator, cpiAccumulator };

    if (cc === 'US') {
      // Driven off the always-annual US advance. Social Security is a USD amount,
      // inflated at the US rate. Wages are inflated at the rate of the *wage
      // currency's* country (design 50): a USD wage tracks US CPI, an AUD wage
      // tracks AU CPI — so an AU-source wage doesn't drift with US inflation.
      const rateFor = (code) => {
        const wcc = code === 'AUD' ? 'AU' : 'US';
        return state.effectiveInflationRates?.[wcc] ?? state.inflationRates?.[wcc] ?? 0;
      };
      const people = {};
      for (const [key, person] of Object.entries(state.people ?? {})) {
        const wageFactor = 1 + rateFor(person.wageCurrency);
        people[key] = {
          ...person,
          monthlyWage:           (person.monthlyWage           ?? 0) * wageFactor,
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
