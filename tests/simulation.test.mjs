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

// ─── Helper ──────────────────────────────────────────────────────────────────
//
// Builds a fresh simulation pre-wired with the financial reducers and handlers
// from the original exploration test.  Tests that only need a bare simulation
// create one directly rather than using this helper.
//
// Asset array (last element is popped first by SELL_ASSET):
//   index 3 → item4  value=9200  costBasis=1200  gain=8000
//   index 2 → item3  value=20200 costBasis=200   gain=20000
//   index 1 → item2  value=10400 costBasis=400   gain=10000
//   index 0 → item1  value=1200  costBasis=200   gain=1000
//
function buildFinancialSim({ seed = 1, assets } = {}) {
  const accountService = new AccountService();

  const defaultAssets = [
    new Asset('item1', 1200,  200),
    new Asset('item2', 10400, 400),
    new Asset('item3', 20200, 200),
    new Asset('item4', 9200,  1200),
  ];

  const initialState = {
    metrics:       {},
    realizedGains: 0,
    savingsAccount: new Account(0),
    assets: assets ?? defaultAssets,
  };

  const sim = new Simulation(new Date(2025, 0, 1), { seed, initialState });

  // ── Reducers ────────────────────────────────────────────────────────────
  sim.reducers.register('REALIZE_GAIN', (state, action) => ({
    state: { ...state, realizedGains: state.realizedGains + action.amount },
    next:  [{ type: 'CALCULATE_CAPITAL_GAINS_TAX', amount: action.amount }]
  }), PRIORITY.COST_BASIS, 'Gain Realizer');

  sim.reducers.register('CALCULATE_CAPITAL_GAINS_TAX', (state, action) => {
    const tax            = action.amount * 0.15;
    const capitalGainsTax = [...(state.capitalGainsTax || []), tax];
    return {
      state: { ...state, capitalGainsTax },
      next:  [{ type: 'RECORD_METRIC', name: 'capital_gains_tax', value: tax }]
    };
  }, PRIORITY.TAX_CALC, 'CGT Computer');

  sim.reducers.register('RECORD_METRIC', (state, action) => ({
    ...state,
    metrics: {
      ...state.metrics,
      [action.name]: [...(state.metrics[action.name] || []), action.value]
    }
  }), PRIORITY.METRICS, 'Metric Logger');

  sim.reducers.register('ADD_CASH', (state, action) => {
    accountService.transaction(state.savingsAccount, action.amount, null);
    return { ...state };
  }, PRIORITY.CASH_FLOW, 'Account Credit');

  sim.reducers.register('REMOVE_CASH', (state, action) => {
    accountService.transaction(state.savingsAccount, action.amount, null);
    return { ...state };
  }, PRIORITY.CASH_FLOW, 'Account Debit');

  // ── Handlers ─────────────────────────────────────────────────────────────
  sim.register('SELL_ASSET', (ctx) => {
    const toSell = ctx.state.assets.pop();
    if (!toSell) return [];
    const gain = toSell.value - toSell.costBasis;
    return [
      { type: 'REALIZE_GAIN',   amount: gain },
      { type: 'ADD_CASH',       amount: toSell.value },
      { type: 'RECORD_METRIC',  name: 'assets_sold', value: toSell.name },
    ];
  });

  sim.register('QUARTERLY_PL', ({ sim }) => {
    const profit = sim.rng() * 10000;
    return [
      { type: 'ADD_CASH',      amount: profit },
      { type: 'RECORD_METRIC', name: 'quarterly_profit', value: profit },
    ];
  });

  sim.register('ANNUAL_TAX', (ctx) => {
    const taxRate = 0.3;
    const tax = -(ctx.state.savingsAccount.balance * taxRate);
    return [
      { type: 'REMOVE_CASH',   amount: tax },
      { type: 'RECORD_METRIC', name: 'annual_tax', value: tax },
    ];
  });

  return { sim, accountService };
}

// ─── Scheduling ──────────────────────────────────────────────────────────────

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
  assert.strictEqual(context0.sim, sim);
  Assert.datesEqual(context0.date, new Date(2025, 0, 1));
  assert.strictEqual(context0.data.test, 'testing');
  assert.strictEqual(context0.meta.metaFlag, true);

  const context1 = handlerEventContexts[1];
  assert.strictEqual(context1.sim, sim);
  Assert.datesEqual(context1.date, new Date(2026, 0, 1));
  assert.strictEqual(context1.data.test, 'testing');
  assert.strictEqual(context1.meta.metaFlag, true);
});

