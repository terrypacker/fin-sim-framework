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
 * EVT-LIQUIDITY-POOLS (design 97 Part II) — the pool GRAPH.
 *
 * §3 built the spend order as a LIST. This is the generalisation: pools are nodes with
 * claims, flows are edges with (s, S) triggers and market-state gates.
 *
 * POOL-1  identity      : no graph ⇒ the state key is absent and the run is unchanged
 * POOL-2  compilation   : a single-claim graph compiles to exactly the hand-authored sequence
 * POOL-3  multi-account : one pool claiming two accounts becomes two ADJACENT entries
 * POOL-4  capacity      : OFFSET_CAP = min(balance, linked loan) and a refill stops at it
 * POOL-5  trigger band  : `below` fires at s and fills to S — and NOT in between
 * POOL-6  gate          : a closed gate suppresses the refill AND vetoes the same sale
 * POOL-7  reverse edge  : targetDrawdownOver fires only when the destination is down
 * POOL-8  transfer      : a cross-account flow raises the withdrawal-tax action, on the
 *                         action stream (count emitters, not fires)
 * POOL-9  one authority : a pool target overrides the schedule for its class only
 * POOL-10 validation    : every config error in §12.7 throws
 * POOL-11 determinism   : a legal cycle replays byte-identically
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import {
  normalizeLiquidityGraph, compileToDrawdownSequence, resolveLiquidityGraph,
  FLOW_EXECUTOR, POOL_CAPACITY_MODE,
} from '../../src/finance/pools/liquidity-graph.js';
import { poolMetrics, poolContext, loanForOffset } from '../../src/finance/pools/pool-metrics.js';
import { PoolFlowReducer }      from '../../src/finance/pools/pool-flow-reducer.js';
import { PoolFlowApplyReducer } from '../../src/finance/pools/pool-flow-apply-reducer.js';
import { AccountService }       from '../../src/finance/services/account-service.js';
import { CheckingAccount, OffsetAccount, LoanAccount, USD, AUD, ACCOUNT_TYPE } from '../../src/finance/assets/account.js';
import { BrokerageAccount }     from '../../src/finance/assets/investment-account.js';
import { Holding }              from '../../src/finance/holdings/holding.js';
import { ALLOCATION }           from '../../src/finance/holdings/allocation.js';
import { EventBus }             from '../../src/simulation-framework/event-bus.js';
import { Graph }                from '../../src/graph/graph.js';
import { GraphQueryApi }        from '../../src/graph/graph-query-api.js';
import { loadScenarioSim }      from '../helpers/scenario-harness.js';

const D = (y) => new Date(Date.UTC(y, 0, 1));
const ACCOUNTS = [
  { stateKey: 'usSavingsAccount', type: ACCOUNT_TYPE.SAVINGS },
  { stateKey: 'auSavingsAccount', type: ACCOUNT_TYPE.SAVINGS },
  { stateKey: 'usStockAccount',   type: ACCOUNT_TYPE.BROKERAGE },
  { stateKey: 'offsetAccount',    type: ACCOUNT_TYPE.OFFSET, offsetsPropertyKey: 'house' },
];

/** The reference four-bucket graph: cash → reserve → offset → growth. */
const REFERENCE = {
  pools: [
    { id: 'cash',    spendOrder: 10, claims: [{ key: 'usSavingsAccount' }] },
    { id: 'reserve', spendOrder: 20, claims: [{ key: 'usStockAccount', sleeves: ['BOND'] }] },
    { id: 'offset',  spendOrder: 30, claims: [{ key: 'offsetAccount' }], capacity: { mode: 'OFFSET_CAP' } },
    { id: 'growth',  spendOrder: 40, claims: [{ key: 'usStockAccount', sleeves: ['EQUITY', 'GOLD'] }] },
  ],
};

// ─── POOL-2 / POOL-3: the graph COMPILES ───────────────────────────────────────────

test('POOL-2: a single-claim graph compiles to exactly the hand-authored sequence', () => {
  const g = normalizeLiquidityGraph(REFERENCE, ACCOUNTS);
  assert.deepEqual(compileToDrawdownSequence(g), [
    { key: 'usSavingsAccount', sleeves: null },
    { key: 'usStockAccount',   sleeves: ['BOND'] },
    { key: 'offsetAccount',    sleeves: null },
    { key: 'usStockAccount',   sleeves: ['EQUITY', 'GOLD'] },
  ]);
});

test('POOL-2b: spendOrder, not declaration order, decides the walk', () => {
  const g = normalizeLiquidityGraph({
    pools: [
      { id: 'growth', spendOrder: 40, claims: [{ key: 'usStockAccount', sleeves: ['EQUITY'] }] },
      { id: 'cash',   spendOrder: 10, claims: [{ key: 'usSavingsAccount' }] },
    ],
  }, ACCOUNTS);
  assert.deepEqual(compileToDrawdownSequence(g).map(e => e.key), ['usSavingsAccount', 'usStockAccount']);
});

test('POOL-3: one pool claiming two accounts compiles to two ADJACENT entries', () => {
  const g = normalizeLiquidityGraph({
    pools: [
      { id: 'cash',   spendOrder: 10, claims: [{ key: 'usSavingsAccount' }, { key: 'auSavingsAccount' }] },
      { id: 'growth', spendOrder: 20, claims: [{ key: 'usStockAccount', sleeves: ['EQUITY'] }] },
    ],
  }, ACCOUNTS);
  assert.deepEqual(compileToDrawdownSequence(g).map(e => e.key),
    ['usSavingsAccount', 'auSavingsAccount', 'usStockAccount']);
});

test('POOL-3b: a pool with no spendOrder is not a spend source', () => {
  const g = normalizeLiquidityGraph({
    pools: [{ id: 'vault', claims: [{ key: 'usSavingsAccount' }] }],
  }, ACCOUNTS);
  assert.equal(compileToDrawdownSequence(g), null);
});

// ─── POOL-4: capacity (FINDINGS §6.3) ──────────────────────────────────────────────

function offsetState({ offset = 300_000, loan = 200_000 } = {}) {
  return {
    offsetAccount: Object.assign(new OffsetAccount(offset, { offsetsPropertyKey: 'house', country: 'AU', currency: AUD }), {}),
    houseLoan:     Object.assign(new LoanAccount(loan, { linkedPropertyKey: 'house', country: 'AU', currency: AUD }), {}),
    monthlyExpenses: 10_000,
    effectiveExchangeRates: { USD_AUD: 1 },
  };
}

test('POOL-4: OFFSET_CAP — the ceiling is what is OWED; cash above the debt is not utilised', () => {
  const g    = normalizeLiquidityGraph(REFERENCE, ACCOUNTS);
  const pool = g.pools.find(p => p.id === 'offset');
  const state = offsetState({ offset: 300_000, loan: 200_000 });
  const m = poolMetrics(state, pool, poolContext(state));
  assert.equal(m.balance, 300_000);
  assert.equal(m.capacity, 200_000);       // the debt is the ceiling
  assert.equal(m.utilised, 200_000);       // 100k of the balance suppresses no interest
  assert.equal(m.headroom, 0);             // and so a refill has nowhere to put more
});

