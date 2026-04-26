/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */


// ─── Recurring event series ────────────────────────────────────────────────────
// NOTE: earnings event types use INTL_ prefix to avoid colliding with the
// account module handlers (which also register for AU_SAVINGS_EARNINGS etc.
// and expect data.amount to be provided).

export const DEFAULT_EVENT_SERIES = [
  new FinSimLib.Core.EventSeries({ id: 'month-end',     label: 'Month End Event',       type: 'MONTH_END',              interval: 'month-end', enabled: true,                 color: '#F44336' }),
  new FinSimLib.Core.EventSeries({ id: 'year-end',      label: 'Year End Event',        type: 'YEAR_END',               interval: 'year-end',  enabled: true, startOffset: 1, color: '#4CAF50' }),
];

// ─── Scenario class ────────────────────────────────────────────────────────────

export class CustomScenario extends FinSimLib.Scenarios.BaseScenario {
  constructor({ eventSchedulerUI } = {}) {
    super({ eventSchedulerUI });
  }

  /**
   * Build the bare Simulation instance. No events, handlers, or reducers are
   * registered here. Call loadDefaults() to populate the default configuration,
   * or let BaseApp call ScenarioSerializer.deserialize() when loading from a
   * saved config.
   */
  buildSim(params, initialState) {
    super.buildSim(params, initialState);
  }

  /**
   * Populate the scenario with its default event series, handlers, and reducers.
   * Called by BaseApp.afterBuildSim() when there is no saved config to load.
   */
  loadDefaults() {
    const { EventBuilder, ActionBuilder, HandlerBuilder, ReducerBuilder } = FinSimLib.Core;

    // ── Events ────────────────────────────────────────────────────────────────
    const monthEndEventSeries = EventBuilder
      .eventSeries()
      .name('Month End')
      .type('MONTH_END')
      .interval('month-end')
      .enabled(true)
      .color('#F44336')
      .build();
    this.scheduleEvent(monthEndEventSeries);

    // ── Actions ───────────────────────────────────────────────────────────────
    const recordSalaryPaymentAction = this.registerAction(
      ActionBuilder.amount()
        .type('RECORD_METRIC')
        .name('Pay Salary')
        .value(1200)
        .build()
    );

    const sumSalaryPaymentAction = this.registerAction(
      ActionBuilder.recordNumericSum()
        .name('Sum Payments')
        .fieldName('amount')
        .build()
    );

    // ── Handlers ──────────────────────────────────────────────────────────────
    const monthEndHandler = HandlerBuilder
      .handler(function({ data, date, state }) { return [...this.generatedActions]; })
      .name('Month End Handler')
      .forEvent(monthEndEventSeries)
      .generateAction(recordSalaryPaymentAction)
      .build();
    this.registerHandler(monthEndHandler);

    // ── Reducers ──────────────────────────────────────────────────────────────
    const recordSalaryPaymentReducer = ReducerBuilder
      .metric('amount')
      .name('Process Salary Payment Amount')
      .reduceAction(recordSalaryPaymentAction)
      .generateAction(sumSalaryPaymentAction)
      .build();
    this.registerReducer(recordSalaryPaymentReducer);

    const sumSalaryPaymentReducer = ReducerBuilder
      .numericSum('salary')
      .name('Update Total Salary')
      .reduceAction(sumSalaryPaymentAction)
      .build();
    this.registerReducer(sumSalaryPaymentReducer);

    const depositReducer = ReducerBuilder
      .arrayMetric('deposits')
      .name('Deposit Payment')
      .reduceAction(recordSalaryPaymentAction)
      .build();
    this.registerReducer(depositReducer);
  }
}