// ─── SELL_ASSET handler ───────────────────────────────────────────────────────

test('SELL_ASSET: last asset is removed from state', () => {
  const { sim } = buildFinancialSim();
  sim.scheduleQuarterly({ startDate: new Date(2025, 0, 1), type: 'SELL_ASSET' });
  sim.stepTo(new Date(2025, 0, 1));

  // assets = [item1, item2, item3, item4]; pop() removes item4
  assert.strictEqual(sim.state.assets.length, 3);
});

test('SELL_ASSET: realized gain accumulated in state.realizedGains', () => {
  const { sim } = buildFinancialSim();
  sim.scheduleQuarterly({ startDate: new Date(2025, 0, 1), type: 'SELL_ASSET' });
  sim.stepTo(new Date(2025, 0, 1));

  // item4: value=9200, costBasis=1200, gain=8000
  assert.strictEqual(sim.state.realizedGains, 8000);
});

test('SELL_ASSET: capital gains tax chain stores 15% of gain in state', () => {
  const { sim } = buildFinancialSim();
  sim.scheduleQuarterly({ startDate: new Date(2025, 0, 1), type: 'SELL_ASSET' });
  sim.stepTo(new Date(2025, 0, 1));

  // 8000 * 0.15 = 1200
  assert.ok(Array.isArray(sim.state.capitalGainsTax), 'capitalGainsTax should be an array');
  assert.strictEqual(sim.state.capitalGainsTax.length, 1);
  assert.strictEqual(sim.state.capitalGainsTax[0], 1200);
});

test('SELL_ASSET: asset name recorded in assets_sold metric', () => {
  const { sim } = buildFinancialSim();
  sim.scheduleQuarterly({ startDate: new Date(2025, 0, 1), type: 'SELL_ASSET' });
  sim.stepTo(new Date(2025, 0, 1));

  assert.deepStrictEqual(sim.state.metrics.assets_sold, ['item4']);
});

test('SELL_ASSET: capital gains tax amount recorded in capital_gains_tax metric', () => {
  const { sim } = buildFinancialSim();
  sim.scheduleQuarterly({ startDate: new Date(2025, 0, 1), type: 'SELL_ASSET' });
  sim.stepTo(new Date(2025, 0, 1));

  assert.ok(Array.isArray(sim.state.metrics.capital_gains_tax));
  assert.strictEqual(sim.state.metrics.capital_gains_tax.length, 1);
  assert.strictEqual(sim.state.metrics.capital_gains_tax[0], 1200);
});

test('SELL_ASSET: no-op when asset list is empty', () => {
  const { sim } = buildFinancialSim({ assets: [] });
  sim.scheduleQuarterly({ startDate: new Date(2025, 0, 1), type: 'SELL_ASSET' });
  sim.stepTo(new Date(2025, 0, 1));

  assert.strictEqual(sim.state.realizedGains, 0);
  assert.strictEqual(sim.state.savingsAccount.balance, 0);
  assert.strictEqual(sim.state.assets.length, 0);
});

test('SELL_ASSET: all 4 assets sold over 4 quarterly events with correct total gain', () => {
  const { sim } = buildFinancialSim();
  sim.scheduleQuarterly({ startDate: new Date(2025, 0, 1), type: 'SELL_ASSET' });

  // Jan, Apr, Jul, Oct 2025 = 4 events
  sim.stepTo(new Date(2025, 9, 1));

  assert.strictEqual(sim.state.assets.length, 0);

  // item4(8000) + item3(20000) + item2(10000) + item1(1000) = 39000
  assert.strictEqual(sim.state.realizedGains, 39000);

  // Four CGT entries
  assert.strictEqual(sim.state.capitalGainsTax.length, 4);

  // All four assets in metric
  assert.strictEqual(sim.state.metrics.assets_sold.length, 4);
  assert.deepStrictEqual(
    sim.state.metrics.assets_sold,
    ['item4', 'item3', 'item2', 'item1']
  );
});

// ─── QUARTERLY_PL handler ─────────────────────────────────────────────────────

