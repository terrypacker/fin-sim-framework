/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { Account, AccountService }  from '../finance/account.js';
import { Simulation }               from '../simulation-framework/simulation.js';
import { PRIORITY, MetricReducer, NoOpReducer } from '../simulation-framework/reducers.js';
import { HandlerEntry }             from '../simulation-framework/handlers.js';
import { RecordMetricAction, RecordBalanceAction } from '../simulation-framework/actions.js';
import { BaseScenario }             from './base-scenario.js';
import { EventSeries }              from './event-series.js';

export const DEFAULT_PARAMS = {
  monthlyExpenses:        5000,
  checkingMinBalance:     2000,
  checkingInterestRate:   0.02,
  incomeTaxRate:          0.22,
  capitalGainsTaxRate:    0.15,
  initialChecking:        20000,
  initialStocksValue:     200000,
  initialStocksCostBasis: 100000,
  stockDividendRate:      0.02,
  initialBondsValue:      100000,
  bondInterestRate:       0.04,
  initialRetirement:      500000,
  retirementAccessYear:   2030,
};

export const DEFAULT_EVENT_SERIES = [
  new EventSeries({ id: 'expenses',        label: 'Monthly Expenses',          type: 'MONTHLY_EXPENSES',         interval: 'monthly',  enabled: true,                color: '#F44336' }),
  new EventSeries({ id: 'dividends',       label: 'Annual Stock Dividends',    type: 'ANNUAL_DIVIDENDS',         interval: 'annually', enabled: true, startOffset: 1, color: '#4CAF50' }),
  new EventSeries({ id: 'bondInterest',    label: 'Annual Bond Interest',      type: 'ANNUAL_BOND_INTEREST',     interval: 'annually', enabled: true, startOffset: 1, color: '#2196F3' }),
  new EventSeries({ id: 'checkingInterest',label: 'Annual Checking Interest',  type: 'ANNUAL_CHECKING_INTEREST', interval: 'annually', enabled: true, startOffset: 1, color: '#00BCD4' }),
  new EventSeries({ id: 'tax',             label: 'Annual Tax Filing',         type: 'ANNUAL_TAX',               interval: 'annually', enabled: true, startOffset: 1, color: '#FF5722' }),
];

export class RetirementDrawdownScenario extends BaseScenario {
  /**
   * @param {object}        opts
   * @param {object}        opts.params       - Override DEFAULT_PARAMS
   * @param {EventSeries[]} opts.eventSeries  - Recurring event series
   * @param {Array}         opts.customEvents - One-off events [{type, date, amount?}]
   */
  constructor({ params = {}, eventSeries = DEFAULT_EVENT_SERIES, customEvents = [] } = {}) {
    super({ eventSeries, customEvents });
    this.params   = { ...DEFAULT_PARAMS, ...params };
    this.accountService = new AccountService();
    this.simStart = new Date(2026, 0, 1);
    this.simEnd   = new Date(2041, 0, 1);
    this._buildSim();
  }

  _buildSim() {
    const p   = this.params;
    const svc = this.accountService;
    const retirementAccessDate = new Date(p.retirementAccessYear, 0, 1);

    const initialState = {
      metrics: {},
      checkingAccount:   new Account(p.initialChecking),
      retirementAccount: new Account(p.initialRetirement),
      brokerageAccount: {
        stocks: [
          { name: 'US Total Market ETF', value: p.initialStocksValue * 0.6, costBasis: p.initialStocksCostBasis * 0.6, purchaseDate: new Date(2022, 0, 1), dividendRate: p.stockDividendRate },
          { name: 'International ETF',   value: p.initialStocksValue * 0.4, costBasis: p.initialStocksCostBasis * 0.4, purchaseDate: new Date(2023, 0, 1), dividendRate: p.stockDividendRate },
        ],
        bonds: [
          { name: 'Treasury Bond',  value: p.initialBondsValue * 0.5, costBasis: p.initialBondsValue * 0.5, interestRate: p.bondInterestRate },
          { name: 'Corporate Bond', value: p.initialBondsValue * 0.5, costBasis: p.initialBondsValue * 0.5, interestRate: p.bondInterestRate },
        ]
      },
      capitalGainsYTD:   0,
      ordinaryIncomeYTD: 0,
    };

    this.sim = new Simulation(this.simStart, { initialState });
    this._registerReducers(svc, p, retirementAccessDate);
    this._registerHandlers(p);
    this._scheduleEvents();
  }

