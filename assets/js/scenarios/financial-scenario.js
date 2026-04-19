/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

export const DEFAULT_PARAMS = {
  salaryMonthly:       8000,
  savingsInterestRate: 0.04,
  incomeTaxRate:       0.25,
  shortTermCgtRate:    0.22,
  longTermCgtRate:     0.15,
  initialChecking:     5000,
  initialSavings:      10000
};

// Built-in recurring event series definitions
export const DEFAULT_EVENT_SERIES = [
  new FinSimLib.Scenarios.EventSeries({ id: 'salary',   label: 'Monthly Salary',          type: 'MONTHLY_SALARY',  interval: 'monthly',   enabled: true,                color: '#4CAF50' }),
  new FinSimLib.Scenarios.EventSeries({ id: 'interest', label: 'Annual Savings Interest',  type: 'ANNUAL_INTEREST', interval: 'annually',  enabled: true, startOffset: 1, color: '#2196F3' }),
  new FinSimLib.Scenarios.EventSeries({ id: 'assets',   label: 'Quarterly Asset Sales',    type: 'SELL_ASSET',      interval: 'quarterly', enabled: true,                color: '#FF9800' }),
  new FinSimLib.Scenarios.EventSeries({ id: 'tax',      label: 'Annual Income Tax Filing', type: 'ANNUAL_TAX',      interval: 'annually',  enabled: true, startOffset: 1, color: '#F44336' }),
];

export class FinancialScenario extends FinSimLib.Scenarios.BaseScenario {
  /**
   * @param {object}       opts
   * @param {object}       opts.params        - Override DEFAULT_PARAMS
   * @param {EventSeries[]} opts.eventSeries  - Array of series configs (copy of DEFAULT_EVENT_SERIES, may be filtered)
   * @param {Array}        opts.customEvents  - One-off extra events [{type, date, amount?}]
   */
  constructor({ params = {}, eventSeries = DEFAULT_EVENT_SERIES, customEvents = [] } = {}) {
    super({ eventSeries, customEvents });
    this.params = { ...DEFAULT_PARAMS, ...params };

    this.accountService = new FinSimLib.Finance.AccountService();
    this.simStart = new Date(2025, 0, 1);
    this.simEnd   = new Date(2030, 0, 1);

    this._buildSim();
  }

  _buildSim() {
    const p   = this.params;
    const accountService = this.accountService;

    // Assets with purchaseDates — mix of long-term and short-term holds
    // relative to simStart (2025-01-01)
    const assets = [
      Object.assign(new FinSimLib.Finance.Asset('Tech Stock',   15000, 10000), { purchaseDate: new Date(2022, 0, 1) }), // LT (3+ yr)
      Object.assign(new FinSimLib.Finance.Asset('Growth Fund',   8000,  6000), { purchaseDate: new Date(2023, 6, 1) }), // LT (1.5 yr)
      Object.assign(new FinSimLib.Finance.Asset('REIT',          5000,  4500), { purchaseDate: new Date(2024, 9, 1) }), // ~LT by Oct 2025
      Object.assign(new FinSimLib.Finance.Asset('Startup ETF',   3000,  2000), { purchaseDate: new Date(2025, 2, 1) }), // ST until Mar 2026
    ];

    const initialState = {
      metrics:         {},
      checkingAccount: new FinSimLib.Finance.Account(p.initialChecking),
      savingsAccount:  new FinSimLib.Finance.Account(p.initialSavings),
      assets,
      incomeYTD:       0,
      interestYTD:     0
    };

    this.sim = new FinSimLib.Core.Simulation(this.simStart, { initialState });

    this._registerReducers(accountService);
    this._registerHandlers(p);
    this._scheduleEvents();
  }