test('QUARTERLY_PL: credits savings account with a positive profit', () => {
  const { sim } = buildFinancialSim({ seed: 1 });
  sim.scheduleQuarterly({ startDate: new Date(2025, 0, 1), type: 'QUARTERLY_PL' });
  sim.stepTo(new Date(2025, 0, 1));

  assert.ok(
    sim.state.savingsAccount.balance > 0,
    `balance should be positive after QUARTERLY_PL, got ${sim.state.savingsAccount.balance}`
  );
});

test('QUARTERLY_PL: records one profit metric entry per event', () => {
  const { sim } = buildFinancialSim({ seed: 1 });
  sim.scheduleQuarterly({ startDate: new Date(2025, 0, 1), type: 'QUARTERLY_PL' });
  sim.stepTo(new Date(2025, 0, 1));

  assert.ok(Array.isArray(sim.state.metrics.quarterly_profit));
  assert.strictEqual(sim.state.metrics.quarterly_profit.length, 1);
  assert.ok(sim.state.metrics.quarterly_profit[0] > 0);
});

test('QUARTERLY_PL: 4 profit entries recorded after 4 quarterly events', () => {
  const { sim } = buildFinancialSim({ seed: 1 });
  sim.scheduleQuarterly({ startDate: new Date(2025, 0, 1), type: 'QUARTERLY_PL' });

  // Jan, Apr, Jul, Oct
  sim.stepTo(new Date(2025, 9, 1));

  assert.strictEqual(sim.state.metrics.quarterly_profit.length, 4);
});

// ─── ANNUAL_TAX handler ───────────────────────────────────────────────────────

test('ANNUAL_TAX: records a negative annual_tax metric entry', () => {
  const { sim } = buildFinancialSim({ seed: 1 });

  // Seed the account with profit before tax fires
  sim.scheduleQuarterly({ startDate: new Date(2025, 0, 1), type: 'QUARTERLY_PL' });
  sim.scheduleAnnually({ startDate: new Date(2026, 0, 1),  type: 'ANNUAL_TAX'  });
  sim.stepTo(new Date(2026, 0, 1));

  assert.ok(Array.isArray(sim.state.metrics.annual_tax));
  assert.strictEqual(sim.state.metrics.annual_tax.length, 1);
  // tax = -(balance * 0.3) → negative
  assert.ok(
    sim.state.metrics.annual_tax[0] < 0,
    `annual_tax metric should be negative, got ${sim.state.metrics.annual_tax[0]}`
  );
});

// ─── Simulation class: handlers ───────────────────────────────────────────────

test('Multiple handlers registered for same event type all execute', () => {
  const sim = new Simulation(new Date(2025, 0, 1));
  sim.scheduleAnnually({ startDate: new Date(2025, 0, 1), type: 'EVENT' });

  let callCount = 0;
  sim.register('EVENT', () => { callCount++; return []; });
  sim.register('EVENT', () => { callCount++; return []; });

  sim.stepTo(new Date(2025, 0, 1));
  assert.strictEqual(callCount, 2);
});

test('Handler context contains sim, date, data, meta and current state', () => {
  const initialState = { value: 42 };
  const sim = new Simulation(new Date(2025, 0, 1), { initialState });
  sim.scheduleAnnually({
    startDate: new Date(2025, 0, 1),
    type: 'EVENT',
    data: { foo: 'bar' },
    meta: { priority: 1 }
  });

  let capturedCtx;
  sim.register('EVENT', (ctx) => {
    capturedCtx = ctx;
    return [];
  });

  sim.stepTo(new Date(2025, 0, 1));

  assert.ok(capturedCtx.sim === sim, 'ctx.sim should be the simulation instance');
  Assert.datesEqual(capturedCtx.date, new Date(2025, 0, 1));
  assert.deepStrictEqual(capturedCtx.data, { foo: 'bar' });
  assert.deepStrictEqual(capturedCtx.meta, { priority: 1 });
  assert.strictEqual(capturedCtx.state.value, 42);
});

// ─── Simulation class: reducers ───────────────────────────────────────────────

