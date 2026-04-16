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

/**
 * simulation.test.mjs
 * Tests for Simulation Engine
 * Run with: node --test tests/simulation.test.mjs
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';
import { Assert } from './helpers/assert.js';

import { Account, AccountService } from '../assets/js/finance/account.js';
import { Asset } from '../assets/js/finance/asset.js';
import { Simulation } from '../assets/js/simulation-framework/simulation.js';
import { PRIORITY } from '../assets/js/simulation-framework/reducers.js';

test('Simulate annual event for 2 years', () => {
  const startYear = 2025;
  const sim = new Simulation(new Date(startYear, 0, 1));
  sim.scheduleAnnually({
    startDate: new Date(2025, 0, 1),
    type: 'ANNUAL_EVENT',
    data: { test: 'testing' },
    meta: { metaFlag: true }
  });

  sim.stepTo(new Date(startYear + 1, 0, 1));

  assert.ok(sim.bus.getHistory().length == 2, `Expected 2 events on bus, got ${sim.bus.getHistory().length}`);

  const event0 = sim.bus.getHistory()[0];
  assert.strictEqual(event0.sim, sim);
  Assert.datesEqual(event0.date, new Date(2025, 0, 1));
  assert.strictEqual(event0.type, 'ANNUAL_EVENT');
  assert.strictEqual(event0.payload.data.test, 'testing');
  assert.strictEqual(event0.payload.meta.metaFlag, true);

  const event1 = sim.bus.getHistory()[1];
  assert.strictEqual(event1.sim, sim);
  Assert.datesEqual(event1.date, new Date(2026, 0, 1));
  assert.strictEqual(event1.type, 'ANNUAL_EVENT');
  assert.strictEqual(event1.payload.data.test, 'testing');
  assert.strictEqual(event1.payload.meta.metaFlag, true);
});

test('Simulate annual event for 2 years wildcard subscriber', () => {
  const startYear = 2025;
  const sim = new Simulation(new Date(startYear, 0, 1));
  sim.scheduleAnnually({
    startDate: new Date(2025, 0, 1),
    type: 'ANNUAL_EVENT',
    data: { test: 'testing' },
    meta: { metaFlag: true }
  });

  const events = [];
  /* Listen to all messages */
  sim.bus.subscribe('*', (event) => {
    events.push(event);
  });

  sim.stepTo(new Date(startYear + 1, 0, 1));

  assert.ok(events.length === 2, `Expected 2 events in listener, got ${events.length}`);

  const event0 = events[0];
  assert.strictEqual(event0.sim, sim);
  Assert.datesEqual(event0.date, new Date(2025, 0, 1));
  assert.strictEqual(event0.type, 'ANNUAL_EVENT');
  assert.strictEqual(event0.payload.data.test, 'testing');
  assert.strictEqual(event0.payload.meta.metaFlag, true);

  const event1 = events[1];
  assert.strictEqual(event1.sim, sim);
  Assert.datesEqual(event1.date, new Date(2026, 0, 1));
  assert.strictEqual(event1.type, 'ANNUAL_EVENT');
  assert.strictEqual(event1.payload.data.test, 'testing');
  assert.strictEqual(event1.payload.meta.metaFlag, true);
});

test('Simulate annual event for 2 years specific subscriber', () => {
  const startYear = 2025;
  const sim = new Simulation(new Date(startYear, 0, 1));
  sim.scheduleAnnually({
    startDate: new Date(2025, 0, 1),
    type: 'ANNUAL_EVENT',
    data: { test: 'testing' },
    meta: { metaFlag: true }
  });

  sim.scheduleQuarterly({
    startDate: new Date(2025, 0, 1),
    type: 'QUARTERLY_EVENT',
    data: { test: 'data' },
    meta: { metaFlag: false }
  });

  const events = [];
  /* Listen to all messages */
  sim.bus.subscribe('ANNUAL_EVENT', (event) => {
    events.push(event);
  });

  sim.stepTo(new Date(startYear + 1, 0, 1));

  assert.ok(events.length === 2, `Expected 2 events in listener, got ${events.length}`);

  const event0 = events[0];
  assert.strictEqual(event0.sim, sim);
  Assert.datesEqual(event0.date, new Date(2025, 0, 1));
  assert.strictEqual(event0.type, 'ANNUAL_EVENT');
  assert.strictEqual(event0.payload.data.test, 'testing');
  assert.strictEqual(event0.payload.meta.metaFlag, true);

  const event1 = events[1];
  assert.strictEqual(event1.sim, sim);
  Assert.datesEqual(event1.date, new Date(2026, 0, 1));
  assert.strictEqual(event1.type, 'ANNUAL_EVENT');
  assert.strictEqual(event1.payload.data.test, 'testing');
  assert.strictEqual(event1.payload.meta.metaFlag, true);
});

