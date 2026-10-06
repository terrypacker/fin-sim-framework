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

/**
 * The year-end FX mark the currency overlay measures f from (design 120 §5.6).
 *
 * Equity grows once a year, on the 31 Dec `year-end` earnings events (order 0), and the
 * overlay's f is the rate's move since the LAST of those: `R_end / R_start − 1`. R_start
 * must be the same for every account marked on one 31 Dec, so it cannot be re-stamped by
 * the first earnings handler to run. It is stamped here, once, by an event of its own:
 *
 *   - **order 0.5**, after every order-0 year-end earnings and dividend event, so they all
 *     read the previous mark; and before the order-1 FX tick, so a tick that falls on a
 *     31 Dec (a plan starting on the 31st) counts toward the year it opens, not to neither.
 *   - **scheduled only when an overlay can read it**: a security declares a hedge ratio and
 *     the plan runs the FX layer. Every other plan gets no event, so its queue is unchanged.
 */
export const HEDGE_FX_MARK_ORDER = 0.5;

/** The year-end series. @returns {EventSeries} */
export function buildHedgeFxMarkSeries() {
  return new EventSeries({
    name:     'Hedge FX Mark',
    type:     'HEDGE_FX_MARK',
    interval: 'year-end',
    order:    HEDGE_FX_MARK_ORDER,
    enabled:  true,
    color:    '#7E57C2',
  });
}

/** Reads the composed rates and emits HEDGE_FX_MARK_APPLY. */
export class HedgeFxMarkHandler extends HandlerEntry {
  static description = 'Stamps the year-end exchange rates the currency overlay measures the next year\'s FX move from (design 120 §5.6).';
  static type        = 'HedgeFxMarkHandler';
  static eventType   = 'HEDGE_FX_MARK';

  constructor() {
    super(null, 'Hedge FX Mark');
    this.generatedActionTypes = ['HEDGE_FX_MARK_APPLY'];
  }

  static fromJSON(d) {
    const h = new this();
    h.id = d.id;
    return h;
  }

  call({ state }) {
    const rates = state.effectiveExchangeRates;
    if (!rates) return [];
    return [{ type: 'HEDGE_FX_MARK_APPLY', rates: { ...rates } }];
  }
}

/** Pure write of the mark onto `state.hedgeOverlay.fxMark`. */
export class HedgeFxMarkReducer extends Reducer {
  static description = 'Stores the year-end exchange rates on state.hedgeOverlay.fxMark (design 120 §5.6).';
  static type        = 'HedgeFxMarkReducer';
  static actionType  = 'HEDGE_FX_MARK_APPLY';

  constructor() {
    super('Hedge FX Mark', PRIORITY.CASH_FLOW);
    this.reducedActionTypes   = ['HEDGE_FX_MARK_APPLY'];
    this.generatedActionTypes = [];
  }

  static fromJSON(d) {
    const r = new this();
    r.id = d.id;
    return r;
  }

  reduce(state, action) {
    if (!action.rates) return this.newState(state);
    return this.newState(state, {
      hedgeOverlay: { ...(state.hedgeOverlay ?? {}), fxMark: { ...action.rates } },
    });
  }
}
