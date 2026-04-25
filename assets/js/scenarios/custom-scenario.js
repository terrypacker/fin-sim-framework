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

  buildSim(params, initialState) {
    super.buildSim(params, initialState);

    //Setup Events
    const monthEndEventSeries = new FinSimLib.Core.EventSeries({
      name: 'Month End',
      type: 'MONTH_END',
      interval: 'month-end',
      enabled: true,
      color: '#F44336'
    });
    this.scheduleEvent(monthEndEventSeries);

    /* Not rendering right on config graph
    const buyLambo = new Date();
    buyLambo.setMonth(buyLambo.getMonth() + 3);
    this._scheduleOneOffEvent({
      name: 'Buy Lamborghini',
      type: 'BUY_LAMBO',
      date: buyLambo,
      enabled: true,
      color: '#4CAF50'
    });
    */

    //Handle Month End
    const recordSalaryPaymentAction = new FinSimLib.Core.AmountAction('RECORD_METRIC', 'Pay Salary', 1200);
    const sumSalaryPaymentAction = new FinSimLib.Core.RecordNumericSumMetricAction('Sum Payments', 'amount');

    const monthEndHandler = new FinSimLib.Core.HandlerEntry( null,'Month End Handler');
    monthEndHandler.forEvent(monthEndEventSeries).generateAction(recordSalaryPaymentAction);
    this.registerHandler(monthEndHandler);

    //Record Salary Reducer
    const recordSalaryPaymentReducer = FinSimLib.Core.MetricReducer
      .fromMetric('amount')
      .withName('Process Salary Payment Amount')
      .reduceAction(recordSalaryPaymentAction)
      .generateAction(sumSalaryPaymentAction);
    this.registerReducer(recordSalaryPaymentReducer);

    //Sum all salaries
    const sumSalaryPaymentReducer = FinSimLib.Core.NumericSumMetricReducer
      .fromMetric('salary')
      .withName('Update Total Salary')
      .reduceAction(sumSalaryPaymentAction);
    this.registerReducer(sumSalaryPaymentReducer);

    //Sum all salaries
    const depositReducer = FinSimLib.Core.ArrayMetricReducer
    .fromMetric('deposits')
    .withName('Deposit Payment')
    .reduceAction(recordSalaryPaymentAction);
    this.registerReducer(depositReducer);
  }


  //TODO REMOVE
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

  //TODO REMOVE
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
          new FinSimLib.Core.AmountAction('PURCHASE_EVENT', 'purchases', 5),
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

    const purchase = new FinSimLib.Core.StateFieldReducer('Purchaser', PRIORITY.POSITION_UPDATE,
        'purchase', (state, action, date) => {
      return this.sim.rng() * 1000;
    });
    const recordPurchase = FinSimLib.Core.ArrayMetricReducer.fromField('purchase');
    FinSimLib.Core.RepeatingReducer.fromReducer([purchase, recordPurchase], 'amount').registerWith(this.sim.reducers, 'PURCHASE_EVENT');
  }

}