  _registerReducers(svc, p, retirementAccessDate) {

    // ── Monthly expense debit ────────────────────────────────────────────────────
    // REPLENISH_CHECKING always runs first (DFS queue + handler pre-check).
    // If all funding sources are exhausted, the debit is capped at the available
    // balance so checking never drops below $0.
    this.sim.reducers.register('EXPENSE_DEBIT', (state, action) => {
      const debit = Math.min(action.amount, Math.max(0, state.checkingAccount.balance));
      if (debit > 0) svc.transaction(state.checkingAccount, -debit, null);
      return { ...state };
    }, PRIORITY.CASH_FLOW, 'Expense Debit');

    // ── Replenishment decision ───────────────────────────────────────────────────
    // Priority order: retirement (if accessible) → bonds → stocks.
    this.sim.reducers.register('REPLENISH_CHECKING', (state, action) => {
      const { deficit, skipRetirement, date } = action;

      // 1. Retirement account first (once accessible)
      const retirementReady = date && date >= retirementAccessDate;
      if (!skipRetirement && retirementReady && state.retirementAccount.balance > 0) {
        const withdraw = Math.min(deficit, state.retirementAccount.balance);
        const remaining = deficit - withdraw;
        return {
          state: { ...state },
          next:  [{ type: 'RETIREMENT_WITHDRAWAL', amount: withdraw, remainingDeficit: remaining }]
        };
      }

      // 2. Sell bonds from brokerage
      if (state.brokerageAccount.bonds.length > 0) {
        return { state: { ...state }, next: [{ type: 'SELL_BOND', deficit }] };
      }

      // 3. Sell stocks from brokerage
      if (state.brokerageAccount.stocks.length > 0) {
        return { state: { ...state }, next: [{ type: 'SELL_STOCK', deficit }] };
      }


      // No funds available — checking remains below minimum
      return { ...state };
    }, PRIORITY.PRE_PROCESS, 'Replenish Checking');

    // ── Retirement withdrawal ────────────────────────────────────────────────────
    this.sim.reducers.register('RETIREMENT_WITHDRAWAL', (state, action) => {
      svc.transaction(state.retirementAccount, -action.amount, null);
      svc.transaction(state.checkingAccount,    action.amount, null);
      const newState = { ...state };

      // If retirement couldn't cover the full deficit, cascade to brokerage
      const remaining = action.remainingDeficit ?? 0;
      if (remaining > 0) {
        if (newState.brokerageAccount.bonds.length > 0) {
          return { state: newState, next: [{ type: 'SELL_BOND', deficit: remaining }] };
        }
        if (newState.brokerageAccount.stocks.length > 0) {
          return { state: newState, next: [{ type: 'SELL_STOCK', deficit: remaining }] };
        }
      }
      return newState;
    }, PRIORITY.CASH_FLOW, 'Retirement Withdrawal');

    // ── Sell bond (partial if one position covers the deficit) ──────────────────
    this.sim.reducers.register('SELL_BOND', (state, action) => {
      const bonds   = [...state.brokerageAccount.bonds];
      const bond    = bonds[0];
      const deficit = action.deficit;

      let proceeds, gain;
      if (bond.value <= deficit) {
        // Sell entire position
        proceeds = bond.value;
        gain     = Math.max(0, bond.value - bond.costBasis);
        bonds.shift();
      } else {
        // Partial sell — enough to cover deficit
        const fraction = deficit / bond.value;
        proceeds  = deficit;
        gain      = Math.max(0, fraction * (bond.value - bond.costBasis));
        bonds[0]  = { ...bond, value: bond.value - deficit, costBasis: bond.costBasis * (1 - fraction) };
      }

      svc.transaction(state.checkingAccount, proceeds, null);
      const newState = {
        ...state,
        brokerageAccount: { ...state.brokerageAccount, bonds },
        capitalGainsYTD:  state.capitalGainsYTD + gain
      };

      const remaining = deficit - proceeds;
      if (remaining > 0) {
        if (bonds.length > 0)                          return { state: newState, next: [{ type: 'SELL_BOND',  deficit: remaining }] };
        if (state.brokerageAccount.stocks.length > 0)  return { state: newState, next: [{ type: 'SELL_STOCK', deficit: remaining }] };
      }
      return newState;
    }, PRIORITY.POSITION_UPDATE, 'Sell Bond');

    // ── Sell stock (partial if one position covers the deficit) ─────────────────
    this.sim.reducers.register('SELL_STOCK', (state, action) => {
      const stocks  = [...state.brokerageAccount.stocks];
      const stock   = stocks[0];
      const deficit = action.deficit;

      let proceeds, gain;
      if (stock.value <= deficit) {
        proceeds = stock.value;
        gain     = Math.max(0, stock.value - stock.costBasis);
        stocks.shift();
      } else {
        const fraction = deficit / stock.value;
        proceeds  = deficit;
        gain      = Math.max(0, fraction * (stock.value - stock.costBasis));
        stocks[0] = { ...stock, value: stock.value - deficit, costBasis: stock.costBasis * (1 - fraction) };
      }

      svc.transaction(state.checkingAccount, proceeds, null);
      const newState = {
        ...state,
        brokerageAccount: { ...state.brokerageAccount, stocks },
        capitalGainsYTD:  state.capitalGainsYTD + gain
      };

      const remaining = deficit - proceeds;
      if (remaining > 0 && stocks.length > 0) {
        return { state: newState, next: [{ type: 'SELL_STOCK', deficit: remaining }] };
      }
      return newState;
    }, PRIORITY.POSITION_UPDATE, 'Sell Stock');

    // ── Income credits (all flow to checking as ordinary income) ────────────────
    this.sim.reducers.register('DIVIDEND_CREDIT', (state, action) => {
      svc.transaction(state.checkingAccount, action.amount, null);
      return { ...state, ordinaryIncomeYTD: state.ordinaryIncomeYTD + action.amount };
    }, PRIORITY.CASH_FLOW, 'Dividend Credit');

    this.sim.reducers.register('BOND_INTEREST_CREDIT', (state, action) => {
      svc.transaction(state.checkingAccount, action.amount, null);
      return { ...state, ordinaryIncomeYTD: state.ordinaryIncomeYTD + action.amount };
    }, PRIORITY.CASH_FLOW, 'Bond Interest Credit');

    this.sim.reducers.register('CHECKING_INTEREST_CREDIT', (state, action) => {
      svc.transaction(state.checkingAccount, action.amount, null);
      return { ...state, ordinaryIncomeYTD: state.ordinaryIncomeYTD + action.amount };
    }, PRIORITY.CASH_FLOW, 'Checking Interest Credit');

    // ── Annual tax payments ──────────────────────────────────────────────────────
    // Capped at available balance in case all funding sources are exhausted.
    this.sim.reducers.register('CAPITAL_GAINS_TAX', (state, action) => {
      const debit = Math.min(action.amount, Math.max(0, state.checkingAccount.balance));
      if (debit > 0) svc.transaction(state.checkingAccount, -debit, null);
      const list = state.metrics['capital_gains_tax'] || [];
      return {
        ...state,
        capitalGainsYTD: 0,
        metrics: { ...state.metrics, capital_gains_tax: [...list, action.amount] }
      };
    }, PRIORITY.TAX_APPLY, 'Capital Gains Tax');

    this.sim.reducers.register('INCOME_TAX', (state, action) => {
      const debit = Math.min(action.amount, Math.max(0, state.checkingAccount.balance));
      if (debit > 0) svc.transaction(state.checkingAccount, -debit, null);
      const list = state.metrics['income_tax'] || [];
      return {
        ...state,
        ordinaryIncomeYTD: 0,
        metrics: { ...state.metrics, income_tax: [...list, action.amount] }
      };
    }, PRIORITY.TAX_APPLY, 'Income Tax');

    // ── Generic metric + balance marker ─────────────────────────────────────────
    new MetricReducer().registerWith(this.sim.reducers, 'RECORD_METRIC');
    new NoOpReducer('Balance Snapshot').registerWith(this.sim.reducers, 'RECORD_BALANCE');
  }

