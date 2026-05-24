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
   * Uses this.actionFactory so action construction follows the same path as
   * deserialization.
   */
  loadDefaults() {
    // ── Events ────────────────────────────────────────────────────────────────
    const monthEndEventSeries = new FinSimLib.Core.EventSeries({
      name: 'Month End',
      type: 'MONTH_END',
      interval: 'month-end',
      enabled: true,
      color: '#F44336'
    });
    this.scheduleEvent(monthEndEventSeries);

    // ── Actions ───────────────────────────────────────────────────────────────
    const recordSalaryPaymentAction = this.actionFactory.amountAction('RECORD_METRIC', 'Pay Salary', 1200);
    const sumSalaryPaymentAction = this.actionFactory.recordNumericSumMetricAction('Sum Payments', 'amount');

    // ── Handlers ──────────────────────────────────────────────────────────────
    const monthEndHandler = new FinSimLib.Core.HandlerEntry(null, 'Month End Handler');
    monthEndHandler.forEvent(monthEndEventSeries).generateAction(recordSalaryPaymentAction);
    this.registerHandler(monthEndHandler);

    // ── Reducers ──────────────────────────────────────────────────────────────
    const recordSalaryPaymentReducer = FinSimLib.Core.MetricReducer
      .fromMetric('amount')
      .withName('Process Salary Payment Amount')
      .reduceAction(recordSalaryPaymentAction)
      .generateAction(sumSalaryPaymentAction);
    this.registerReducer(recordSalaryPaymentReducer);

    const sumSalaryPaymentReducer = FinSimLib.Core.NumericSumMetricReducer
      .fromMetric('salary')
      .withName('Update Total Salary')
      .reduceAction(sumSalaryPaymentAction);
    this.registerReducer(sumSalaryPaymentReducer);

    const depositReducer = FinSimLib.Core.ArrayMetricReducer
      .fromMetric('deposits')
      .withName('Deposit Payment')
      .reduceAction(recordSalaryPaymentAction);
    this.registerReducer(depositReducer);
  }
}
