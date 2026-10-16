/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { HandlerEntry } from '../../simulation-framework/handlers.js';
import { EventSeries }  from '../../simulation-framework/events/event-series.js';

/**
 * The equity year's 1 January carrier — design 127 §4.1.
 *
 * The year's stochastic equity draw is stored by the 31 Dec tick and folded onto
 * `effectiveGrowthRates` by EquityReturnReducer at the next refold: a period advance or a
 * regime recompute. With a US tax toolset that is 1 January; in an AU-only plan it is
 * 1 July. ANNUAL crediting could not tell, because it read the rate only on 31 Dec. MONTHLY
 * credits every month, so an AU-only plan would credit last year's draw from January to
 * June and this year's from July — each calendar year a blend of two draws, about 30% less
 * volatile than the model says and correlated with its neighbours.
 *
 * So under MONTHLY with a stochastic equity path, a 1 January event emits
 * `RECOMPUTE_REGIMES`, which every reducer that refolds a deviation onto the effective rates
 * (regime apply, equity, inflation, yield curve, FX, prime relink) already reduces. With a US
 * advance on the same day it runs just after it and recomputes the same values. Design 94
 * §6.6 survives: every account still sees one rate for the calendar year.
 */
export const EQUITY_YEAR_OPEN_ORDER = -0.9;   // after PERIOD_ADVANCE_ORDER (−1), before the growth band (−0.5)

/** The 1 January series. @returns {EventSeries} */
export function buildEquityYearOpenSeries() {
  return new EventSeries({
    name:     'Equity Year Open',
    type:     'EQUITY_YEAR_OPEN',
    interval: 'annually',
    month:    1,
    day:      1,
    order:    EQUITY_YEAR_OPEN_ORDER,
    enabled:  true,
    color:    '#EF5350',
  });
}

export class EquityYearOpenHandler extends HandlerEntry {
  static type        = 'EquityYearOpenHandler';
  static eventType   = 'EQUITY_YEAR_OPEN';
  static description = 'On 1 January under MONTHLY equity earnings, recomputes the effective rates so the year\'s equity draw is in force from the first month in every plan (design 127 §4.1).';

  constructor() {
    super(null, 'Equity Year Open');
    this.generatedActionTypes = ['RECOMPUTE_REGIMES'];
  }

  static fromJSON(d) {
    const h = new this();
    h.id = d.id;
    return h;
  }

  call() {
    return [{ type: 'RECOMPUTE_REGIMES' }];
  }
}