  _registerReducers(accountService) {
    // Salary → checking account + YTD tracking
    this.sim.reducers.register('SALARY_CREDIT', (state, action) => {
      accountService.transaction(state.checkingAccount, action.amount, null);
      return { ...state, incomeYTD: state.incomeYTD + action.amount };
    }, FinSimLib.Core.PRIORITY.CASH_FLOW, 'Salary Credit');

    // Interest → savings account + interest YTD (ordinary income)
    this.sim.reducers.register('INTEREST_CREDIT', (state, action) => {
      accountService.transaction(state.savingsAccount, action.amount, null);
      return {
        ...state,
        incomeYTD:   state.incomeYTD   + action.amount,
        interestYTD: state.interestYTD + action.amount
      };
    }, FinSimLib.Core.PRIORITY.CASH_FLOW, 'Interest Credit');

    // Asset sale proceeds → checking account
    new FinSimLib.Core.AccountTransactionReducer(
      { accountService, accountKey: 'checkingAccount' },
      'Asset Proceeds'
    ).registerWith(this.sim.reducers, 'ASSET_PROCEEDS');

    // CGT tax payment → debit checking; record metric by ST/LT bucket
    this.sim.reducers.register('CGT_PAYMENT', (state, action) => {
      accountService.transaction(state.checkingAccount, -action.tax, null);
      const key  = action.isLongTerm ? 'lt_cgt_paid' : 'st_cgt_paid';
      const list = state.metrics[key] || [];
      return {
        ...state,
        metrics: { ...state.metrics, [key]: [...list, action.tax] }
      };
    }, FinSimLib.Core.PRIORITY.TAX_APPLY, 'CGT Payment');

    // Income tax payment → debit checking; reset YTD counters
    this.sim.reducers.register('INCOME_TAX_PAYMENT', (state, action) => {
      accountService.transaction(state.checkingAccount, -action.amount, null);
      const list = state.metrics['income_tax_paid'] || [];
      return {
        ...state,
        incomeYTD:   0,
        interestYTD: 0,
        metrics: { ...state.metrics, income_tax_paid: [...list, action.amount] }
      };
    }, FinSimLib.Core.PRIORITY.TAX_APPLY, 'Income Tax Payment');

    // Generic metric appender
    new FinSimLib.Core.MetricReducer().registerWith(this.sim.reducers, 'RECORD_METRIC');

    // No-op reducer used as a "balance snapshot" marker — runs last so
    // its stateAfter on the DEBUG_ACTION node reflects the fully-updated state
    new FinSimLib.Core.NoOpReducer('Balance Snapshot').registerWith(this.sim.reducers, 'RECORD_BALANCE');
  }

  _registerHandlers(p) {
    // Monthly salary handler — checks data.amount for one-off overrides
    this.sim.register('MONTHLY_SALARY', new FinSimLib.Core.HandlerEntry(({ data }) => {
      const amount = data?.amount ?? p.salaryMonthly;
      return [
        new FinSimLib.Core.AmountAction('SALARY_CREDIT', amount),
        new FinSimLib.Core.RecordMetricAction('salary', amount),
        new FinSimLib.Core.RecordBalanceAction()
      ];
    }, 'Monthly Salary'));

    // Annual savings interest
    this.sim.register('ANNUAL_INTEREST', new FinSimLib.Core.HandlerEntry(({ state }) => {
      const interest = +((state.savingsAccount.balance * p.savingsInterestRate).toFixed(2));
      return [
        new FinSimLib.Core.AmountAction('INTEREST_CREDIT', interest),
        new FinSimLib.Core.RecordMetricAction('interest_income', interest),
        new FinSimLib.Core.RecordBalanceAction()
      ];
    }, 'Annual Interest'));

    // Quarterly asset sale — pops the last asset, determines ST vs LT hold
    this.sim.register('SELL_ASSET', new FinSimLib.Core.HandlerEntry(({ state, date }) => {
      const asset = state.assets.pop();
      if (!asset) return [new FinSimLib.Core.RecordBalanceAction()];

      const gain       = asset.value - asset.costBasis;
      const holdMs     = date.getTime() - asset.purchaseDate.getTime();
      const isLongTerm = holdMs > 365 * 24 * 60 * 60 * 1000;
      const rate       = isLongTerm ? p.longTermCgtRate : p.shortTermCgtRate;
      const tax        = +(Math.max(0, gain) * rate).toFixed(2);

      return [
        new FinSimLib.Core.AmountAction('ASSET_PROCEEDS', asset.value),
        { type: 'CGT_PAYMENT', tax, isLongTerm },
        new FinSimLib.Core.RecordMetricAction('assets_sold', asset.name),
        new FinSimLib.Core.RecordMetricAction(isLongTerm ? 'lt_gains' : 'st_gains', gain),
        new FinSimLib.Core.RecordBalanceAction()
      ];
    }, 'Sell Asset'));

    // Annual income tax — taxes (salary + interest) at flat rate, then resets YTD
    this.sim.register('ANNUAL_TAX', new FinSimLib.Core.HandlerEntry(({ state }) => {
      const tax = +(state.incomeYTD * p.incomeTaxRate).toFixed(2);
      return [
        new FinSimLib.Core.AmountAction('INCOME_TAX_PAYMENT', tax),
        new FinSimLib.Core.RecordMetricAction('annual_tax', tax),
        new FinSimLib.Core.RecordBalanceAction()
      ];
    }, 'Annual Tax'));
  }
}