test('Reducer returning plain state object (no next) updates state', () => {
  const sim = new Simulation(new Date(2025, 0, 1), { initialState: { counter: 0 } });

  sim.reducers.register('INCREMENT', (state, action) => ({
    ...state,
    counter: state.counter + action.by
  }));
  sim.register('TICK', () => [{ type: 'INCREMENT', by: 5 }]);
  sim.scheduleAnnually({ startDate: new Date(2025, 0, 1), type: 'TICK' });

  sim.stepTo(new Date(2025, 0, 1));
  assert.strictEqual(sim.state.counter, 5);
});

test('Reducer next chain: child action is processed and further mutates state', () => {
  const sim = new Simulation(new Date(2025, 0, 1), { initialState: { counter: 0, log: [] } });

  sim.reducers.register('INCREMENT', (state) => ({
    state: { ...state, counter: state.counter + 1 },
    next:  [{ type: 'LOG_IT', message: 'incremented' }]
  }));
  sim.reducers.register('LOG_IT', (state, action) => ({
    ...state,
    log: [...state.log, action.message]
  }));
  sim.register('TICK', () => [{ type: 'INCREMENT' }]);
  sim.scheduleAnnually({ startDate: new Date(2025, 0, 1), type: 'TICK' });

  sim.stepTo(new Date(2025, 0, 1));
  assert.strictEqual(sim.state.counter, 1);
  assert.deepStrictEqual(sim.state.log, ['incremented']);
});

test('applyActions throws when action chain exceeds MAX_ACTIONS limit', () => {
  const sim = new Simulation(new Date(2025, 0, 1));

  // Reducer that always emits itself — infinite chain
  sim.reducers.register('LOOP', (state) => ({
    state,
    next: [{ type: 'LOOP' }]
  }));
  sim.register('TICK', () => [{ type: 'LOOP' }]);
  sim.scheduleAnnually({ startDate: new Date(2025, 0, 1), type: 'TICK' });

  assert.throws(
    () => sim.stepTo(new Date(2025, 0, 1)),
    /Infinite action loop detected/
  );
});

// ─── Simulation class: snapshots & rewind ─────────────────────────────────────

test('Snapshot is captured after each handled event', () => {
  const sim = new Simulation(new Date(2025, 0, 1));
  sim.scheduleAnnually({ startDate: new Date(2025, 0, 1), type: 'TICK' });
  sim.register('TICK', () => []);

  // 3 TICK events: 2025, 2026, 2027 — each fires 2 handlers (scheduleRecurring + registered)
  sim.stepTo(new Date(2027, 0, 1));

  assert.ok(
    sim.snapshots.length >= 3,
    `Expected at least 3 snapshots, got ${sim.snapshots.length}`
  );
});

test('Snapshot captures state after the event is processed', () => {
  const sim = new Simulation(new Date(2025, 0, 1), { initialState: { counter: 0 } });
  sim.reducers.register('INCREMENT', (state) => ({ ...state, counter: state.counter + 1 }));
  sim.register('TICK', () => [{ type: 'INCREMENT' }]);
  sim.scheduleAnnually({ startDate: new Date(2025, 0, 1), type: 'TICK' });

  sim.stepTo(new Date(2025, 0, 1));

  // The last snapshot taken should reflect the incremented state
  const lastSnap = sim.snapshots[sim.snapshots.length - 1];
  assert.strictEqual(lastSnap.state.counter, 1);
  Assert.datesEqual(lastSnap.date, new Date(2025, 0, 1));
});

test('rewindToDate restores state to an earlier snapshot', () => {
  const sim = new Simulation(new Date(2025, 0, 1), { initialState: { counter: 0 } });
  sim.reducers.register('INCREMENT', (state) => ({ ...state, counter: state.counter + 1 }));
  sim.register('TICK', () => [{ type: 'INCREMENT' }]);
  sim.scheduleAnnually({ startDate: new Date(2025, 0, 1), type: 'TICK' });

  sim.stepTo(new Date(2027, 0, 1));  // 3 TICKs → counter = 3
  assert.strictEqual(sim.state.counter, 3);

  sim.rewindToDate(new Date(2025, 0, 1));  // restore to after first TICK
  assert.strictEqual(sim.state.counter, 1);
});