test('POOL-4b: the cap follows the loan down — a pool that shrinks with nobody spending from it', () => {
  const g    = normalizeLiquidityGraph(REFERENCE, ACCOUNTS);
  const pool = g.pools.find(p => p.id === 'offset');
  const before = offsetState({ offset: 100_000, loan: 200_000 });
  const after  = offsetState({ offset: 100_000, loan:  40_000 });   // amortised
  assert.equal(poolMetrics(before, pool, poolContext(before)).capacity, 200_000);
  assert.equal(poolMetrics(after,  pool, poolContext(after)).capacity,   40_000);
  // Utilisation is capped by whichever side is smaller, which is the figure §12.1 wanted.
  assert.equal(poolMetrics(before, pool, poolContext(before)).utilised, 100_000);
  assert.equal(poolMetrics(after,  pool, poolContext(after)).utilised,   40_000);
});

test('POOL-4d: a DRAINED offset can be refilled — the ceiling is not the balance', () => {
  // Design 97 §20. `min(balance, loan)` is never above the balance, so it made `headroom`
  // identically zero and NO flow could refill an offset pool — least of all a drained one,
  // which is the only time a refill is wanted. The failure was silent: a pool sitting at its
  // stated capacity looks correct, and the arm simply measured a policy that never ran.
  const g    = normalizeLiquidityGraph(REFERENCE, ACCOUNTS);
  const pool = g.pools.find(p => p.id === 'offset');
  const state = offsetState({ offset: 0, loan: 400_000 });
  const m = poolMetrics(state, pool, poolContext(state));
  assert.equal(m.capacity, 400_000);
  assert.equal(m.utilised, 0);
  assert.equal(m.headroom, 400_000);
});

test('POOL-4c: the offset→loan join resolves through the property key, same currency only', () => {
  const state = offsetState();
  assert.equal(loanForOffset(state, state.offsetAccount)?.balance, 200_000);
  state.houseLoan.currency = USD;                       // a misconfigured cross-currency link
  assert.equal(loanForOffset(state, state.offsetAccount), null);
});

test('POOL-4d: yearsOfCover reads the LIVE spend line, so it falls as spending inflates', () => {
  const g    = normalizeLiquidityGraph(REFERENCE, ACCOUNTS);
  const pool = g.pools.find(p => p.id === 'offset');
  const s1 = offsetState({ offset: 240_000 });                       // 10k/mo ⇒ 120k/yr
  const s2 = { ...offsetState({ offset: 240_000 }), monthlyExpenses: 20_000 };
  assert.equal(poolMetrics(s1, pool, poolContext(s1)).yearsOfCover, 2);
  assert.equal(poolMetrics(s2, pool, poolContext(s2)).yearsOfCover, 1);
});

// ─── POOL-5 / 6 / 7: triggers, gates, the reverse edge ─────────────────────────────

/**
 * A two-pool portfolio: a cash pool (savings) and a growth pool (brokerage EQUITY), with
 * one refill edge between them. Cross-account, so it runs through executor 2 and the flow
 * reducer emits POOL_FLOW_APPLY — which is what makes the decision observable.
 */
function flowFixture({ cash = 50_000, equity = 1_000_000, flow = {}, high = null, flowsEnabled = true } = {}) {
  const graph = normalizeLiquidityGraph({
    pools: [
      { id: 'cash',   spendOrder: 10, claims: [{ key: 'usSavingsAccount' }],
        target: { mode: 'YEARS_OF_SPEND', value: 2 } },
      { id: 'growth', spendOrder: 20, claims: [{ key: 'usStockAccount', sleeves: ['EQUITY'] }] },
    ],
    flows: [{ id: 'g2c', from: 'growth', to: 'cash', ...flow }],
  }, ACCOUNTS);

  const savings = new CheckingAccount(cash, { country: 'US', currency: USD });
  const broker  = new BrokerageAccount(equity, { country: 'US', currency: USD, drawdownPriority: 4 });
  broker.holdings = [new Holding({ id: 'eq', allocation: ALLOCATION.EQUITY, marketValue: equity, costBasis: equity / 2, purchaseDate: D(2010), rateKey: 'EQUITY_US' })];

  const state = {
    usSavingsAccount: savings, usStockAccount: broker,
    monthlyExpenses: 10_000,                 // 120k/yr ⇒ the cash target is 240k
    effectiveExchangeRates: { USD_AUD: 1 },
    people: { p1: { birthDate: new Date(Date.UTC(1975, 0, 1)) } },
    ...(high ? { liquidityPools: high } : {}),
  };
  const reducer = new PoolFlowReducer({ graph, flowsEnabled });
  return { graph, state, reducer, savings, broker };
}

const fire = (reducer, state, { date = new Date('2030-01-01') } = {}) => {
  const iso = new Date(date).toISOString();
  const out = reducer.reduce(state, { type: 'US_PERIOD_ADVANCE', date: iso }, new Date(iso));
  return { next: out.next.filter(a => a.type === 'POOL_FLOW_APPLY'), state: out };
};

test('POOL-5: the (s, S) band — no trigger trip, no flow', () => {
  // cash 200k against a 240k target, trigger at "below 1 year" (120k): inside the band.
  const { reducer, state } = flowFixture({ cash: 200_000, flow: { trigger: { below: { mode: 'YEARS_OF_SPEND', value: 1 } } } });
  assert.equal(fire(reducer, state).next.length, 0);
});

test('POOL-5b: below s it fires, and fills to S — not back to s', () => {
  const { reducer, state } = flowFixture({ cash: 100_000, flow: { trigger: { below: { mode: 'YEARS_OF_SPEND', value: 1 } } } });
  const { next } = fire(reducer, state);
  assert.equal(next.length, 1);
  // The whole point of two numbers: filled to the 240k target, not to the 120k trigger.
  assert.equal(next[0].amountBase, 140_000);
});

test('POOL-6: a closed gate suppresses the refill and records the non-event', () => {
  // growth is 20% below its trailing high; the gate allows 5%.
  const { reducer, state } = flowFixture({
    cash: 100_000, equity: 800_000,
    high: { growth: { high: 1_000_000 }, cash: { high: 100_000 } },
    flow: { gate: { sourceDrawdownUnder: 0.05 } },
  });
  const out = fire(reducer, state);
  assert.equal(out.next.length, 0);
  assert.equal(out.state.poolRefillPlan.gated.length, 1);
  assert.match(out.state.poolRefillPlan.gated[0].reason, /source growth is 20\.0% below its high/);
  // …and it VETOES the source's sale, so the drift band cannot launder the same trade.
  assert.deepEqual(out.state.poolRefillPlan.vetoed, ['growth']);
  // The non-event is on the cube, which is the only place it is recorded at all.
  assert.equal(out.state.liquidityPools.growth.gatedFlows.length, 1);
});

test('POOL-6b: the same graph with the gate open fires — a working-detector control', () => {
  const { reducer, state } = flowFixture({
    cash: 100_000, equity: 1_000_000,
    high: { growth: { high: 1_000_000 }, cash: { high: 100_000 } },
    flow: { gate: { sourceDrawdownUnder: 0.05 } },
  });
  const out = fire(reducer, state);
  assert.equal(out.next.length, 1);
  assert.deepEqual(out.state.poolRefillPlan.vetoed, []);
});

