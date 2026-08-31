/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * POOL-HISTORY (design 97 §20.11) — the journal replay behind the Liquidity Pools panel.
 *
 * The panel's every series is a RECONSTRUCTION, so what has to be pinned is not "does it
 * draw" but "does the reconstruction equal the run":
 *
 * HIST-1 seed         : the cube's first write is one whole-object diff, and it seeds every pool
 * HIST-2 carry-forward: a field with no diff this period keeps its value — that IS the reading
 * HIST-3 non-events   : gatedFlows become log rows, once each, not once per endpoint
 * HIST-4 veto         : poolRefillPlan.vetoed is a log row of its own
 * HIST-5 fired        : POOL_FLOW_APPLY is read from action.data, and from a raw action
 * HIST-6 order        : the graph's pool order wins over first-seen
 * HIST-7 tie          : a drifted replay is REPORTED, and an absent live cube is 'unchecked'
 * HIST-8 end-to-end   : replaying a real run's journal reproduces its live cube exactly
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import { buildPoolHistory, poolHistoryRows, poolSeries, tiePoolHistory, POOL_EVENT_KIND }
  from '../../src/finance/pools/pool-history.js';
import { PoolFlowReducer } from '../../src/finance/pools/pool-flow-reducer.js';
import { normalizeLiquidityGraph } from '../../src/finance/pools/liquidity-graph.js';
import { diffStates } from '../../src/simulation-framework/state-utils.js';
import { ACCOUNT_TYPE, USD } from '../../src/finance/assets/account.js';

let _seq = 0;
const entry = (dateISO, stateDiff, action = { type: 'US_PERIOD_ADVANCE' }) =>
  ({ seq: _seq++, date: new Date(dateISO), action, stateDiff });

const CUBE = (over = {}) => ({
  balance: 100, capacity: 100, utilised: 100, target: 120, yearsOfCover: 2, high: 100,
  marketReturn: 0.05, marketReturnYear: 2030, priorYearReturn: null,
  inflow: 0, outflow: 0, gatedFlows: [], lastFired: {}, ...over,
});

test('HIST-1: the cube\'s first write is one whole-object diff, and it seeds every pool', () => {
  const h = buildPoolHistory({ journal: [entry('2030-01-01', [
    { field: 'liquidityPools', before: null, after: { cash: CUBE(), growth: CUBE({ balance: 900 }) } },
  ])] });

  assert.equal(h.hasCube, true);
  assert.equal(h.periods.length, 1);
  assert.deepEqual(h.poolIds.sort(), ['cash', 'growth']);
  assert.equal(h.periods[0].pools.growth.balance, 900);
  // Derived, never stored (§12.1): headroom is what §20.4b's conflation made identically zero.
  assert.equal(h.periods[0].pools.cash.headroom, 0);
  assert.equal(h.periods[0].pools.cash.shortfall, 20);
});

test('HIST-2: a field with no diff this period keeps its value, and the record is per PERIOD', () => {
  const h = buildPoolHistory({ journal: [
    entry('2030-01-01', [{ field: 'liquidityPools', before: null, after: { cash: CUBE() } }]),
    // Only the balance moved. `capacity` and `target` are re-derived to the same numbers by
    // the reducer, so carrying them forward is the honest reading, not an approximation.
    entry('2030-07-01', [{ field: 'liquidityPools.cash.balance', before: 100, after: 60, delta: -40 }]),
    entry('2031-01-01', [{ field: 'liquidityPools.cash.balance', before: 60, after: 45, delta: -15 }]),
  ] });

  assert.equal(h.periods.length, 3);
  assert.deepEqual(poolSeries(h, 'balance').series.cash, [100, 60, 45]);
  assert.deepEqual(poolSeries(h, 'target').series.cash, [120, 120, 120]);
  // Two advances in one calendar year, so the axis is a DATE: a year axis would draw the
  // July AU advance on top of the January US one.
  assert.deepEqual(poolSeries(h, 'balance').labels, ['2030-01-01', '2030-07-01', '2031-01-01']);
  assert.deepEqual(poolSeries(h, 'balance').years, [2030, 2030, 2031]);
});

