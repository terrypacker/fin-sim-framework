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
import { HandlerEntry }      from '../../simulation-framework/handlers.js';

/**
 * Updates state.currentPeriods[cc] when a PERIOD_ADVANCE action fires at a
 * year boundary.  Runs at PRE_PROCESS priority so the correct period is in
 * state before any tax or cash-flow reducers run on the same step.
 */
export class PeriodAdvanceReducer extends Reducer {
  static description = 'Updates state.currentPeriods[cc] to the new period when a PERIOD_ADVANCE action fires at a year boundary.';
  static actionType  = 'PERIOD_ADVANCE';

  constructor() {
    super('Period Advance', PRIORITY.PRE_PROCESS);
    this.reducedActionTypes  = ['PERIOD_ADVANCE'];
  }

  reduce(state, action) {
    return this.newState(state, {
      currentPeriods: { ...state.currentPeriods, [action.cc]: action.period },
    });
  }
}

/**
 * Converts the scheduled PERIOD_ADVANCE event into a PERIOD_ADVANCE action so
 * the PeriodAdvanceReducer fires.
 *
 * The event's data.periods array is populated at build time (see TaxService)
 * with all annual periods for the country.  At fire time the handler looks up
 * the period that contains the current simulation date, so PERIOD_ADVANCE can
 * be scheduled as a single EventSeries (one node per country in the config
 * graph) rather than one OneOffEvent per year boundary.
 *
 * SimulationSync wires this via the static eventType property.
 */
export class PeriodAdvanceHandler extends HandlerEntry {
  static description = 'Dispatches a PERIOD_ADVANCE action from the scheduled PERIOD_ADVANCE event so PeriodAdvanceReducer updates state.currentPeriods.';
  static eventType   = 'PERIOD_ADVANCE';

  constructor() {
    super(null, 'Period Advance');
    this.generatedActionTypes = ['PERIOD_ADVANCE'];
  }

  call({ data, date }) {
    const { cc, periods } = data;
    // date is always UTC midnight (from sim.normalizeDate); use getTime() directly
    // to match period.startMs/endMs which are also UTC epoch values.
    const ts = date.getTime();
    const period = periods.find(p => p.startMs <= ts && ts < p.endMs);
    if (!period) return [];
    return [{ type: 'PERIOD_ADVANCE', cc, period }];
  }
}