test('branch creates an independent deep clone of current snapshot state', () => {
  const sim = new Simulation(new Date(2025, 0, 1), { initialState: { counter: 0 } });
  sim.reducers.register('INCREMENT', (state) => ({ ...state, counter: state.counter + 1 }));
  sim.register('TICK', () => [{ type: 'INCREMENT' }]);
  sim.scheduleAnnually({ startDate: new Date(2025, 0, 1), type: 'TICK' });

  sim.stepTo(new Date(2026, 0, 1));  // 2 TICKs → counter = 2

  const branched = sim.branch();

  // Branch reflects the snapshot at cursor (counter = 2)
  assert.strictEqual(branched.state.counter, sim.snapshots[sim.snapshotCursor].state.counter);

  // Mutating the original does not affect the branch's deep-cloned state
  sim.state.counter = 99;
  assert.strictEqual(
    branched.state.counter,
    2,
    'branch state must be independent of original'
  );
});

// ─── Simulation class: deterministic RNG ─────────────────────────────────────

test('Seeded RNG produces identical outputs across two simulations', () => {
  function runWithSeed(seed) {
    const sim = new Simulation(new Date(2025, 0, 1), {
      seed,
      initialState: { values: [] }
    });
    sim.reducers.register('RECORD', (state, action) => ({
      ...state, values: [...state.values, action.value]
    }));
    sim.register('TICK', ({ sim }) => [{ type: 'RECORD', value: sim.rng() }]);
    sim.scheduleQuarterly({ startDate: new Date(2025, 0, 1), type: 'TICK' });
    sim.stepTo(new Date(2026, 0, 1));
    return sim.state.values;
  }

  const run1 = runWithSeed(42);
  const run2 = runWithSeed(42);
  assert.deepStrictEqual(run1, run2, 'same seed must produce identical value sequences');
});

test('Different seeds produce different RNG output sequences', () => {
  function runWithSeed(seed) {
    const sim = new Simulation(new Date(2025, 0, 1), {
      seed,
      initialState: { values: [] }
    });
    sim.reducers.register('RECORD', (state, action) => ({
      ...state, values: [...state.values, action.value]
    }));
    sim.register('TICK', ({ sim }) => [{ type: 'RECORD', value: sim.rng() }]);
    sim.scheduleQuarterly({ startDate: new Date(2025, 0, 1), type: 'TICK' });
    sim.stepTo(new Date(2026, 0, 1));
    return sim.state.values;
  }

  const run1 = runWithSeed(1);
  const run2 = runWithSeed(99);
  assert.notDeepStrictEqual(run1, run2, 'different seeds should produce different sequences');
});

// ─── Simulation class: journal ────────────────────────────────────────────────

test('Journal contains an entry for every reducer that runs', () => {
  const { sim } = buildFinancialSim({ seed: 1 });
  sim.scheduleQuarterly({ startDate: new Date(2025, 0, 1), type: 'SELL_ASSET' });
  sim.stepTo(new Date(2025, 0, 1));

  // One SELL_ASSET fires the chain:
  //   REALIZE_GAIN → CALCULATE_CAPITAL_GAINS_TAX → RECORD_METRIC (cgt)
  //   ADD_CASH
  //   RECORD_METRIC (assets_sold)
  assert.ok(
    sim.journal.journal.length >= 5,
    `Expected >= 5 journal entries, got ${sim.journal.journal.length}`
  );
});

test('Journal.getActions returns only entries for the requested action type', () => {
  const { sim } = buildFinancialSim({ seed: 1 });
  sim.scheduleQuarterly({ startDate: new Date(2025, 0, 1), type: 'SELL_ASSET' });
  sim.stepTo(new Date(2025, 0, 1));

  const entries = sim.journal.getActions('REALIZE_GAIN');
  assert.strictEqual(entries.length, 1);
  assert.strictEqual(entries[0].action.type, 'REALIZE_GAIN');
  assert.strictEqual(entries[0].action.amount, 8000);
});

test('Journal entry records the source event type that triggered the action', () => {
  const { sim } = buildFinancialSim({ seed: 1 });
  sim.scheduleQuarterly({ startDate: new Date(2025, 0, 1), type: 'SELL_ASSET' });
  sim.stepTo(new Date(2025, 0, 1));

  const entry = sim.journal.getActions('REALIZE_GAIN')[0];
  assert.strictEqual(entry.eventType, 'SELL_ASSET');
});

