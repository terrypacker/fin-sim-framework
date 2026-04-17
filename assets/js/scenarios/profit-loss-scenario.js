/*
 * Copyright (c) 2026 Terry Packer.
 *
 * This file is part of Terry Packer's Work.
 * See www.terrypacker.com for further info.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { Account, AccountService } from '../finance/account.js';
import { Asset }                   from '../finance/asset.js';
import { Simulation }              from '../simulation-framework/simulation.js';
import { PRIORITY }                from '../simulation-framework/reducers.js';
import { HandlerEntry }            from '../simulation-framework/handlers.js';
import { AmountAction, RecordMetricAction, RecordBalanceAction } from '../simulation-framework/actions.js';
import { BaseScenario }            from './base-scenario.js';
import { EventSeries }             from './event-series.js';

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
  new EventSeries({ id: 'sell_asset',   label: 'Quarterly Asset Sales', type: 'SELL_ASSET',   interval: 'quarterly', enabled: true,                color: '#FF9800' }),
  new EventSeries({ id: 'quarterly_pl', label: 'Quarterly Profit/Loss', type: 'QUARTERLY_PL', interval: 'quarterly', enabled: true,                color: '#9C27B0' }),
  new EventSeries({ id: 'annual_tax',   label: 'Annual Tax Filing',     type: 'ANNUAL_TAX',   interval: 'annually',  enabled: true, startOffset: 1, color: '#F44336' }),
];

export class ProfitLossScenario extends BaseScenario {

  constructor({ params = {}, eventSeries = DEFAULT_EVENT_SERIES, customEvents = [] } = {}) {
    super({ eventSeries, customEvents });
    this.params = { ...DEFAULT_PARAMS, ...params };

    this.accountService = new AccountService();
    this.simStart = new Date(2025, 0, 1);
    this.simEnd   = new Date(2028, 0, 1);

    this._buildSim();
  }

  _buildSim() {
    const p   = this.params;
    const svc = this.accountService;

    // Assets with purchaseDates — mix of long-term and short-term holds
    // relative to simStart (2025-01-01)
    const assets = [
      Object.assign(new Asset('Tech Stock',   15000, 10000), { purchaseDate: new Date(2022, 0, 1) }), // LT (3+ yr)
      Object.assign(new Asset('Growth Fund',   8000,  6000), { purchaseDate: new Date(2023, 6, 1) }), // LT (1.5 yr)
      Object.assign(new Asset('REIT',          5000,  4500), { purchaseDate: new Date(2024, 9, 1) }), // ~LT by Oct 2025
      Object.assign(new Asset('Startup ETF',   3000,  2000), { purchaseDate: new Date(2025, 2, 1) }), // ST until Mar 2026
    ];

    const initialState = {
      metrics:         {},
      savingsAccount:  new Account(p.initialSavings),
      checkingAccount: new Account(p.initialChecking),
      assets,
      realizedGains:   0
    };

    this.sim = new Simulation(this.simStart, { initialState });

    this._registerReducers(svc);
    this._registerHandlers(p);
    this._scheduleEvents();
  }

  _registerReducers(accountService) {
    // Action chaining by emitting a next event
    this.sim.reducers.register(
        'REALIZE_GAIN',
        (state, action) => ({
          state: { ...state, realizedGains: state.realizedGains + action.amount },
          next:  [new AmountAction('CALCULATE_CAPITAL_GAINS_TAX', action.amount)]
        }),
        PRIORITY.COST_BASIS, 'Gain Realizer'
    );

    this.sim.reducers.register('CALCULATE_CAPITAL_GAINS_TAX',
        (state, action) => {
          const transactionTax  = action.amount * 0.15;
          const capitalGainsTax = state.capitalGainsTax ? [...state.capitalGainsTax] : [];
          capitalGainsTax.push(transactionTax);
          return {
            state: { ...state, capitalGainsTax },
            next:  [new RecordMetricAction('capital_gains_tax', transactionTax)]
          };
        }, PRIORITY.TAX_CALC, 'CGT Computer');

    this.sim.reducers.register('RECORD_METRIC', (state, action) => ({
      ...state,
      metrics: {
        ...state.metrics,
        [action.name]: [...(state.metrics[action.name] || []), action.value]
      }
    }), PRIORITY.METRICS, 'Metric Logger');

    this.sim.reducers.register('ADD_CASH', (state, action, date) => {
      accountService.transaction(state.savingsAccount, action.amount, date);
      return { ...state };
    }, PRIORITY.CASH_FLOW, 'Account Credit');

    this.sim.reducers.register('REMOVE_CASH', (state, action, date) => {
      accountService.transaction(state.savingsAccount, action.amount, date);
      return { ...state };
    }, PRIORITY.CASH_FLOW, 'Account Debit');

    // No-op reducer used as a "balance snapshot" marker — runs last so
    // its stateAfter on the DEBUG_ACTION node reflects the fully-updated state
    this.sim.reducers.register('RECORD_BALANCE', (state) => state, PRIORITY.LOGGING + 5, 'Balance Snapshot');
  }

  _registerHandlers(p) {
    this.sim.register('SELL_ASSET', new HandlerEntry((ctx) => {
      const toSell = ctx.state.assets.pop();
      if (!toSell) return [];
      const realizedGain = toSell.value - toSell.costBasis;
      return [
        new AmountAction('REALIZE_GAIN', realizedGain),
        new AmountAction('ADD_CASH', toSell.value),
        new RecordMetricAction('assets_sold', toSell.name),
        new RecordBalanceAction()
      ];
    }, 'Sell Asset'));

    this.sim.register('QUARTERLY_PL', new HandlerEntry(({ sim }) => {
      const profit = sim.rng() * 10000;
      return [
        new AmountAction('ADD_CASH', profit),
        new RecordMetricAction('quarterly_profit', profit),
        new RecordBalanceAction()
      ];
    }, 'Quarterly P/L'));

    this.sim.register('ANNUAL_TAX', new HandlerEntry((ctx) => {
      const tax = -(ctx.state.savingsAccount.balance * p.incomeTaxRate);
      return [
        new AmountAction('REMOVE_CASH', tax),
        new RecordMetricAction('annual_tax', tax),
        new RecordBalanceAction()
      ];
    }, 'Annual Tax'));
  }
}