test('POOL-7: the reverse edge (buy the dip) shifts the target mix only when the destination is down', () => {
  // Buy-the-dip is an IN-PORTFOLIO edge — BOND sleeve into EQUITY sleeve of the same book.
  // It cannot be a cash-into-a-sleeve transfer: depositing cash into a brokerage does not
  // land in the EQUITY sleeve the pool claims, so the pool would never fill and the edge
  // would fire forever. Validation rejects that shape; this is the shape that works.
  const make = (equity) => {
    const graph = normalizeLiquidityGraph({
      pools: [
        { id: 'reserve', spendOrder: 10, claims: [{ key: 'usStockAccount', sleeves: ['BOND'] }] },
        { id: 'growth',  spendOrder: 20, claims: [{ key: 'usStockAccount', sleeves: ['EQUITY'] }] },
      ],
      flows: [{ id: 'dip', from: 'reserve', to: 'growth',
                gate: { targetDrawdownOver: 0.20 }, amount: { fractionOfSource: 0.25 } }],
    }, ACCOUNTS);
    const broker = new BrokerageAccount(equity + 400_000, { country: 'US', currency: USD });
    broker.holdings = [
      new Holding({ id: 'bond', allocation: ALLOCATION.BOND,   marketValue: 400_000, costBasis: 400_000, purchaseDate: D(2010), rateKey: 'FIXED_INCOME_US' }),
      new Holding({ id: 'eq',   allocation: ALLOCATION.EQUITY, marketValue: equity,  costBasis: equity,  purchaseDate: D(2010), rateKey: 'EQUITY_US' }),
    ];
    const state = {
      usStockAccount: broker, monthlyExpenses: 10_000,
      effectiveExchangeRates: { USD_AUD: 1 },
      liquidityPools: { growth: { high: 1_000_000 }, reserve: { high: 400_000 } },
    };
    return { graph, reducer: new PoolFlowReducer({ graph }), state };
  };
  const calm  = make(950_000);          // 5% off the high — the gate stays shut
  const crash = make(700_000);          // 30% off — the gate opens

  assert.deepEqual(fire(calm.reducer, calm.state).state.poolRefillPlan.adjust, {});
  const out = fire(crash.reducer, crash.state).state;
  // No POOL_FLOW_APPLY: an in-portfolio move is executed by the rebalancer, not a transfer.
  assert.equal(out.next.filter(a => a.type === 'POOL_FLOW_APPLY').length, 0);
  assert.deepEqual(out.poolRefillPlan.adjust, { growth: 100_000, reserve: -100_000 });
});

test('POOL-7b: the dip adjustment reaches the rebalancer as an EQUITY overweight', async () => {
  const { RebalanceToTargetReducer } = await import('../../src/finance/behavioral/rebalance-to-target-reducer.js');
  const graph = normalizeLiquidityGraph({
    pools: [
      { id: 'reserve', spendOrder: 10, claims: [{ key: 'usStockAccount', sleeves: ['BOND'] }] },
      { id: 'growth',  spendOrder: 20, claims: [{ key: 'usStockAccount', sleeves: ['EQUITY'] }] },
    ],
    flows: [{ id: 'dip', from: 'reserve', to: 'growth',
              gate: { targetDrawdownOver: 0.20 }, amount: { fractionOfSource: 0.25 } }],
  }, ACCOUNTS);
  const r = new RebalanceToTargetReducer({
    accounts: [{ stateKey: 'usStockAccount', role: 'us-stock' }],
    targetAllocation: { EQUITY: 0.60, BOND: 0.40 },
    poolGraph: graph,
  });
  const base = { monthlyExpenses: 10_000, effectiveExchangeRates: { USD_AUD: 1 }, liquidityPools: {} };
  const quiet = r.resolveScheduledTarget({ ...base }, { type: 'US_PERIOD_ADVANCE' }, 1_000_000, {});
  const dipped = r.resolveScheduledTarget(
    { ...base, poolRefillPlan: { adjust: { growth: 100_000, reserve: -100_000 } } },
    { type: 'US_PERIOD_ADVANCE' }, 1_000_000, {});
  assert.equal(+quiet.EQUITY.toFixed(4), 0.60);
  assert.equal(+dipped.EQUITY.toFixed(4), 0.70);     // +100k of a 1m book
  assert.equal(+dipped.BOND.toFixed(4),   0.30);
  assert.equal(+(dipped.EQUITY + dipped.BOND).toFixed(6), 1);
});

test('POOL-5c: poolFlowsEnabled=false keeps the topology and the cube, and fires nothing', () => {
  const { reducer, state } = flowFixture({ cash: 100_000, flowsEnabled: false });
  const out = fire(reducer, state);
  assert.equal(out.next.length, 0);
  // The arm-vs-control switch has to leave the MEASUREMENT intact, or the two arms differ
  // in more than one way.
  assert.equal(out.state.liquidityPools.cash.target, 240_000);
  assert.equal(out.state.liquidityPools.cash.balance, 100_000);
});

test('POOL-5e: every firing is on the cube, in-portfolio ones included', () => {
  // `gatedFlows` made the non-event visible; without its counterpart the visible half of the
  // ledger is the cross-account edges alone, because those are the only ones that emit an
  // action. On a real plan an in-portfolio edge with 4 firings and 81 gated evaluations was
  // reported as 0 and 81 — the firings were real and only the record was missing.
  const graph = normalizeLiquidityGraph({
    pools: [
      { id: 'cash',   spendOrder: 10, claims: [{ key: 'usSavingsAccount' }], target: { mode: 'AMOUNT', value: 200_000 } },
      { id: 'buffer', spendOrder: 20, claims: [{ key: 'usStockAccount', sleeves: ['BOND'] }],
        target: { mode: 'AMOUNT', value: 300_000 } },
      { id: 'growth', spendOrder: 30, claims: [{ key: 'usStockAccount', sleeves: ['EQUITY'] }] },
    ],
    flows: [
      { id: 'b2c', from: 'buffer', to: 'cash',   priority: 10 },   // cross-account ⇒ TRANSFER
      { id: 'g2b', from: 'growth', to: 'buffer', priority: 10 },   // one book       ⇒ REBALANCE
    ],
  }, ACCOUNTS);
  const savings = new CheckingAccount(0, { country: 'US', currency: USD });
  const broker  = new BrokerageAccount(1_100_000, { country: 'US', currency: USD });
  broker.holdings = [
    new Holding({ id: 'bd', allocation: ALLOCATION.BOND,   marketValue: 100_000,   costBasis: 100_000,   purchaseDate: D(2010), rateKey: 'FIXED_INCOME_US' }),
    new Holding({ id: 'eq', allocation: ALLOCATION.EQUITY, marketValue: 1_000_000, costBasis: 1_000_000, purchaseDate: D(2010), rateKey: 'EQUITY_US' }),
  ];
  const state = {
    usSavingsAccount: savings, usStockAccount: broker,
    monthlyExpenses: 10_000, effectiveExchangeRates: { USD_AUD: 1 },
  };
  const out = new PoolFlowReducer({ graph }).reduce(
    state, { type: 'US_PERIOD_ADVANCE', date: '2030-01-01' }, new Date('2030-01-01'));

  const byId = Object.fromEntries(
    out.liquidityPools.buffer.firedFlows.map(f => [f.id, f]));
  assert.deepEqual(Object.keys(byId).sort(), ['b2c', 'g2b']);
  assert.equal(byId.b2c.executor, FLOW_EXECUTOR.TRANSFER);
  assert.equal(byId.g2b.executor, FLOW_EXECUTOR.REBALANCE);
  assert.ok(byId.g2b.amount > 0);
  // Recorded on both endpoints, like gatedFlows, so a reader looking at one pool sees
  // everything that touched it.
  assert.deepEqual(out.liquidityPools.growth.firedFlows.map(f => f.id), ['g2b']);
  assert.deepEqual(out.liquidityPools.cash.firedFlows.map(f => f.id), ['b2c']);
  // Only the cross-account edge emits an action — which is exactly why the cube has to carry
  // the other one.
  assert.deepEqual(out.next.filter(a => a.type === 'POOL_FLOW_APPLY').map(a => a.flowId), ['b2c']);
});