test('Journal.getStateTimeline tracks a field value across reducer executions', () => {
  const { sim } = buildFinancialSim({ seed: 1 });
  sim.scheduleQuarterly({ startDate: new Date(2025, 0, 1), type: 'SELL_ASSET' });
  sim.stepTo(new Date(2025, 0, 1));

  const timeline = sim.journal.getStateTimeline('realizedGains');
  assert.ok(timeline.length > 0, 'timeline should have entries');

  // After REALIZE_GAIN runs the field becomes 8000 and stays there for subsequent reducers
  const nonZero = timeline.filter(t => t.value > 0);
  assert.ok(nonZero.length > 0, 'realizedGains should be > 0 in some entries');
  assert.ok(
    nonZero.every(t => t.value === 8000),
    'all non-zero realizedGains entries should equal 8000'
  );
});

// ─── Simulation class: action graph ──────────────────────────────────────────

test('actionGraph contains a node for every reducer execution', () => {
  const { sim } = buildFinancialSim({ seed: 1 });
  sim.scheduleQuarterly({ startDate: new Date(2025, 0, 1), type: 'SELL_ASSET' });
  sim.stepTo(new Date(2025, 0, 1));

  assert.ok(
    sim.actionGraph.actionGraph.size > 0,
    'actionGraph should have nodes after processing actions'
  );
});

test('actionGraph: CALCULATE_CAPITAL_GAINS_TAX node is linked as child of REALIZE_GAIN', () => {
  const { sim } = buildFinancialSim({ seed: 1 });
  sim.scheduleQuarterly({ startDate: new Date(2025, 0, 1), type: 'SELL_ASSET' });
  sim.stepTo(new Date(2025, 0, 1));

  const nodes  = [...sim.actionGraph.actionGraph.values()];
  const cgtNode = nodes.find(n => n.type === 'CALCULATE_CAPITAL_GAINS_TAX');
  assert.ok(cgtNode, 'CALCULATE_CAPITAL_GAINS_TAX node should exist in graph');
  assert.ok(cgtNode.parent !== null, 'CGT node should have a parent');

  const parentNode = sim.actionGraph.getNode(cgtNode.parent);
  assert.ok(parentNode, 'parent node should be retrievable');
  assert.strictEqual(parentNode.type, 'REALIZE_GAIN');
});

test('actionGraph.getRootActions returns actions with no parent', () => {
  const { sim } = buildFinancialSim({ seed: 1 });
  sim.scheduleQuarterly({ startDate: new Date(2025, 0, 1), type: 'SELL_ASSET' });
  sim.stepTo(new Date(2025, 0, 1));

  const roots     = sim.actionGraph.getRootActions();
  const rootTypes = roots.map(n => n.type);

  // Handler returns [REALIZE_GAIN, ADD_CASH, RECORD_METRIC]; actions are chained so only
  // the first action (REALIZE_GAIN) is a root — subsequent ones are children of their predecessor.
  assert.ok(rootTypes.includes('REALIZE_GAIN'),  'REALIZE_GAIN should be a root action');
  assert.ok(!rootTypes.includes('ADD_CASH'),      'ADD_CASH should not be a root — it is chained under REALIZE_GAIN');
  assert.ok(roots.every(n => n.parent === null),  'all roots should have parent === null');
});

test('actionGraph.traceActionChain returns full descendant chain from REALIZE_GAIN', () => {
  const { sim } = buildFinancialSim({ seed: 1 });
  sim.scheduleQuarterly({ startDate: new Date(2025, 0, 1), type: 'SELL_ASSET' });
  sim.stepTo(new Date(2025, 0, 1));

  const realizeGainRoot = sim.actionGraph
    .getRootActions()
    .find(n => n.type === 'REALIZE_GAIN');

  assert.ok(realizeGainRoot, 'REALIZE_GAIN root should exist');

  const chain = sim.actionGraph.traceActionChain(realizeGainRoot.id);
  const types = chain.map(n => n.type);

  assert.ok(types.includes('REALIZE_GAIN'),              'chain should include REALIZE_GAIN');
  assert.ok(types.includes('CALCULATE_CAPITAL_GAINS_TAX'), 'chain should include CGT');
  assert.ok(types.includes('RECORD_METRIC'),             'chain should include RECORD_METRIC');
});

// ─── Simulation class: EventBus history ──────────────────────────────────────

