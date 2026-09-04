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
import { LAST_PUBLISHED_YEAR } from '../tax/us/us-contribution-limits.js';
import { LAST_PUBLISHED_FY }   from '../tax/au/au-super-limits.js';

/**
 * InflationAdjustReducer — applies annual inflation adjustments when a
 * US_PERIOD_ADVANCE or AU_PERIOD_ADVANCE action fires at each year boundary.
 *
 * Reads state.inflationRates[cc] to determine the annual rate for the
 * advancing country.  On each advance it:
 *
 *   - Updates state.inflationAccumulator[cc] (cumulative factor from sim start)
 *     and state.bracketIndexAccumulator / …ByYear for the tax-bracket projection
 *     series (US, US_STATE, AU), whose rate is CPI plus the
 *     per-series spread in state.bracketIndexSpreads, and whose history lets the bracket wrap index
 *     BETWEEN two years rather than only from sim start.
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
/**
 * The last financial/tax year each country's contribution limits are PUBLISHED for.
 * Beyond it the limits are projected (design 95 §10); up to and including it they are
 * transcribed, and must not be indexed.
 *
 * The AU key is a FINANCIAL year start and the US key a calendar year, matching what
 * `currentPeriods[cc].startMs` yields for each — 1 July for AU, 1 January for US.
 */
const LIMIT_PUBLISHED_HORIZON = {
  US: LAST_PUBLISHED_YEAR,
  AU: LAST_PUBLISHED_FY,
};

export class InflationAdjustReducer extends Reducer {
  static description = 'Applies annual inflation to wages, Social Security, and expenses on each US_PERIOD_ADVANCE or AU_PERIOD_ADVANCE; maintains state.inflationAccumulator, state.cpiAccumulator and the bracketIndex* projection series per country.';
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
    // The tax-bracket projection series: CPI plus a per-series spread (see below).
    const seriesKeys   = cc === 'US'
      ? ['US', 'US_STATE', 'US_FICA', 'US_FEIE']
      : ['AU'];
    const bracketRates = Object.fromEntries(
      seriesKeys.map(k => [k, rate + (state.bracketIndexSpreads?.[k] ?? 0)]));
    // Nothing moves only when EVERY series this advance drives is flat. Testing the
    // wage rate alone would strand a scenario that holds CPI at zero while still
    // projecting brackets upward on a positive spread — or, more usefully, one that
    // has inflation but freezes brackets on a spread of exactly −CPI.
    if (rate === 0 && cpiRate === 0 && seriesKeys.every(k => bracketRates[k] === 0)) {
      return this.newState(state);
    }

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

    // ── Bracket-index series, by period year ────────────────────────────────
    //
    // The series the TAX-BRACKET projection rides, separate from
    // `inflationAccumulator` on two counts.
    //
    // 1. Its RATE is `CPI + spread`, and the spread is a parameter. Beyond the last
    //    table an authority has published, this model has to assume something about
    //    how thresholds move, and outside the US that assumption is not law: neither
    //    the AU federal brackets nor Hawaii's or Nebraska's are statutorily indexed
    //    at all, so "brackets keep pace with CPI" is an editable projection rather
    //    than a transcription. Expressed as a SPREAD so the default — 0 — means
    //    exactly CPI and leaves every existing run byte-identical, and so the
    //    assumption tracks whatever inflation path the run actually takes instead of
    //    pinning a constant that silently diverges under an economic-regimes sweep.
    //    A negative spread models partial indexation; a spread of −CPI, a freeze.
    //
    // 2. Its ANCHOR is the rates table's own year, not sim start. A published table
    //    already contains the authority's indexation up to its year, so indexing it
    //    from sim start double-counts every year in between. That is why this is a
    //    recorded HISTORY (`level(Y) / level(moduleYear)` — see
    //    `bracketIndexationFactor`) rather than a scalar: the divisor is the level in
    //    the table's own year, and under an economic-regimes run — or any non-zero
    //    spread — the realised rate differs year to year, so it cannot be
    //    re-projected as `(1+r)^n` after the fact.
    //
    // There are FIVE series rather than one per country because a real authority
    // indexes each group of figures on its own schedule — see BRACKET_INDEX_SERIES.
    // The four US ones all advance with the US period (everything US files on the
    // calendar year); what differs is the rate each may be given.
    //
    // Keyed the same way `currentPeriods[cc].startMs` yields: US calendar year, AU
    // financial-year START year. The `prevYear` write self-seeds the sim's first year
    // at 1.0 on the first advance, so no separate seeding site is needed, and a state
    // carrying no history at all degrades to the sim-start anchor rather than breaking.
    const periodYear = new Date(state.currentPeriods?.[cc]?.startMs ?? NaN).getUTCFullYear();

    const bracketIndexAccumulator       = { ...(state.bracketIndexAccumulator ?? {}) };
    const bracketIndexAccumulatorByYear = { ...(state.bracketIndexAccumulatorByYear ?? {}) };
    for (const key of seriesKeys) {
      const prior = (state.bracketIndexAccumulator?.[key]) ?? 1.0;
      bracketIndexAccumulator[key] = prior * (1 + bracketRates[key]);
      if (Number.isFinite(periodYear)) {
        const levels   = { ...(state.bracketIndexAccumulatorByYear?.[key] ?? {}) };
        const prevYear = periodYear - 1;
        if (levels[prevYear] === undefined) levels[prevYear] = prior;
        levels[periodYear] = bracketIndexAccumulator[key];
        bracketIndexAccumulatorByYear[key] = levels;
      }
    }

    // ── Statutory contribution limits (design 95 §10, phase 9) ───────────────
    //
    // A THIRD accumulator, and it needs to be separate from the two above for one
    // reason: its anchor. `inflationAccumulator` is 1.0 at SIM START, which is the
    // right anchor for wages and expenses but the wrong one for a published limit —
    // the authority has already published the figures up to its own horizon, and
    // indexing those would double-count inflation the published number already
    // contains. This one stays at 1.0 until the advancing period passes that
    // country's last published year, and compounds only after it.
    //
    // Compounding the SAME effective rate the wages use is the point (§10): a run
    // whose salaries grow at one rate while its contribution caps grow at another is
    // measuring the gap between two assumptions rather than a policy outcome. That is
    // also why this reads the realised per-year rate rather than projecting a constant
    // — under an economic-regimes run the caps track the path the wages actually took.
    const horizon    = LIMIT_PUBLISHED_HORIZON[cc];
    const pastHorizon = Number.isFinite(periodYear) && horizon != null && periodYear > horizon;
    const limitIndexAccumulator = pastHorizon
      ? { ...(state.limitIndexAccumulator ?? {}),
          [cc]: ((state.limitIndexAccumulator?.[cc]) ?? 1.0) * factor }
      : state.limitIndexAccumulator;

    const updates = { inflationAccumulator, cpiAccumulator,
                      bracketIndexAccumulator, bracketIndexAccumulatorByYear,
                      ...(pastHorizon ? { limitIndexAccumulator } : {}) };

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
