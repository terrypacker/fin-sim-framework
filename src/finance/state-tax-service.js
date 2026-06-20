/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { EventSeries } from '../simulation-framework/events/event-series.js';
import {
  StateTaxSettleHandler, StateTaxSettleApplyReducer, StateTaxPaymentDebitReducer,
} from './tax/state/state-tax-settle-classes.js';
import { buildStateClassificationReducers, STATE_YTD_FIELDS } from './tax/state/state-income-classification.js';

/**
 * StateTaxService — declarative wiring for US state income tax (design 34).
 *
 * The state analog of TaxService.getContributions, but simpler: states reuse the
 * US calendar-year period (built by US_TAX), so there is no period-advance —
 * only the Dec-31 state settle and the shared income-classification reducers.
 *
 * Returns plain data (no service side effects), consumed by the US_STATE_TAX toolset.
 */
export class StateTaxService {
  /**
   * @param {object} accountService
   * @param {object} stateRegistry
   * @returns {{ statePatches: object, events: object[], handlers: object[], reducers: object[] }}
   */
  getContributions(accountService, stateRegistry) {
    const settleSeries = new EventSeries({
      name:     'State Tax Settle',
      type:     'TAX_SETTLE_STATE',
      interval: 'annually',
      month:    12,
      day:      31,
      data:     { cc: 'US' },   // state tax follows the US calendar year (currentPeriods.US)
      enabled:  true,
      color:    '#FF8A65',
      order:    101,   // settle band, AFTER the federal settle (100) so both see identical income (design 34 §13)
    });

    const settleHandler = new StateTaxSettleHandler();
    settleHandler.handledEvents.push(settleSeries);

    const reducers = [
      new StateTaxSettleApplyReducer(),
      new StateTaxPaymentDebitReducer({ accountService, stateRegistry }),
      ...buildStateClassificationReducers(),
    ];

    const statePatches = {};
    for (const f of STATE_YTD_FIELDS) statePatches[f] = 0;

    return { statePatches, events: [settleSeries], handlers: [settleHandler], reducers };
  }
}