test('EventBus history contains every event published during stepTo', () => {
  const sim = new Simulation(new Date(2025, 0, 1));
  sim.scheduleAnnually({ startDate: new Date(2025, 0, 1), type: 'ANNUAL_EVENT' });
  sim.register('ANNUAL_EVENT', () => []);

  sim.stepTo(new Date(2026, 0, 1));

  const annualEvents = sim.bus.getHistory().filter(e => e.type === 'ANNUAL_EVENT');
  assert.strictEqual(annualEvents.length, 2, 'should have one bus entry per event occurrence');
});

test('EventBus history includes DEBUG_ACTION entries when reducers run', () => {
  const { sim } = buildFinancialSim({ seed: 1 });
  sim.scheduleQuarterly({ startDate: new Date(2025, 0, 1), type: 'SELL_ASSET' });
  sim.stepTo(new Date(2025, 0, 1));

  const debugEvents = sim.bus.getHistory().filter(e => e.type === 'DEBUG_ACTION');
  assert.ok(
    debugEvents.length > 0,
    'DEBUG_ACTION entries should be present when reducers execute'
  );
  // Each DEBUG_ACTION now carries a date (regression check for earlier bug)
  assert.ok(
    debugEvents.every(e => e.date instanceof Date),
    'every DEBUG_ACTION event should have a Date'
  );
});

// ─── Handler chaining ─────────────────────────────────────────────────────────
//
// Handler chaining lets one handler delegate to another by scheduling a new
// event for the *same* date via ctx.sim.schedule().  The stepTo loop picks up
// the new event in the next iteration (still within the same stepTo call), so
// both handlers run before stepTo returns.

test('Handler chaining: handler schedules a same-date event that runs a second handler', () => {
  const sim = new Simulation(new Date(2025, 0, 1), { initialState: { log: [] } });

  sim.reducers.register('RECORD', (state, action) => ({
    ...state,
    log: [...state.log, action.message]
  }));

  // Handler A — does its own work AND delegates to Handler B
  sim.register('EVENT_A', ({ sim }) => {
    sim.schedule({ date: sim.currentDate, type: 'EVENT_B', data: { message: 'from B' } });
    return [{ type: 'RECORD', message: 'from A' }];
  });

  // Handler B — triggered by the event scheduled above
  sim.register('EVENT_B', ({ data }) => {
    return [{ type: 'RECORD', message: data.message }];
  });

  sim.schedule({ date: new Date(2025, 0, 1), type: 'EVENT_A' });
  sim.stepTo(new Date(2025, 0, 1));

  assert.ok(sim.state.log.includes('from A'), 'Handler A result should be in log');
  assert.ok(sim.state.log.includes('from B'), 'Handler B result should be in log');
  assert.strictEqual(sim.state.log.length, 2);
});

test('Handler chaining: handler delegates entirely without doing its own work', () => {
  const sim = new Simulation(new Date(2025, 0, 1), { initialState: { processed: false } });

  sim.reducers.register('MARK_DONE', (state) => ({ ...state, processed: true }));

  // Handler A does nothing itself — pure delegation to Handler B
  sim.register('DELEGATOR', ({ sim }) => {
    sim.schedule({ date: sim.currentDate, type: 'WORKER' });
    return [];
  });

  sim.register('WORKER', () => [{ type: 'MARK_DONE' }]);

  sim.schedule({ date: new Date(2025, 0, 1), type: 'DELEGATOR' });
  sim.stepTo(new Date(2025, 0, 1));

  assert.strictEqual(sim.state.processed, true, 'WORKER handler should have set processed=true');
});

test('Handler chaining: chain order is preserved across same-date events', () => {
  // A schedules B, B schedules C; log should read [A, B, C]
  const sim = new Simulation(new Date(2025, 0, 1), { initialState: { log: [] } });

  sim.reducers.register('RECORD', (state, action) => ({
    ...state,
    log: [...state.log, action.step]
  }));

  sim.register('A', ({ sim }) => {
    sim.schedule({ date: sim.currentDate, type: 'B' });
    return [{ type: 'RECORD', step: 'A' }];
  });
  sim.register('B', ({ sim }) => {
    sim.schedule({ date: sim.currentDate, type: 'C' });
    return [{ type: 'RECORD', step: 'B' }];
  });
  sim.register('C', () => [{ type: 'RECORD', step: 'C' }]);

  sim.schedule({ date: new Date(2025, 0, 1), type: 'A' });
  sim.stepTo(new Date(2025, 0, 1));

  assert.deepStrictEqual(sim.state.log, ['A', 'B', 'C']);
});

