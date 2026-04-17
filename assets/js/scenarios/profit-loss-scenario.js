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

import {Account, AccountService} from "../finance/account.js";
import {Asset} from "../finance/asset.js";
import {Simulation} from "../simulation-framework/simulation.js";
import { PRIORITY } from '../simulation-framework/reducers.js';

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
  { id: 'salary',   label: 'Monthly Salary',          type: 'MONTHLY_SALARY',  interval: 'monthly',   enabled: true },
  { id: 'interest', label: 'Annual Savings Interest',  type: 'ANNUAL_INTEREST', interval: 'annually',  enabled: true, startOffset: 1 },
  { id: 'assets',   label: 'Quarterly Asset Sales',    type: 'SELL_ASSET',      interval: 'quarterly', enabled: true },
  { id: 'tax',      label: 'Annual Income Tax Filing', type: 'ANNUAL_TAX',      interval: 'annually',  enabled: true, startOffset: 1 },
];

export class ProfitLossScenario {

  constructor({ params = {}, eventSeries = DEFAULT_EVENT_SERIES, customEvents = [] } = {}) {
    this.params       = { ...DEFAULT_PARAMS, ...params };
    this.eventSeries  = eventSeries;
    this.customEvents = customEvents;

    this.accountService = new AccountService();
    this.simStart = new Date(2025, 0, 1);
    this.simEnd = new Date(2028, 0, 1);

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
      savingsAccount: new Account(p.initialSavings),
      checkingAccount: new Account(p.initialChecking),
      assets,
      realizedGains: 0
    };

    this.sim = new Simulation(this.simStart, { initialState });

    this._registerReducers(svc);
    this._registerHandlers(p);
    this._scheduleEvents();
  }

  _registerReducers(accountService) {
    /** Reducers **/
    //Action chaining by emitting a next event
    this.sim.reducers.register(
        'REALIZE_GAIN',
        (state, action, date) => {
          return {
            state: {
              ...state,
              realizedGains: state.realizedGains + action.amount
            },
            next: [
              {type: 'CALCULATE_CAPITAL_GAINS_TAX', amount: action.amount}
            ]
          };
        },
        PRIORITY.COST_BASIS, 'Gain Realizer'
    );

    //Handle adding cache to the account
    this.sim.reducers.register('CALCULATE_CAPITAL_GAINS_TAX',
        (state, action, date) => {
          const transactionTax = action.amount * 0.15;
          const capitalGainsTax = state.capitalGainsTax ? state.capitalGainsTax
              : [];
          capitalGainsTax.push(transactionTax);
          return {
            state: {
              ...state,
              capitalGainsTax: capitalGainsTax
            },
            next: [
              {
                type: 'RECORD_METRIC',
                name: 'capital_gains_tax',
                value: transactionTax
              },
            ]
          };
        }, PRIORITY.TAX_CALC, 'CGT Computer');

    //Record metrics
    this.sim.reducers.register('RECORD_METRIC', (state, action, date) => {
      return {
        ...state,
        metrics: {
          ...state.metrics,
          [action.name]: [
            ...(state.metrics[action.name] || []),
            action.value
          ]
        }
      };
    }, PRIORITY.METRICS, 'Metric Logger');

    //Credit account
    this.sim.reducers.register('ADD_CASH', (state, action, date) => {
      accountService.transaction(state.savingsAccount, action.amount, date);
      return {
        ...state
      };
    }, PRIORITY.CASH_FLOW, 'Account Credit');

    //Debit account
    this.sim.reducers.register('REMOVE_CASH', (state, action, date) => {
      accountService.transaction(state.savingsAccount, action.amount, date);
      return {
        ...state
      };
    }, PRIORITY.CASH_FLOW, 'Account Debit');

    // No-op reducer used as a "balance snapshot" marker — runs last so
    // its stateAfter on the DEBUG_ACTION node reflects the fully-updated state
    this.sim.reducers.register('RECORD_BALANCE', (state) => state, PRIORITY.LOGGING + 5, 'Balance Snapshot');

  }

  _registerHandlers(p) {
    //Sell Asset Handler
    this.sim.register('SELL_ASSET', (ctx) => {
      //Pick an asset to sell
      const toSell = ctx.state.assets.pop();
      if (toSell) {
        //if no assets left then we don't need to realize gains
        const realizedGain = toSell.value - toSell.costBasis;
        return [
          { type: 'REALIZE_GAIN', amount: realizedGain },
          { type: 'ADD_CASH', amount: toSell.value },
          { type: 'RECORD_METRIC', name: 'assets_sold', value: toSell.name },
          { type: 'RECORD_BALANCE' }
        ];
      } else {
        return [];
      }
    });

    //Quarterly PL Handler
    this.sim.register('QUARTERLY_PL', ({sim}) => {
      const profit = sim.rng() * 10000;
      return [
        { type: 'ADD_CASH', amount: profit },
        { type: 'RECORD_METRIC', name: 'quarterly_profit', value: profit },
        { type: 'RECORD_BALANCE' }
      ];
    });

    //Annual tax Handler
    this.sim.register('ANNUAL_TAX', (ctx) => {
      const taxRate = 0.3;
      const tax = -(ctx.state.savingsAccount.balance * taxRate);
      return [
        { type: 'REMOVE_CASH', amount: tax },
        { type: 'RECORD_METRIC', name: 'annual_tax', value: tax },
        { type: 'RECORD_BALANCE' }
      ];
    });
  }

  _scheduleEvents() {
    //Sell Asset quarterly
    this.sim.scheduleQuarterly({
      startDate: new Date(2025, 0, 1),
      type: 'SELL_ASSET',
      data: {},
      meta: { metaFlag: true }
    });

    // Quarterly P/L
    this.sim.scheduleQuarterly({
      startDate: new Date(2025, 0, 1),
      type: 'QUARTERLY_PL',
      data: { test: 'testing' },
      meta: { metaFlag: true }
    });

    this.sim.scheduleAnnually({
      startDate: new Date(2026, 0, 1),
      type: 'ANNUAL_TAX',
      data: { test: 'testing' },
      meta: { metaFlag: true }
    });
  }
}