test('POOL-5f: an ANNUAL in-portfolio edge fires ONCE a year, not once per advance', () => {
  // `cadence: ANNUAL` reads `lastFired`, which was stamped only from the TRANSFER half — so
  // an in-portfolio edge was free to re-decide on the July advance against an equity reading
  // that only changes annually.
  const graph = normalizeLiquidityGraph({
    pools: [
      { id: 'buffer', spendOrder: 20, claims: [{ key: 'usStockAccount', sleeves: ['BOND'] }],
        target: { mode: 'AMOUNT', value: 300_000 } },
      { id: 'growth', spendOrder: 30, claims: [{ key: 'usStockAccount', sleeves: ['EQUITY'] }] },
    ],
    flows: [{ id: 'g2b', from: 'growth', to: 'buffer', cadence: 'ANNUAL' }],
  }, ACCOUNTS);
  const broker = new BrokerageAccount(1_100_000, { country: 'US', currency: USD });
  broker.holdings = [
    new Holding({ id: 'bd', allocation: ALLOCATION.BOND,   marketValue: 100_000,   costBasis: 100_000,   purchaseDate: D(2010), rateKey: 'FIXED_INCOME_US' }),
    new Holding({ id: 'eq', allocation: ALLOCATION.EQUITY, marketValue: 1_000_000, costBasis: 1_000_000, purchaseDate: D(2010), rateKey: 'EQUITY_US' }),
  ];
  const base = { usStockAccount: broker, monthlyExpenses: 10_000, effectiveExchangeRates: { USD_AUD: 1 } };
  const r = new PoolFlowReducer({ graph });

  const jan = r.reduce(base, { type: 'US_PERIOD_ADVANCE', date: '2030-01-01' }, new Date('2030-01-01'));
  assert.equal(jan.liquidityPools.buffer.firedFlows.length, 1);
  assert.equal(jan.liquidityPools.buffer.lastFired.g2b, 2030);

  // The AU advance, six months later, on the state January left behind.
  const jul = r.reduce(jan, { type: 'AU_PERIOD_ADVANCE', date: '2030-07-01' }, new Date('2030-07-01'));
  assert.equal(jul.liquidityPools.buffer.firedFlows.length, 0);

  // A new year re-opens it.
  const next = r.reduce(jul, { type: 'US_PERIOD_ADVANCE', date: '2031-01-01' }, new Date('2031-01-01'));
  assert.equal(next.liquidityPools.buffer.firedFlows.length, 1);
});

test('POOL-5d: two sources into one pool SHARE the shortfall — the second tops up the rest', () => {
  const graph = normalizeLiquidityGraph({
    pools: [
      { id: 'cash',    spendOrder: 10, claims: [{ key: 'usSavingsAccount' }], target: { mode: 'AMOUNT', value: 200_000 } },
      { id: 'offset',  spendOrder: 20, claims: [{ key: 'offsetAccount' }] },
      { id: 'growth',  spendOrder: 30, claims: [{ key: 'usStockAccount', sleeves: ['EQUITY'] }] },
    ],
    flows: [
      { id: 'o2c', from: 'offset', to: 'cash', priority: 10 },   // tried FIRST, and is small
      { id: 'g2c', from: 'growth', to: 'cash', priority: 20 },   // covers the remainder
    ],
  }, ACCOUNTS);
  const savings = new CheckingAccount(0, { country: 'US', currency: USD });
  const offset  = new OffsetAccount(50_000, { offsetsPropertyKey: 'house', country: 'US', currency: USD });
  const broker  = new BrokerageAccount(900_000, { country: 'US', currency: USD });
  broker.holdings = [new Holding({ id: 'eq', allocation: ALLOCATION.EQUITY, marketValue: 900_000, costBasis: 900_000, purchaseDate: D(2010), rateKey: 'EQUITY_US' })];
  const state = { usSavingsAccount: savings, offsetAccount: offset, usStockAccount: broker,
                  monthlyExpenses: 10_000, effectiveExchangeRates: { USD_AUD: 1 } };
  const { next } = fire(new PoolFlowReducer({ graph }), state);
  assert.deepEqual(next.map(a => [a.flowId, a.amountBase]), [['o2c', 50_000], ['g2c', 150_000]]);
});

// ─── POOL-8: the transfer executor goes through the taxing seam ─────────────────────

test('POOL-8: a cross-account flow raises the disposal tax action, not just a balance', () => {
  const svc     = new AccountService(new Graph(), new GraphQueryApi(new Graph()), new EventBus());
  const graph   = normalizeLiquidityGraph({
    pools: [
      { id: 'cash',   spendOrder: 10, claims: [{ key: 'usSavingsAccount' }], target: { mode: 'AMOUNT', value: 100_000 } },
      { id: 'growth', spendOrder: 20, claims: [{ key: 'usStockAccount', sleeves: ['EQUITY'] }] },
    ],
    flows: [{ id: 'g2c', from: 'growth', to: 'cash' }],
  }, ACCOUNTS);
  const savings = new CheckingAccount(0, { country: 'US', currency: USD });
  const broker  = new BrokerageAccount(500_000, { country: 'US', currency: USD, drawdownPriority: 4 });
  broker.holdings = [new Holding({ id: 'eq', allocation: ALLOCATION.EQUITY, marketValue: 500_000, costBasis: 100_000, purchaseDate: D(2010), rateKey: 'EQUITY_US' })];
  const state = { usSavingsAccount: savings, usStockAccount: broker, personBirthDate: new Date(1970, 0, 1),
                  monthlyExpenses: 10_000, effectiveExchangeRates: { USD_AUD: 1 } };

  const apply = new PoolFlowApplyReducer({ accountService: svc, graph, accounts: ACCOUNTS });
  const out = apply.reduce(state, { type: 'POOL_FLOW_APPLY', flowId: 'g2c', from: 'growth', to: 'cash', amountBase: 100_000 }, new Date('2030-06-30'));

  assert.equal(Math.round(savings.balance), 100_000);
  assert.equal(Math.round(broker.holdings[0].marketValue), 400_000);
  // A refill that sold an appreciated lot and raised NO tax action is the bug this repo has
  // now found three times. Assert on the action stream, not the balance.
  const tax = out.next.filter(a => a.type === 'STOCK_WITHDRAWAL_TAX');
  assert.equal(tax.length, 1, 'the sale must raise exactly one disposal-tax action');
  assert.ok(tax[0].gain > 0, 'and it must carry the realized gain');
});