// ─── Events with future start dates ──────────────────────────────────────────

test('One-off event scheduled for a future date does not fire before that date', () => {
  const sim = new Simulation(new Date(2025, 0, 1), { initialState: { fired: false } });

  sim.reducers.register('MARK', (state) => ({ ...state, fired: true }));
  sim.register('FUTURE_EVENT', () => [{ type: 'MARK' }]);

  sim.schedule({ date: new Date(2026, 5, 15), type: 'FUTURE_EVENT' });

  // Mid-sim advance — event should not have fired
  sim.stepTo(new Date(2026, 0, 1));
  assert.strictEqual(sim.state.fired, false, 'event should not fire before its scheduled date');
});

test('One-off event scheduled for a future date fires exactly on that date', () => {
  const sim = new Simulation(new Date(2025, 0, 1), { initialState: { fired: false } });

  sim.reducers.register('MARK', (state) => ({ ...state, fired: true }));
  sim.register('FUTURE_EVENT', () => [{ type: 'MARK' }]);

  sim.schedule({ date: new Date(2026, 5, 15), type: 'FUTURE_EVENT' });

  sim.stepTo(new Date(2026, 5, 15));
  assert.strictEqual(sim.state.fired, true, 'event should fire when stepTo reaches its date');
});

test('Recurring event with future startDate does not fire before startDate', () => {
  const sim = new Simulation(new Date(2025, 0, 1), { initialState: { count: 0 } });

  sim.reducers.register('INCREMENT', (state) => ({ ...state, count: state.count + 1 }));
  sim.register('LATE_START', () => [{ type: 'INCREMENT' }]);

  // Start one year after simulation creation
  sim.scheduleAnnually({ startDate: new Date(2026, 0, 1), type: 'LATE_START' });

  sim.stepTo(new Date(2025, 11, 31));
  assert.strictEqual(sim.state.count, 0, 'recurring event should not fire before its startDate');
});

test('Recurring event with future startDate fires on its startDate', () => {
  const sim = new Simulation(new Date(2025, 0, 1), { initialState: { count: 0 } });

  sim.reducers.register('INCREMENT', (state) => ({ ...state, count: state.count + 1 }));
  sim.register('LATE_START', () => [{ type: 'INCREMENT' }]);

  sim.scheduleAnnually({ startDate: new Date(2026, 0, 1), type: 'LATE_START' });

  sim.stepTo(new Date(2026, 0, 1));
  assert.strictEqual(sim.state.count, 1, 'recurring event should fire once on startDate');
});

test('Recurring event with future startDate continues recurring correctly after first fire', () => {
  const sim = new Simulation(new Date(2025, 0, 1), { initialState: { count: 0 } });

  sim.reducers.register('INCREMENT', (state) => ({ ...state, count: state.count + 1 }));
  sim.register('LATE_START', () => [{ type: 'INCREMENT' }]);

  sim.scheduleAnnually({ startDate: new Date(2026, 0, 1), type: 'LATE_START' });

  // 2026, 2027, 2028 = 3 fires
  sim.stepTo(new Date(2028, 0, 1));
  assert.strictEqual(sim.state.count, 3);
});

test('Quarterly event with mid-year startDate fires at correct quarterly intervals', () => {
  const sim = new Simulation(new Date(2025, 0, 1), { initialState: { count: 0 } });

  sim.reducers.register('INCREMENT', (state) => ({ ...state, count: state.count + 1 }));
  sim.register('QUARTERLY', () => [{ type: 'INCREMENT' }]);

  // Start on Jul 1 2025 — fires Jul, Oct, Jan(2026), Apr(2026)
  sim.scheduleQuarterly({ startDate: new Date(2025, 6, 1), type: 'QUARTERLY' });

  sim.stepTo(new Date(2025, 5, 30));
  assert.strictEqual(sim.state.count, 0, 'no fires before Jul 1 2025');

  sim.stepTo(new Date(2026, 3, 1));
  assert.strictEqual(sim.state.count, 4, 'should have fired 4 times by Apr 1 2026');
});