test('HIST-3: a gated flow is one log row per period, not one per endpoint', () => {
  // The reducer records the same gated flow on BOTH pools it touches, which is right for the
  // cube and would double every row of the log.
  const g = { id: 'g2c', from: 'growth', to: 'cash', reason: 'source growth is returning -20.0%', wanted: 500 };
  const h = buildPoolHistory({ journal: [entry('2033-01-01', [
    { field: 'liquidityPools', before: null,
      after: { cash: CUBE({ gatedFlows: [g] }), growth: CUBE({ gatedFlows: [g] }) } },
  ])] });

  const gated = h.events.filter(e => e.kind === POOL_EVENT_KIND.GATED);
  assert.equal(gated.length, 1);
  assert.equal(gated[0].reason, g.reason);
  assert.equal(gated[0].wanted, 500);
  assert.equal(gated[0].amount, null);   // a gated flow moved nothing, and must never read as if it had
});

test('HIST-4: a rebalance veto is a log row of its own', () => {
  const h = buildPoolHistory({ journal: [entry('2033-01-01', [
    { field: 'liquidityPools', before: null, after: { growth: CUBE() } },
    { field: 'poolRefillPlan', before: null, after: { shortfall: {}, vetoed: ['growth'], gated: [] } },
  ])] });

  const veto = h.events.filter(e => e.kind === POOL_EVENT_KIND.VETOED);
  assert.equal(veto.length, 1);
  assert.equal(veto[0].from, 'growth');
  assert.equal(h.periods[0].vetoed[0], 'growth');
  assert.equal(poolHistoryRows(h)[0].vetoed, 1);
});

test('HIST-5: a fired transfer is read from action.data, and from a raw action', () => {
  const h = buildPoolHistory({ journal: [
    entry('2030-01-01', [{ field: 'liquidityPools', before: null, after: { cash: CUBE() } }]),
    entry('2030-01-01', [], { type: 'POOL_FLOW_APPLY',
      data: { flowId: 'g2c', from: 'growth', to: 'cash', amountBase: 1234.5 } }),
    // A journal built without a TypeRegistry carries the raw action instead.
    entry('2031-01-01', [], { type: 'POOL_FLOW_APPLY', flowId: 'g2c', from: 'growth', to: 'cash', amountBase: 99 }),
  ] });

  const fired = h.events.filter(e => e.kind === POOL_EVENT_KIND.FIRED);
  assert.deepEqual(fired.map(e => e.amount), [1234.5, 99]);
  assert.equal(fired[0].flowId, 'g2c');
});

test('HIST-5b: firedFlows on the cube is authoritative and covers BOTH executors', () => {
  // The action stream records only cross-account edges, so an in-portfolio edge that fired
  // every year its gate was open reads as one that never fired. Measured on a real plan
  // before this existed: 81 gated, 4 firings, reported as 81 and 0.
  const f = [{ id: 'g2b', from: 'growth', to: 'buffer', amount: 317_203, executor: 'REBALANCE' },
             { id: 'b2c', from: 'buffer', to: 'cash',   amount: 12_000,  executor: 'TRANSFER' }];
  const h = buildPoolHistory({ journal: [
    entry('2039-01-01', [{ field: 'liquidityPools', before: null, after: {
      growth: CUBE({ firedFlows: [f[0]] }),
      buffer: CUBE({ firedFlows: f }),
      cash:   CUBE({ firedFlows: [f[1]] }),
    } }]),
    // The same transfer also lands as an action. It must NOT be counted twice.
    entry('2039-01-01', [], { type: 'POOL_FLOW_APPLY',
      data: { flowId: 'b2c', from: 'buffer', to: 'cash', amountBase: 12_000 } }),
  ] });

  const fired = h.events.filter(e => e.kind === POOL_EVENT_KIND.FIRED);
  assert.equal(h.firedFromCube, true);
  assert.equal(fired.length, 2);
  assert.deepEqual(fired.map(e => e.flowId).sort(), ['b2c', 'g2b']);
  assert.equal(fired.find(e => e.flowId === 'g2b').executor, 'REBALANCE');
  assert.equal(fired.find(e => e.flowId === 'g2b').amount, 317_203);
});

test('HIST-5c: a run predating firedFlows falls back to the action stream, and says so', () => {
  const h = buildPoolHistory({ journal: [
    entry('2030-01-01', [{ field: 'liquidityPools', before: null, after: { cash: CUBE() } }]),
    entry('2030-01-01', [], { type: 'POOL_FLOW_APPLY',
      data: { flowId: 'g2c', from: 'growth', to: 'cash', amountBase: 500 } }),
  ] });
  assert.equal(h.firedFromCube, false);
  assert.equal(h.events.filter(e => e.kind === POOL_EVENT_KIND.FIRED).length, 1);
});