test('POOL-8b: a scoped draw does not reach past its source pool', () => {
  const svc   = new AccountService(new Graph(), new GraphQueryApi(new Graph()), new EventBus());
  const graph = normalizeLiquidityGraph({
    pools: [
      { id: 'cash',   spendOrder: 10, claims: [{ key: 'usSavingsAccount' }], target: { mode: 'AMOUNT', value: 500_000 } },
      { id: 'growth', spendOrder: 20, claims: [{ key: 'usStockAccount', sleeves: ['EQUITY'] }] },
    ],
    flows: [{ id: 'g2c', from: 'growth', to: 'cash' }],
  }, ACCOUNTS);
  const savings = new CheckingAccount(0, { country: 'US', currency: USD });
  const broker  = new BrokerageAccount(150_000, { country: 'US', currency: USD, drawdownPriority: 4 });
  broker.holdings = [
    new Holding({ id: 'eq',   allocation: ALLOCATION.EQUITY, marketValue: 100_000, costBasis: 100_000, purchaseDate: D(2010), rateKey: 'EQUITY_US' }),
    new Holding({ id: 'bond', allocation: ALLOCATION.BOND,   marketValue:  50_000, costBasis:  50_000, purchaseDate: D(2010), rateKey: 'FIXED_INCOME_US' }),
  ];
  // A whole extra account the sequence walk WOULD have fallen through to (§3.1 rule 3).
  const other = new BrokerageAccount(400_000, { country: 'US', currency: USD, drawdownPriority: 5 });
  other.holdings = [new Holding({ id: 'x', allocation: ALLOCATION.EQUITY, marketValue: 400_000, costBasis: 400_000, purchaseDate: D(2010), rateKey: 'EQUITY_US' })];
  const state = { usSavingsAccount: savings, usStockAccount: broker, auStockAccount: other,
                  personBirthDate: new Date(1970, 0, 1), monthlyExpenses: 10_000,
                  effectiveExchangeRates: { USD_AUD: 1 } };

  new PoolFlowApplyReducer({ accountService: svc, graph, accounts: ACCOUNTS })
    .reduce(state, { type: 'POOL_FLOW_APPLY', flowId: 'g2c', from: 'growth', to: 'cash', amountBase: 500_000 }, new Date('2030-06-30'));

  // Exactly the pool's own EQUITY sleeve, and nothing else: not the same account's bonds,
  // not the next account down the priority order. A refill that quietly reached past its
  // source would be indistinguishable from the refill working.
  assert.equal(Math.round(savings.balance), 100_000);
  assert.equal(broker.holdings.find(h => h.id === 'bond')?.marketValue, 50_000);
  assert.equal(other.holdings[0].marketValue, 400_000);
});

// ─── POOL-9: one authority ─────────────────────────────────────────────────────────

test('POOL-9: a graph target sizes its own class and leaves the others to the schedule', async () => {
  const { RebalanceToTargetReducer } = await import('../../src/finance/behavioral/rebalance-to-target-reducer.js');
  const graph = normalizeLiquidityGraph({
    pools: [
      { id: 'reserve', spendOrder: 10, claims: [{ key: 'usStockAccount', sleeves: ['BOND'] }],
        target: { mode: 'YEARS_OF_SPEND', value: 4 } },
      { id: 'growth',  spendOrder: 20, claims: [{ key: 'usStockAccount', sleeves: ['EQUITY', 'GOLD'] }] },
    ],
  }, ACCOUNTS);
  const r = new RebalanceToTargetReducer({
    accounts: [{ stateKey: 'usStockAccount', role: 'us-stock' }],
    targetAllocation: { EQUITY: 0.90, GOLD: 0.10 },
    poolGraph: graph,
  });
  // 4 years × 120k = 480k of a 1.2m book ⇒ BOND 40%; the residual 60% splits 90:10.
  const state = { monthlyExpenses: 10_000, effectiveExchangeRates: { USD_AUD: 1 },
                  liquidityPools: { reserve: { target: 480_000 }, growth: {} } };
  const mix = r.resolveScheduledTarget(state, { type: 'US_PERIOD_ADVANCE' }, 1_200_000);
  assert.equal(+mix.BOND.toFixed(4), 0.4);
  assert.equal(+mix.EQUITY.toFixed(4), 0.54);
  assert.equal(+mix.GOLD.toFixed(4), 0.06);
});

test('POOL-9a: a target of ZERO holds none of the class — it does not fall back to the schedule', async () => {
  // "Hold no reserve" is an authorable policy and the natural bottom row of any pool-size
  // sweep. The guard here used to read `target > 0`, which conflated "no target resolved"
  // with "the target is nothing", so a 0-year arm silently held the AUTHORED bond weight —
  // and the bottom row of a size sweep was not a member of its own series. It was found in
  // the field, by a 0-year arm holding MORE bonds than the 2-year arm beside it.
  const { RebalanceToTargetReducer } = await import('../../src/finance/behavioral/rebalance-to-target-reducer.js');
  const graph = normalizeLiquidityGraph({
    pools: [
      { id: 'reserve', spendOrder: 10, claims: [{ key: 'usStockAccount', sleeves: ['BOND'] }],
        target: { mode: 'YEARS_OF_SPEND', value: 0 } },
      { id: 'growth',  spendOrder: 20, claims: [{ key: 'usStockAccount', sleeves: ['EQUITY', 'GOLD'] }] },
    ],
  }, ACCOUNTS);
  const r = new RebalanceToTargetReducer({
    accounts: [{ stateKey: 'usStockAccount', role: 'us-stock' }],
    // A schedule that WANTS bonds, so a fall-through is visible rather than coincidental.
    targetAllocation: { EQUITY: 0.60, BOND: 0.30, GOLD: 0.10 },
    poolGraph: graph,
  });
  const state = { monthlyExpenses: 10_000, effectiveExchangeRates: { USD_AUD: 1 },
                  liquidityPools: { reserve: { target: 0 }, growth: {} } };
  const mix = r.resolveScheduledTarget(state, { type: 'US_PERIOD_ADVANCE' }, 1_200_000);

  assert.equal(+((mix.BOND ?? 0).toFixed(6)), 0, 'a 0 target must hold no bonds');
  // …and the whole book goes to the classes no pool sized, in their scheduled proportions.
  assert.equal(+((mix.EQUITY + mix.GOLD).toFixed(4)), 1);
  assert.equal(+(mix.EQUITY / mix.GOLD).toFixed(4), 6);

  // A pool that resolved NO target still falls through, which is the case the old guard
  // was actually written for.
  const noTarget = new RebalanceToTargetReducer({
    accounts: [{ stateKey: 'usStockAccount', role: 'us-stock' }],
    targetAllocation: { EQUITY: 0.60, BOND: 0.30, GOLD: 0.10 },
    poolGraph: normalizeLiquidityGraph({
      pools: [
        { id: 'reserve', spendOrder: 10, claims: [{ key: 'usStockAccount', sleeves: ['BOND'] }] },
        { id: 'cash',    spendOrder: 15, claims: [{ key: 'usStockAccount', sleeves: ['CASH'] }],
          target: { mode: 'YEARS_OF_SPEND', value: 1 } },
        { id: 'growth',  spendOrder: 20, claims: [{ key: 'usStockAccount', sleeves: ['EQUITY', 'GOLD'] }] },
      ],
    }, ACCOUNTS),
  }).resolveScheduledTarget(
    { monthlyExpenses: 10_000, effectiveExchangeRates: { USD_AUD: 1 },
      liquidityPools: { reserve: {}, cash: { target: 120_000 }, growth: {} } },
    { type: 'US_PERIOD_ADVANCE' }, 1_200_000);
  assert.ok(noTarget.BOND > 0, 'an unsized pool leaves its class to the schedule');
});

