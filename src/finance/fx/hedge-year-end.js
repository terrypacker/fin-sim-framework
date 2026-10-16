/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { HandlerEntry }      from '../../simulation-framework/handlers.js';
import { Reducer, PRIORITY } from '../../simulation-framework/reducers.js';
import { EventSeries }       from '../../simulation-framework/events/event-series.js';
import { nextCarriedLoss }   from '../holdings/currency-overlay.js';
import { isQuarterEnd, DIVIDENDS_PER_YEAR } from '../holdings/earnings-cadence.js';

/**
 * The currency hedge's year end (design 120 §5.6, §5.7): the FX mark the overlay measures
 * f from, and the losses `INCOME` funds carry into next year.
 *
 * Equity grows once a year, on the 31 Dec `year-end` earnings and dividend events
 * (order 0), and both things are read by them and must change only after all of them:
 *
 *   - **the FX mark.** The overlay's f is the rate's move since the last 31 Dec:
 *     `R_end / R_start − 1`. R_start must be the same for every account marked on one
 *     31 Dec, so the first earnings handler to run cannot re-stamp it.
 *   - **the carried loss.** An `INCOME` fund's distribution and price both read last
 *     year's L, and the fund's L′ depends on the whole year.
 *
 * So they are stamped here, once, by an event of its own:
 *
 *   - **order 0.5**, after every order-0 year-end earnings and dividend event, and before
 *     the order-1 FX tick, so a tick that falls on a 31 Dec (a plan starting on the 31st)
 *     counts toward the year it opens, not to neither.
 *   - **scheduled only when a security declares a hedge ratio.** Every other plan gets no
 *     event, so its queue is unchanged.
 *
 * Design 127 §4.3 — under MONTHLY equity earnings the same event fires at every month-end,
 * still at order 0.5, after that day's growth (−0.5) and dividends (−0.4):
 *   - `rates` (the growth overlay's `fxMark`) every month, so each month's f is that month's;
 *   - `distRates` (`fxMarkDist`) and the carried losses only at quarter-ends, the dates an
 *     `INCOME` fund distributes, with the split computed on the quarter.
 */
export const HEDGE_YEAR_END_ORDER = 0.5;

/**
 * The year-end series, or under design 127's MONTHLY cadence the month-end one.
 *
 * @param {{ monthly?: boolean }} [opts]
 * @returns {EventSeries}
 */
export function buildHedgeYearEndSeries({ monthly = false } = {}) {
  return new EventSeries({
    name:     'Hedge Year End',
    type:     'HEDGE_YEAR_END',
    interval: monthly ? 'month-end' : 'year-end',
    order:    HEDGE_YEAR_END_ORDER,
    ...(monthly ? { data: { periodsPerYear: 12 } } : {}),
    enabled:  true,
    color:    '#7E57C2',
  });
}

/** Reads the composed rates and the INCOME funds' year; emits HEDGE_YEAR_END_APPLY. */
export class HedgeYearEndHandler extends HandlerEntry {
  static description = 'Stamps the year-end exchange rates the currency overlay measures next year\'s FX move from, and the losses INCOME-treated hedged funds carry forward (design 120 §5.6, §5.7).';
  static type        = 'HedgeYearEndHandler';
  static eventType   = 'HEDGE_YEAR_END';

  constructor() {
    super(null, 'Hedge Year End');
    this.generatedActionTypes = ['HEDGE_YEAR_END_APPLY'];
  }

  static fromJSON(d) {
    const h = new this();
    h.id = d.id;
    return h;
  }

  call({ state, data, date }) {
    const out = { type: 'HEDGE_YEAR_END_APPLY' };
    if (state.effectiveExchangeRates) out.rates = { ...state.effectiveExchangeRates };
    // Design 127 §4.3 — sub-annual: the distribution side moves only on a payment date.
    const sub = (data?.periodsPerYear ?? 1) !== 1;
    if (sub && !isQuarterEnd(date)) return out.rates ? [out] : [];
    if (sub && out.rates) out.distRates = out.rates;
    const opts = sub ? { periodsPerYear: DIVIDENDS_PER_YEAR } : undefined;
    // Sorted ids, so the map's key order is a function of the registry alone.
    const carriedLoss = {};
    for (const id of Object.keys(state.securities ?? {}).sort()) {
      const sec = state.securities[id];
      const l   = nextCarriedLoss(state, sec, sec?.rateKey ?? null, opts);
      if (l != null && l !== 0) carriedLoss[id] = l;
    }
    if (Object.keys(carriedLoss).length || state.hedgeOverlay?.carriedLoss) out.carriedLoss = carriedLoss;
    if (!out.rates && !out.carriedLoss) return [];
    return [out];
  }
}

/** Pure write of the mark and the carried losses onto `state.hedgeOverlay`. */
export class HedgeYearEndReducer extends Reducer {
  static description = 'Stores the year-end exchange rates and INCOME funds\' carried losses on state.hedgeOverlay (design 120 §5.6, §5.7).';
  static type        = 'HedgeYearEndReducer';
  static actionType  = 'HEDGE_YEAR_END_APPLY';

  constructor() {
    super('Hedge Year End', PRIORITY.CASH_FLOW);
    this.reducedActionTypes   = ['HEDGE_YEAR_END_APPLY'];
    this.generatedActionTypes = [];
  }

  static fromJSON(d) {
    const r = new this();
    r.id = d.id;
    return r;
  }

  reduce(state, action) {
    if (!action.rates && !action.carriedLoss) return this.newState(state);
    return this.newState(state, {
      hedgeOverlay: {
        ...(state.hedgeOverlay ?? {}),
        ...(action.rates       ? { fxMark:      { ...action.rates } }       : {}),
        ...(action.distRates   ? { fxMarkDist:  { ...action.distRates } }   : {}),
        ...(action.carriedLoss ? { carriedLoss: { ...action.carriedLoss } } : {}),
      },
    });
  }
}