test('HIST-6: the graph\'s pool order wins over first-seen, and labels come with it', () => {
  const journal = [entry('2030-01-01', [
    { field: 'liquidityPools', before: null, after: { growth: CUBE(), cash: CUBE() } },
  ])];
  const graph = { pools: [{ id: 'cash', label: 'Bucket 1' }, { id: 'growth', label: 'Bucket 3' }], flows: [] };

  assert.deepEqual(buildPoolHistory({ journal, graph }).poolIds, ['cash', 'growth']);
  assert.equal(buildPoolHistory({ journal, graph }).labels.growth, 'Bucket 3');
  // No graph ⇒ first-seen, and the id is its own label. A history read off the journal alone
  // cannot know the author's spend order.
  assert.deepEqual(buildPoolHistory({ journal }).poolIds, ['growth', 'cash']);
  assert.equal(buildPoolHistory({ journal }).labels.cash, 'cash');
});

test('HIST-7: a drifted replay is reported, and an absent live cube is unchecked, not failed', () => {
  const h = buildPoolHistory({ journal: [entry('2030-01-01', [
    { field: 'liquidityPools', before: null, after: { cash: CUBE() } },
  ])] });

  assert.equal(tiePoolHistory(h, { liquidityPools: { cash: CUBE() } }).ok, true);

  const bad = tiePoolHistory(h, { liquidityPools: { cash: CUBE({ balance: 101 }) } });
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.mismatches[0], { pool: 'cash', field: 'balance', live: 101, replayed: 100 });

  // `unchecked` is NOT a failure and must not be painted as one: a stub, or a run with no
  // graph, has nothing to tie against.
  assert.equal(tiePoolHistory(h, {}).unchecked, true);
  assert.equal(tiePoolHistory(h, {}).ok, true);
});

test('HIST-8: replaying a real reducer\'s diffs reproduces its state exactly', () => {
  // The check the panel makes for real, run against the reducer rather than a fixture: the
  // history is only quotable if applying the journal's diffs lands on the state the run holds.
  const graph = normalizeLiquidityGraph({
    pools: [
      { id: 'cash',   claims: [{ key: 'usSavingsAccount' }], spendOrder: 10,
        target: { mode: 'AMOUNT', value: 200_000 } },
      { id: 'spare',  claims: [{ key: 'auSavingsAccount' }], spendOrder: 20 },
    ],
    flows: [{ id: 's2c', from: 'spare', to: 'cash', amount: { toTarget: true }, priority: 10 }],
  }, [
    { stateKey: 'usSavingsAccount', type: ACCOUNT_TYPE.SAVINGS },
    { stateKey: 'auSavingsAccount', type: ACCOUNT_TYPE.SAVINGS },
  ]);

  const reducer = new PoolFlowReducer({ graph, expensesCurrency: 'USD' });
  let state = {
    usSavingsAccount: { balance: 150_000, currency: USD, holdings: [] },
    auSavingsAccount: { balance: 80_000, currency: USD, holdings: [] },
    monthlyExpenses: 5_000,
    currentPeriods: { US: { startMs: Date.UTC(2030, 0, 1) } },
  };

  const journal = [];
  for (const year of [2030, 2031]) {
    const before = { ...state, currentPeriods: { US: { startMs: Date.UTC(year, 0, 1) } } };
    // `newState` returns the next state with the emitted actions on `next`; strip it so the
    // diff is over state alone, exactly as the simulation records it.
    const { next, ...after } = reducer.reduce(
      before, { type: 'US_PERIOD_ADVANCE', date: new Date(Date.UTC(year, 0, 1)) },
      new Date(Date.UTC(year, 0, 1)));
    journal.push(entry(`${year}-01-01`, diffStates(before, after)));
    state = after;
  }

  const h = buildPoolHistory({ journal, graph });
  assert.equal(h.periods.length, 2);
  const tie = tiePoolHistory(h, state);
  assert.equal(tie.ok, true, JSON.stringify(tie.mismatches));
  assert.ok(tie.checked > 0);
});