test('POOL-9b: a veto pins the vetoed class at what is held, so the band cannot sell it', async () => {
  const { RebalanceToTargetReducer } = await import('../../src/finance/behavioral/rebalance-to-target-reducer.js');
  const graph = normalizeLiquidityGraph({
    pools: [
      { id: 'reserve', spendOrder: 10, claims: [{ key: 'usStockAccount', sleeves: ['BOND'] }] },
      { id: 'growth',  spendOrder: 20, claims: [{ key: 'usStockAccount', sleeves: ['EQUITY'] }] },
    ],
  }, ACCOUNTS);
  const r = new RebalanceToTargetReducer({
    accounts: [{ stateKey: 'usStockAccount', role: 'us-stock' }],
    targetAllocation: { EQUITY: 0.60, BOND: 0.40 },
    poolGraph: graph,
  });
  const state = { monthlyExpenses: 10_000, effectiveExchangeRates: { USD_AUD: 1 },
                  liquidityPools: {}, poolRefillPlan: { vetoed: ['growth'] } };
  // The book holds 50% equity against a 60% target — the band would BUY equity, which
  // means selling bonds, which is fine. What it must never do is SELL the vetoed class.
  const mix = r.resolveScheduledTarget(state, { type: 'US_PERIOD_ADVANCE' }, 1_000_000, { EQUITY: 0.80, BOND: 0.20 });
  assert.ok(mix.EQUITY >= 0.80 - 1e-9, `vetoed class must not be sold down (got ${mix.EQUITY})`);
  assert.equal(+(mix.EQUITY + mix.BOND).toFixed(6), 1);
});

// ─── POOL-10: validation ───────────────────────────────────────────────────────────

const throws = (graph, re, accounts = ACCOUNTS, opts = {}) =>
  assert.throws(() => normalizeLiquidityGraph(graph, accounts, opts), re);

test('POOL-10: every config error in §12.7 throws at config time', () => {
  const P = (over) => ({ pools: [{ id: 'a', spendOrder: 1, claims: [{ key: 'usSavingsAccount' }], ...over }] });

  throws({ pools: [P().pools[0], P().pools[0]] }, /duplicate pool id/);
  throws(P({ claims: [{ key: 'nope' }] }), /not an account stateKey/);
  throws(P({ claims: [{ key: 'usSavingsAccount', sleeves: ['BOND'] }] }), /only a BROKERAGE account/);
  throws(P({ claims: [{ key: 'usStockAccount', sleeves: ['NOPE'] }] }), /unknown sleeve/);
  throws(P({ capacity: { mode: 'OFFSET_CAP' } }), /is not an offset account/);
  // overlap ACROSS pools — the error §3 could not have, because a list has one walk
  throws({ pools: [
    { id: 'a', spendOrder: 1, claims: [{ key: 'usStockAccount', sleeves: ['BOND'] }] },
    { id: 'b', spendOrder: 2, claims: [{ key: 'usStockAccount', sleeves: ['BOND', 'EQUITY'] }] },
  ] }, /another pool already claims/);
  // a size target across two classes has no unique split
  throws(P({ claims: [{ key: 'usStockAccount', sleeves: ['BOND', 'CASH'] }], target: 4 }),
         /has no unique split across classes/);
  // flows
  throws({ ...P(), flows: [{ id: 'f', from: 'a', to: 'zzz' }] }, /unknown destination pool/);
  throws({ ...P(), flows: [{ id: 'f', from: 'a', to: 'a' }] }, /self-edge/);
  throws({ pools: [
    { id: 'a', spendOrder: 1, claims: [{ key: 'usSavingsAccount' }] },
    { id: 'b', spendOrder: 2, claims: [{ key: 'auSavingsAccount' }], target: 1 },
  ], flows: [
    { id: 'ab', from: 'a', to: 'b' },
    { id: 'ba', from: 'b', to: 'a' },
  ] }, /unconditional laundering loop/);
  // a toTarget flow into a pool with no size can only ever move zero
  throws({ pools: [
    { id: 'a', spendOrder: 1, claims: [{ key: 'usSavingsAccount' }] },
    { id: 'b', spendOrder: 2, claims: [{ key: 'auSavingsAccount' }] },
  ], flows: [{ id: 'ab', from: 'a', to: 'b' }] }, /has no `target`/);
  // a transfer into a pool with nowhere to deposit
  throws({ pools: [
    { id: 'a', spendOrder: 1, claims: [{ key: 'usSavingsAccount' }] },
    { id: 'b', spendOrder: 2, claims: [{ key: 'usStockAccount', sleeves: ['BOND'] }], target: 1 },
  ], flows: [{ id: 'ab', from: 'a', to: 'b' }] }, /claims no cash-like/);
  // the three "two authorities" errors
  throws(P(), /PROPORTIONAL/, ACCOUNTS, { drawdownMode: 'PROPORTIONAL' });
  throws(P(), /COMPILES to that field/, ACCOUNTS, { hasDrawdownSequence: true });
  throws(P({ claims: [{ key: 'usStockAccount', sleeves: ['BOND'] }], target: 4 }),
         /poolCashYears/, ACCOUNTS, { hasLegacyPoolYears: true });
});

test('POOL-10b: a CONDITIONAL cycle is legal — harvest and buy-the-dip are both wanted', () => {
  const g = normalizeLiquidityGraph({
    pools: [
      { id: 'reserve', spendOrder: 10, claims: [{ key: 'usStockAccount', sleeves: ['BOND'] }],
        target: { mode: 'YEARS_OF_SPEND', value: 4 } },
      { id: 'growth',  spendOrder: 20, claims: [{ key: 'usStockAccount', sleeves: ['EQUITY'] }] },
    ],
    flows: [
      { id: 'g2r', from: 'growth',  to: 'reserve', gate: { sourceDrawdownUnder: 0.05 } },
      { id: 'dip', from: 'reserve', to: 'growth',  gate: { targetDrawdownOver: 0.20 },
        amount: { fractionOfSource: 0.25 } },
    ],
  }, ACCOUNTS);
  assert.equal(g.flows.length, 2);
  assert.equal(g.flows.every(f => f.executor === FLOW_EXECUTOR.REBALANCE), true);
});