test('Simulate annual event for two years with handler', () => {
  const startYear = 2025;
  const sim = new Simulation(new Date(startYear, 0, 1));
  sim.scheduleAnnually({
    startDate: new Date(2025, 0, 1),
    type: 'ANNUAL_EVENT',
    data: { test: 'testing' },
    meta: { metaFlag: true }
  });

  //Annual Handler just collects contexts
  const handlerEventContexts = [];
  sim.register('ANNUAL_EVENT', (ctx) => {
    handlerEventContexts.push(ctx);
    return [];
  });

  sim.stepTo(new Date(startYear + 1, 0, 1));

  assert.ok(sim.bus.getHistory().length === 2, `Expected 2 events, got ${sim.bus.getHistory().length}`);

  //Ensure the bus events internally are as expected
  const event0 = sim.bus.getHistory()[0];
  assert.strictEqual(event0.sim, sim);
  Assert.datesEqual(event0.date, new Date(2025, 0, 1));
  assert.strictEqual(event0.type, 'ANNUAL_EVENT');
  assert.strictEqual(event0.payload.data.test, 'testing');
  assert.strictEqual(event0.payload.meta.metaFlag, true);

  const event1 = sim.bus.getHistory()[1];
  assert.strictEqual(event1.sim, sim);
  Assert.datesEqual(event1.date, new Date(2026, 0, 1));
  assert.strictEqual(event1.type, 'ANNUAL_EVENT');
  assert.strictEqual(event1.payload.data.test, 'testing');
  assert.strictEqual(event1.payload.meta.metaFlag, true);

  //Ensure the contexts are correct
  const context0 = handlerEventContexts[0];
  //TODO assert me
  const context1 = handlerEventContexts[1];
  assert.strictEqual(context1.sim, sim);
  Assert.datesEqual(context1.date, new Date(2026, 0, 1));
  assert.strictEqual(event1.type, 'ANNUAL_EVENT');
  assert.strictEqual(event1.payload.data.test, 'testing');
  assert.strictEqual(event1.payload.meta.metaFlag, true);

});

test('Super complicated sim to deconstruct into smaller tests', () => {
  const accountService = new AccountService();

  //Create some assets
  const assets = [];
  assets.push(new Asset('item1', 1200, 200));
  assets.push(new Asset('item2', 10400, 400));
  assets.push(new Asset('item3', 20200, 200));
  assets.push(new Asset('item4', 9200, 1200));

  /*
   * The state cannot have any methods included in it
   * because of the structuredClone feature for replay
   *
   * @type {{metrics: {}, realizedGains: number, savingsAccount: Account, assets: *[]}}
   */
  const initialState = {
    metrics: { },
    realizedGains: 0,
    savingsAccount: new Account(0),
    assets: assets
  }

  const sim = new Simulation(new Date(2025, 0, 1), {
    initialState: initialState
  });

  //Sell Asset quarterly
  sim.scheduleQuarterly({
    startDate: new Date(2025, 0, 1),
    type: 'SELL_ASSET',
    data: { },
    meta: { metaFlag: true }
  });

  // Quarterly P/L
  sim.scheduleQuarterly({
    startDate: new Date(2025, 0, 1),
    type: 'QUARTERLY_PL',
    data: { test: 'testing' },
    meta: { metaFlag: true }
  });

  sim.scheduleAnnually({
    startDate: new Date(2026, 0, 1),
    type: 'ANNUAL_TAX',
    data: { test: 'testing' },
    meta: { metaFlag: true }
  });

  /** Reducers **/
  //Action chaining by emitting a next event
  sim.reducers.register(
      'REALIZE_GAIN',
      (state, action, date) => {
        return {
          state: {
            ...state,
            realizedGains: state.realizedGains + action.amount
          },
          next: [
            { type: 'CALCULATE_CAPITAL_GAINS_TAX', amount: action.amount }
          ]
        };
      },
      PRIORITY.COST_BASIS
  );

  //Handle adding cache to the account
  sim.reducers.register('CALCULATE_CAPITAL_GAINS_TAX', (state, action, date) => {
    const transactionTax = action.amount * 0.15;
    const capitalGainsTax = state.capitalGainsTax ?state.capitalGainsTax : [];
    capitalGainsTax.push(transactionTax);
    return {
      state: {
        ...state,
        capitalGainsTax: capitalGainsTax
      },
      next: [
        { type: 'RECORD_METRIC', name: 'capital_gains_tax', value: transactionTax },
      ]
    };
  });

  //Record metrics
  sim.reducers.register('RECORD_METRIC', (state, action, date) => {
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
  });

  //Credit account
  sim.reducers.register('ADD_CASH', (state, action, date) => {
    accountService.transaction(state.savingsAccount, action.amount, date);
    return {
      ...state
    };
  });

  //Debit account
  sim.reducers.register('REMOVE_CASH', (state, action, date) => {
    accountService.transaction(state.savingsAccount, action.amount, date);
    return {
      ...state
    };
  });

  /**  HANDLERS **/
  //Annual tax Handler
  sim.register('SELL_ASSET', (ctx) => {
    //Pick an asset to sell
    const toSell = ctx.state.assets.pop();
    if(toSell) {
      //if no assets left then we don't need to realize gains
      const realizedGain = toSell.value - toSell.costBasis;
      return [
        { type: 'REALIZE_GAIN', amount: realizedGain },
        { type: 'ADD_CASH', amount: toSell.value },
        { type: 'RECORD_METRIC', name: 'assets_sold', value: toSell.name },
      ];
    }else {
      return [];
    }
  });

  //Quarterly PL Handler
  sim.register('QUARTERLY_PL', ({ sim }) => {
    const profit = sim.rng() * 10000;
    return [
      { type: 'ADD_CASH', amount: profit },
      { type: 'RECORD_METRIC', name: 'quarterly_profit', value: profit }
    ];
  });

  //Annual tax Handler
  sim.register('ANNUAL_TAX', (ctx) => {
    const taxRate = 0.3;
    const tax = -(ctx.state.savingsAccount.balance * taxRate);
    return [
      { type: 'REMOVE_CASH', amount: tax },
      { type: 'RECORD_METRIC', name: 'annual_tax', value: tax }
    ];
  });


  /* Listen to all messages */
  sim.bus.subscribe('*', (event) => {
    console.log(
        `[${event.date.toDateString()}] ${event.type}`,
        event.payload
    );
  });

  //Simulat to some time in the future
  sim.stepTo(new Date(2028, 0, 1));

  console.log(sim.state);

  //Rewind
  //sim.rewindToDate(new Date(2028, 0, 1));

  //Replay to check
  //sim.stepTo(new Date(2030, 0, 1));
  //console.log(sim.state);
});