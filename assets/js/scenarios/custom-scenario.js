/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

// ─── Default parameters ────────────────────────────────────────────────────────
import {
  RecordArrayMetricAction, RecordMultiplicativeMetricAction
} from "../../../src/simulation-framework/actions.js";

export const DEFAULT_PARAMS = {

};

// ─── Recurring event series ────────────────────────────────────────────────────

// NOTE: earnings event types use INTL_ prefix to avoid colliding with the
// account module handlers (which also register for AU_SAVINGS_EARNINGS etc.
// and expect data.amount to be provided).
export const DEFAULT_EVENT_SERIES = [
  new FinSimLib.Scenarios.EventSeries({ id: 'month-end',     label: 'Month End Event',       type: 'MONTH_END',              interval: 'month-end', enabled: true,                 color: '#F44336' }),
  new FinSimLib.Scenarios.EventSeries({ id: 'year-end',      label: 'Year End Event',        type: 'YEAR_END',               interval: 'year-end',  enabled: true, startOffset: 1, color: '#4CAF50' }),
];

// ─── Scenario class ────────────────────────────────────────────────────────────

export class CustomScenario extends FinSimLib.Scenarios.BaseScenario {
  /**
   * @param {object} [opts]
   * @param {object}        [opts.params]       - Override DEFAULT_PARAMS
   * @param {EventSeries[]} [opts.eventSeries]  - Recurring event series
   * @param {Array}         [opts.customEvents] - One-off events [{type, date, data?}]
   */
  constructor({ params = {}, eventSeries = DEFAULT_EVENT_SERIES, customEvents = [] } = {}) {
    super({ eventSeries, customEvents });
    this.params   = { ...DEFAULT_PARAMS, ...params };
    this.simStart = new Date(Date.UTC(2026, 0, 1));
    this.simEnd   = new Date(Date.UTC(2041, 0, 1));
    this.handlerLogic = params.handlerLogic;
    this.reducerLogic = params.reducerLogic;
    this._buildSim();
  }

  _buildSim() {
    const p   = this.params;
    const USD = FinSimLib.Finance.USD;
    const AUD = FinSimLib.Finance.AUD;

    // ── PeriodService: US calendar years 2026-2040, AU fiscal years 2025-2040
    const periodService = new FinSimLib.Finance.PeriodService();
    for (let y = 2026; y <= 2040; y++) FinSimLib.Finance.applyTo(periodService, FinSimLib.Finance.buildUsCalendarYear(y));
    for (let y = 2025; y <= 2040; y++) FinSimLib.Finance.applyTo(periodService, FinSimLib.Finance.buildAuFiscalYear(y));

    // ── Initial state
    const initialState = {
      metrics: {},
      monthCount: 0,
      yearCount: 0,
    };

    this.sim = new FinSimLib.Core.Simulation(this.simStart, { initialState });

    // ── Schedule all recurring event series
    this._scheduleEvents();

    // ── Register scenario-level handlers
    this._registerHandlers(p);

    // ── Register scenario-level reducers
    this._registerReducers(p);

  }

  _registerHandlers(p) {
    this.sim.register('MONTH_END', new FinSimLib.Core.HandlerEntry(this.handlerLogic), 'Custom Handler');

    this.sim.register('MONTH_END', new FinSimLib.Core.HandlerEntry(({ data, date, state }) => {
      const actions = [];
      actions.push(
          { type: 'MONTH_END_PROCESS', date },
          new FinSimLib.Core.RecordArrayMetricAction('monthEnd', date),
      );
      return actions;
    }, 'Month End Handler'));
  }

  _registerReducers(p) {
    //MONTH END COUNT
    this.sim.reducers.register('MONTH_END_PROCESS', (state, action, date) => {
      const monthCounter = state.monthCount + 1;
      const gains = this.sim.rng() * 1000;
      const taxRate = 0.10; //TODO Make variable by month
      return {
        state: {
          ...state,
          monthCount: monthCounter
        },
        next: [
          new FinSimLib.Core.RecordMetricAction('monthCount', monthCounter),
          new FinSimLib.Core.RecordMetricAction('monthGains', gains),
          new FinSimLib.Core.RecordNumericSumMetricAction('totalGains', gains),
          new FinSimLib.Core.RecordMultiplicativeMetricAction('monthTax', taxRate),
        ]
      };
    }, FinSimLib.Core.PRIORITY.PRE_PROCESS, 'Month Counter');

    this.sim.reducers.register('CUSTOM_EVENT', this.reducerLogic, FinSimLib.Core.PRIORITY.PRE_PROCESS, 'Custom Reducer');

    //Metric Recorder
    new FinSimLib.Core.ArrayMetricReducer().registerWith(this.sim.reducers, 'RECORD_ARRAY_METRIC');
    new FinSimLib.Core.MetricReducer().registerWith(this.sim.reducers, 'RECORD_METRIC');
    new FinSimLib.Core.NumericSumMetricReducer().registerWith(this.sim.reducers, 'RECORD_NUMERIC_SUM_METRIC');
    FinSimLib.Core.MultiplicativeMetricReducer.fromMetric('monthGains').registerWith(this.sim.reducers, 'RECORD_MULTIPLICATIVE_METRIC');
  }

}