test('POOL-10c: executors are classified by where the two ends live', () => {
  const g = normalizeLiquidityGraph({
    pools: [
      { id: 'reserve', spendOrder: 10, claims: [{ key: 'usStockAccount', sleeves: ['BOND'] }], target: 4 },
      { id: 'growth',  spendOrder: 20, claims: [{ key: 'usStockAccount', sleeves: ['EQUITY'] }] },
      { id: 'cash',    spendOrder: 5,  claims: [{ key: 'usSavingsAccount' }], target: 1 },
    ],
    flows: [
      { id: 'g2r', from: 'growth', to: 'reserve' },   // both in the book ⇒ the rebalancer
      { id: 'g2c', from: 'growth', to: 'cash'    },   // a real debit/credit
    ],
  }, ACCOUNTS);
  assert.equal(g.flows.find(f => f.id === 'g2r').executor, FLOW_EXECUTOR.REBALANCE);
  assert.equal(g.flows.find(f => f.id === 'g2c').executor, FLOW_EXECUTOR.TRANSFER);
});

// ─── POOL-1 / POOL-11: identity, and the round trip through a real load ────────────

test('POOL-1: no graph ⇒ the state key is absent (absent is absent)', () => {
  const { sim } = loadScenarioSim({ simStart: '2026-01-01', simEnd: '2026-06-01' });
  assert.equal('liquidityGraph' in sim.state, false);
  assert.equal('drawdownSequence' in sim.state, false);
  assert.equal('liquidityPools' in sim.state, false);
});

test('POOL-2c: the graph reaches state through a real scenario load, and compiles', () => {
  const { sim } = loadScenarioSim({
    params: {
      behavioralStrategies: ['LIQUIDITY_POOLS'],
      liquidityGraph: {
        pools: [
          { id: 'cash',    spendOrder: 10, claims: [{ key: 'usSavingsAccount' }] },
          { id: 'reserve', spendOrder: 20, claims: [{ key: 'usStockAccount', sleeves: ['BOND'] }] },
          { id: 'growth',  spendOrder: 30, claims: [{ key: 'usStockAccount', sleeves: ['EQUITY', 'GOLD'] }] },
        ],
      },
    },
    simStart: '2026-01-01', simEnd: '2026-06-01',
  });
  // The load-bearing property: the graph is on state AND it has compiled to the field
  // `replenishSavings` already reads, which never learned that pools exist.
  assert.equal(sim.state.liquidityGraph.pools.length, 3);
  assert.deepEqual(sim.state.drawdownSequence, [
    { key: 'usSavingsAccount', sleeves: null },
    { key: 'usStockAccount',   sleeves: ['BOND'] },
    { key: 'usStockAccount',   sleeves: ['EQUITY', 'GOLD'] },
  ]);
});

test('POOL-11: a legal cycle replays byte-identically', () => {
  const params = {
    behavioralStrategies: ['LIQUIDITY_POOLS', 'TARGET_ALLOCATION'],
    liquidityGraph: {
      pools: [
        { id: 'cash',    spendOrder: 10, claims: [{ key: 'usSavingsAccount' }],
          target: { mode: 'YEARS_OF_SPEND', value: 1 } },
        { id: 'reserve', spendOrder: 20, claims: [{ key: 'usStockAccount', sleeves: ['BOND'] }],
          target: { mode: 'YEARS_OF_SPEND', value: 4 } },
        { id: 'growth',  spendOrder: 30, claims: [{ key: 'usStockAccount', sleeves: ['EQUITY'] }] },
      ],
      flows: [
        { id: 'r2c', from: 'reserve', to: 'cash',    trigger: { belowTargetFraction: 0.5 } },
        { id: 'g2r', from: 'growth',  to: 'reserve', gate: { sourceDrawdownUnder: 0.05 } },
        { id: 'dip', from: 'reserve', to: 'growth',  gate: { targetDrawdownOver: 0.25 },
          amount: { fractionOfSource: 0.1 } },
      ],
    },
  };
  const a = loadScenarioSim({ params, simStart: '2026-01-01', simEnd: '2029-01-01', stepTo: '2029-01-01' });
  const b = loadScenarioSim({ params, simStart: '2026-01-01', simEnd: '2029-01-01', stepTo: '2029-01-01' });
  assert.equal(JSON.stringify(a.sim.state), JSON.stringify(b.sim.state));
  assert.ok(a.sim.state.liquidityPools.cash.yearsOfCover != null);
  assert.ok(a.sim.state.liquidityPools.reserve.target > 0);
});

// ─── POOL-12: the market-state gate, and why the drawdown gate needed a partner ────

test('POOL-12: a trailing-high gate cannot tell a falling market from a pool being spent down', () => {
  // The defect this pair exists for. Same pool, same 20%-below-its-high reading, two
  // completely different worlds: one where the market fell, one where the household simply
  // spent the money. `sourceDrawdownUnder` cannot separate them; `sourceReturnOver` can.
  //
  // The reading the gate acts on is the PRIOR period's, stamped on the cube (design 97 §20),
  // so the world is declared there — `effectiveGrowthRates` is set to the same value only so
  // the cube this period stamps is consistent with it.
  const graph = normalizeLiquidityGraph({
    pools: [
      { id: 'cash',   spendOrder: 10, claims: [{ key: 'usSavingsAccount' }], target: { mode: 'AMOUNT', value: 200_000 } },
      { id: 'growth', spendOrder: 20, claims: [{ key: 'usStockAccount', sleeves: ['EQUITY'] }] },
    ],
    flows: [{ id: 'g2c', from: 'growth', to: 'cash', gate: { sourceReturnOver: 0 } }],
  }, ACCOUNTS);

  const make = (equityRate) => {
    const savings = new CheckingAccount(0, { country: 'US', currency: USD });
    const broker  = new BrokerageAccount(800_000, { country: 'US', currency: USD });
    broker.holdings = [new Holding({ id: 'eq', allocation: ALLOCATION.EQUITY, marketValue: 800_000, costBasis: 800_000, purchaseDate: D(2010), rateKey: 'EQUITY_US' })];
    return {
      usSavingsAccount: savings, usStockAccount: broker, monthlyExpenses: 10_000,
      effectiveExchangeRates: { USD_AUD: 1 },
      effectiveGrowthRates: { EQUITY_US: equityRate },
      // 20% below its high in BOTH worlds; the market gate reads `marketReturn`, which is
      // what LAST period ended at.
      liquidityPools: { growth: { high: 1_000_000, marketReturn: equityRate }, cash: { high: 0 } },
    };
  };
  const reducer = new PoolFlowReducer({ graph });

  // Market recovered, pool merely spent down ⇒ harvest is allowed.
  assert.equal(fire(reducer, make(0.08)).next.length, 1);
  // Market actually falling ⇒ the gate shuts and vetoes the source's sale.
  const crash = fire(reducer, make(-0.30));
  assert.equal(crash.next.length, 0);
  assert.deepEqual(crash.state.poolRefillPlan.vetoed, ['growth']);
  assert.match(crash.state.poolRefillPlan.gated[0].reason, /returning -30\.0%/);
});