  _registerHandlers(p) {

    // Monthly expenses — pre-checks whether checking needs replenishment before
    // the debit would occur. If so, emits REPLENISH_CHECKING first. Because the
    // action queue uses DFS (children unshifted before siblings), the full
    // replenishment chain completes before EXPENSE_DEBIT runs, guaranteeing
    // checking never drops below checkingMinBalance due to a monthly debit.
    this.sim.register('MONTHLY_EXPENSES', new HandlerEntry(({ data, date, state }) => {
      const amount          = data?.amount ?? p.monthlyExpenses;
      const postDebitBal    = state.checkingAccount.balance - amount;
      const deficit         = p.checkingMinBalance - postDebitBal;
      const actions         = [];
      if (deficit > 0) {
        actions.push({ type: 'REPLENISH_CHECKING', deficit, skipRetirement: false, date });
      }
      actions.push(
        { type: 'EXPENSE_DEBIT', amount },
        new RecordMetricAction('monthly_expenses', amount),
        new RecordBalanceAction()
      );
      return actions;
    }, 'Monthly Expenses'));

    // Annual dividends on stock holdings (ordinary income)
    this.sim.register('ANNUAL_DIVIDENDS', new HandlerEntry(({ state }) => {
      const stocks      = state.brokerageAccount.stocks;
      const totalValue  = stocks.reduce((sum, s) => sum + s.value, 0);
      const rate        = stocks.length > 0 ? stocks[0].dividendRate : p.stockDividendRate;
      const amount      = +(totalValue * rate).toFixed(2);
      if (amount <= 0) return [new RecordBalanceAction()];
      return [
        { type: 'DIVIDEND_CREDIT', amount },
        new RecordMetricAction('dividends', amount),
        new RecordBalanceAction()
      ];
    }, 'Annual Dividends'));

    // Annual bond interest — sum across all bond positions (ordinary income)
    this.sim.register('ANNUAL_BOND_INTEREST', new HandlerEntry(({ state }) => {
      const amount = +(state.brokerageAccount.bonds.reduce((s, b) => s + b.value * b.interestRate, 0)).toFixed(2);
      if (amount <= 0) return [new RecordBalanceAction()];
      return [
        { type: 'BOND_INTEREST_CREDIT', amount },
        new RecordMetricAction('bond_interest', amount),
        new RecordBalanceAction()
      ];
    }, 'Annual Bond Interest'));

    // Annual checking interest (ordinary income)
    this.sim.register('ANNUAL_CHECKING_INTEREST', new HandlerEntry(({ state }) => {
      const amount = +(state.checkingAccount.balance * p.checkingInterestRate).toFixed(2);
      if (amount <= 0) return [new RecordBalanceAction()];
      return [
        { type: 'CHECKING_INTEREST_CREDIT', amount },
        new RecordMetricAction('checking_interest', amount),
        new RecordBalanceAction()
      ];
    }, 'Annual Checking Interest'));

    // Annual tax — pre-checks whether the combined tax bill would overdraft checking.
    // If so, replenishment runs first (same DFS guarantee as monthly expenses).
    this.sim.register('ANNUAL_TAX', new HandlerEntry(({ state, date }) => {
      const cgTax      = +(state.capitalGainsYTD  * p.capitalGainsTaxRate).toFixed(2);
      const incomeTax  = +(state.ordinaryIncomeYTD * p.incomeTaxRate).toFixed(2);
      const totalTax   = cgTax + incomeTax;
      const actions    = [];

      if (totalTax > 0) {
        const postPayBal = state.checkingAccount.balance - totalTax;
        const deficit    = p.checkingMinBalance - postPayBal;
        if (deficit > 0) {
          actions.push({ type: 'REPLENISH_CHECKING', deficit, skipRetirement: false, date });
        }
      }

      if (cgTax > 0)     actions.push({ type: 'CAPITAL_GAINS_TAX', amount: cgTax });
      if (incomeTax > 0) actions.push({ type: 'INCOME_TAX',        amount: incomeTax });
      actions.push(
        new RecordMetricAction('capital_gains_tax_annual', cgTax),
        new RecordMetricAction('income_tax_annual', incomeTax),
        new RecordBalanceAction()
      );
      return actions;
    }, 'Annual Tax'));
  }
}
