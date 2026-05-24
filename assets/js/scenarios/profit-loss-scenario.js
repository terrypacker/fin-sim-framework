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
  new FinSimLib.Core.EventSeries({ id: 'sell_asset',   label: 'Quarterly Asset Sales', type: 'SELL_ASSET',   interval: 'quarterly', enabled: true,                color: '#FF9800' }),
  new FinSimLib.Core.EventSeries({ id: 'quarterly_pl', label: 'Quarterly Profit/Loss', type: 'QUARTERLY_PL', interval: 'quarterly', enabled: true,                color: '#9C27B0' }),
  new FinSimLib.Core.EventSeries({ id: 'annual_tax',   label: 'Annual Tax Filing',     type: 'ANNUAL_TAX',   interval: 'annually',  enabled: true, startOffset: 1, color: '#F44336' }),
];

export class ProfitLossScenario extends FinSimLib.Scenarios.BaseScenario {

  constructor({ params = {}, eventSeries = DEFAULT_EVENT_SERIES, customEvents = [] } = {}) {
    super({ eventSeries, customEvents });
    this.params = { ...DEFAULT_PARAMS, ...params };

    this.accountService = new FinSimLib.Finance.AccountService();
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
      Object.assign(new FinSimLib.Finance.Asset('Tech Stock',   15000, 10000), { purchaseDate: new Date(2022, 0, 1) }), // LT (3+ yr)
      Object.assign(new FinSimLib.Finance.Asset('Growth Fund',   8000,  6000), { purchaseDate: new Date(2023, 6, 1) }), // LT (1.5 yr)
      Object.assign(new FinSimLib.Finance.Asset('REIT',          5000,  4500), { purchaseDate: new Date(2024, 9, 1) }), // ~LT by Oct 2025
      Object.assign(new FinSimLib.Finance.Asset('Startup ETF',   3000,  2000), { purchaseDate: new Date(2025, 2, 1) }), // ST until Mar 2026
    ];

    const initialState = {
      metrics:         {},
      savingsAccount:  new FinSimLib.Account(p.initialSavings),
      checkingAccount: new FinSimLib.Account(p.initialChecking),
      assets,
      realizedGains:   0
    };

    this.sim = new FinSimLib.Simulation(this.simStart, { initialState });

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
          next:  [new FinSimLib.Core.AmountAction('CALCULATE_CAPITAL_GAINS_TAX', action.amount)]
        }),
        FinSimLib.Core.PRIORITY.COST_BASIS, 'Gain Realizer'
    );

    this.sim.reducers.register('CALCULATE_CAPITAL_GAINS_TAX',
        (state, action) => {
          const transactionTax  = action.amount * 0.15;
          const capitalGainsTax = state.capitalGainsTax ? [...state.capitalGainsTax] : [];
          capitalGainsTax.push(transactionTax);
          return {
            state: { ...state, capitalGainsTax },
            next:  [new FinSimLib.Core.RecordMetricAction('capital_gains_tax', transactionTax)]
          };
        }, FinSimLib.Core.PRIORITY.TAX_CALC, 'CGT Computer');

    new FinSimLib.Core.MetricReducer().registerWith(this.sim.reducers, 'RECORD_METRIC');

    new FinSimLib.Core.AccountTransactionReducer(
      { accountService, accountKey: 'savingsAccount' },
      'Account Credit'
    ).registerWith(this.sim.reducers, 'ADD_CASH');

    new FinSimLib.Core.AccountTransactionReducer(
      { accountService, accountKey: 'savingsAccount' },
      'Account Debit'
    ).registerWith(this.sim.reducers, 'REMOVE_CASH');

    // No-op reducer used as a "balance snapshot" marker — runs last so
    // its stateAfter on the DEBUG_ACTION node reflects the fully-updated state
    new FinSimLib.Core.NoOpReducer('Balance Snapshot').registerWith(this.sim.reducers, 'RECORD_BALANCE');
  }

  _registerHandlers(p) {
    this.sim.register('SELL_ASSET', new FinSimLib.Core.HandlerEntry((ctx) => {
      const toSell = ctx.state.assets.pop();
      if (!toSell) return [];
      const realizedGain = toSell.value - toSell.costBasis;
      return [
        new FinSimLib.Core.AmountAction('REALIZE_GAIN', realizedGain),
        new FinSimLib.Core.AmountAction('ADD_CASH', toSell.value),
        new FinSimLib.Core.RecordMetricAction('assets_sold', toSell.name),
        new FinSimLib.Core.RecordBalanceAction()
      ];
    }, 'Sell Asset'));

    this.sim.register('QUARTERLY_PL', new FinSimLib.Core.HandlerEntry(({ sim }) => {
      const profit = sim.rng() * 10000;
      return [
        new FinSimLib.Core.AmountAction('ADD_CASH', profit),
        new FinSimLib.Core.RecordMetricAction('quarterly_profit', profit),
        new FinSimLib.Core.RecordBalanceAction()
      ];
    }, 'Quarterly P/L'));

    this.sim.register('ANNUAL_TAX', new FinSimLib.Core.HandlerEntry((ctx) => {
      const tax = -(ctx.state.savingsAccount.balance * p.incomeTaxRate);
      return [
        new FinSimLib.Core.AmountAction('REMOVE_CASH', tax),
        new FinSimLib.Core.RecordMetricAction('annual_tax', tax),
        new FinSimLib.Core.RecordBalanceAction()
      ];
    }, 'Annual Tax'));
  }
}