test('POOL-12b: a pool with no rated lots leaves a market gate inert, not shut', () => {
  // A cash pool has no growth rate. A gate reading one must not silently stop every flow
  // out of it — "no signal" is not "bad signal".
  const graph = normalizeLiquidityGraph({
    pools: [
      { id: 'a', spendOrder: 10, claims: [{ key: 'usSavingsAccount' }] },
      { id: 'b', spendOrder: 20, claims: [{ key: 'auSavingsAccount' }], target: { mode: 'AMOUNT', value: 100_000 } },
    ],
    flows: [{ id: 'a2b', from: 'a', to: 'b', gate: { sourceReturnOver: 0 } }],
  }, ACCOUNTS);
  const state = {
    usSavingsAccount: new CheckingAccount(500_000, { country: 'US', currency: USD }),
    auSavingsAccount: new CheckingAccount(0, { country: 'US', currency: USD }),
    monthlyExpenses: 10_000, effectiveExchangeRates: { USD_AUD: 1 },
    effectiveGrowthRates: { EQUITY_US: -0.4 },
    liquidityPools: { a: { marketReturn: null }, b: { marketReturn: null } },
  };
  assert.equal(fire(new PoolFlowReducer({ graph }), state).next.length, 1);
});

test('POOL-12c: a market gate cannot see the period it is deciding in', () => {
  // Design 97 §20. `EquityReturnReducer` stamps the year's draw at PRE_PROCESS + 1.5 and this
  // reducer runs at PRE_PROCESS + 3, so a gate reading `effectiveGrowthRates` live knows the
  // return of the year it is about to act in — measured at corr(reading_t, realized_t) =
  // 1.0000 by `probe-pool-gate-foresight.mjs`. A household cannot do that, and the resulting
  // arm looks brilliant for a reason that has nothing to do with liquidity.
  //
  // So: a catastrophic CURRENT rate with a healthy PRIOR one must leave the gate OPEN, and
  // the reverse must shut it. The two assertions are the same statement from both sides —
  // one alone would pass against a gate that reads neither.
  const graph = normalizeLiquidityGraph({
    pools: [
      { id: 'cash',   spendOrder: 10, claims: [{ key: 'usSavingsAccount' }], target: { mode: 'AMOUNT', value: 200_000 } },
      { id: 'growth', spendOrder: 20, claims: [{ key: 'usStockAccount', sleeves: ['EQUITY'] }] },
    ],
    flows: [{ id: 'g2c', from: 'growth', to: 'cash', gate: { sourceReturnOver: 0 } }],
  }, ACCOUNTS);

  const make = (liveRate, priorRate) => {
    const savings = new CheckingAccount(0, { country: 'US', currency: USD });
    const broker  = new BrokerageAccount(800_000, { country: 'US', currency: USD });
    broker.holdings = [new Holding({ id: 'eq', allocation: ALLOCATION.EQUITY, marketValue: 800_000, costBasis: 800_000, purchaseDate: D(2010), rateKey: 'EQUITY_US' })];
    return {
      usSavingsAccount: savings, usStockAccount: broker, monthlyExpenses: 10_000,
      effectiveExchangeRates: { USD_AUD: 1 },
      effectiveGrowthRates: { EQUITY_US: liveRate },
      liquidityPools: { growth: { high: 800_000, marketReturn: priorRate }, cash: { high: 0 } },
    };
  };
  const reducer = new PoolFlowReducer({ graph });

  // The year ahead is a catastrophe and the year behind was fine ⇒ the gate must NOT know.
  assert.equal(fire(reducer, make(-0.35, 0.08)).next.length, 1);
  // The year behind was the catastrophe ⇒ this is the rule a household can actually follow.
  assert.equal(fire(reducer, make(0.08, -0.35)).next.length, 0);

  // And the period's own reading is stamped, with the year it was taken in, for a LATER
  // year's gates to act on.
  const stamped = fire(reducer, make(-0.35, 0.08)).state.liquidityPools.growth;
  assert.equal(stamped.marketReturn, -0.35);
  assert.equal(stamped.priorYearReturn, 0.08);
  assert.ok(stamped.marketReturnYear > 2000);
});

test('POOL-12d: a second advance in the same year does not pick up the first one\'s stamp', () => {
  // The half of §20.2 the first fix missed, and the reason the unit here is the YEAR and not
  // the period. This reducer fires on both US_ and AU_PERIOD_ADVANCE, six months apart. With
  // the gate reading "the previous period", the January advance correctly saw last December
  // — and the July one saw THIS JANUARY, i.e. this year's return. Half a year of foresight,
  // in exactly half the evaluations, and invisible to any probe that samples one reading per
  // year (which is how it survived the first fix).
  const graph = normalizeLiquidityGraph({
    pools: [
      { id: 'cash',   spendOrder: 10, claims: [{ key: 'usSavingsAccount' }], target: { mode: 'AMOUNT', value: 200_000 } },
      { id: 'growth', spendOrder: 20, claims: [{ key: 'usStockAccount', sleeves: ['EQUITY'] }] },
    ],
    flows: [{ id: 'g2c', from: 'growth', to: 'cash', gate: { sourceReturnOver: 0 } }],
  }, ACCOUNTS);

  const savings = new CheckingAccount(0, { country: 'US', currency: USD });
  const broker  = new BrokerageAccount(800_000, { country: 'US', currency: USD });
  broker.holdings = [new Holding({ id: 'eq', allocation: ALLOCATION.EQUITY, marketValue: 800_000, costBasis: 800_000, purchaseDate: D(2010), rateKey: 'EQUITY_US' })];
  const base = {
    usSavingsAccount: savings, usStockAccount: broker, monthlyExpenses: 10_000,
    effectiveExchangeRates: { USD_AUD: 1 },
    // Last year was fine; THIS year is the crash.
    effectiveGrowthRates: { EQUITY_US: -0.35 },
    liquidityPools: { growth: { high: 800_000, marketReturn: 0.08, marketReturnYear: 2029 }, cash: { high: 0 } },
  };
  const reducer = new PoolFlowReducer({ graph });

  // January 2030: last completed year was +8% ⇒ open, and −35% is stamped as 2030's.
  const jan = fire(reducer, base, { date: D(2030) });
  assert.equal(jan.next.length, 1, 'the first advance of the year reads LAST year');
  assert.equal(jan.state.liquidityPools.growth.marketReturnYear, 2030);

  // July 2030, carrying January's cube forward: the same year, so the same conclusion.
  const jul = fire(reducer, { ...base, liquidityPools: jan.state.liquidityPools }, { date: new Date(Date.UTC(2030, 6, 1)) });
  assert.equal(jul.next.length, 1, 'the second advance of the year must not see this year\'s crash');
  assert.equal(jul.state.liquidityPools.growth.priorYearReturn, 0.08);
});
