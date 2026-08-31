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
  // a drawdown BASIS with no drawdown clause to govern (§20.14): it would round-trip a
  // setting that decides nothing, so every saved graph would differ from itself.
  throws({ pools: [
    { id: 'a', spendOrder: 1, claims: [{ key: 'usSavingsAccount' }] },
    { id: 'b', spendOrder: 2, claims: [{ key: 'auSavingsAccount' }], target: 1 },
  ], flows: [{ id: 'ab', from: 'a', to: 'b', gate: { drawdownBasis: 'INDEX' } }] },
    /no drawdown clause/);
  throws({ pools: [
    { id: 'a', spendOrder: 1, claims: [{ key: 'usSavingsAccount' }] },
    { id: 'b', spendOrder: 2, claims: [{ key: 'auSavingsAccount' }], target: 1 },
  ], flows: [{ id: 'ab', from: 'a', to: 'b', gate: { sourceDrawdownUnder: 0.05, drawdownBasis: 'PRICE' } }] },
    /drawdownBasis 'PRICE' is unknown/);
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

// ─── POOL-13: the composed gate — OR, AND, NOT and the dwell (design 97 §20.15) ────

/**
 * One growth pool, one cash pool, one gated edge. `atDrawdown` puts the growth pool a chosen
 * fraction below its trailing high with everything else held still, which is what a gate
 * grammar test needs: the interesting variable is the SHAPE of the gate, not the world.
 */
const gateWorld = ({ drawdown = 0, priorReturn = 0.08 } = {}) => {
  const savings = new CheckingAccount(0, { country: 'US', currency: USD });
  const broker  = new BrokerageAccount(800_000, { country: 'US', currency: USD });
  broker.holdings = [new Holding({ id: 'eq', allocation: ALLOCATION.EQUITY, marketValue: 800_000, costBasis: 800_000, purchaseDate: D(2010), rateKey: 'EQUITY_US' })];
  return {
    usSavingsAccount: savings, usStockAccount: broker, monthlyExpenses: 10_000,
    effectiveExchangeRates: { USD_AUD: 1 },
    effectiveGrowthRates: { EQUITY_US: 0.08 },
    liquidityPools: {
      growth: { high: 800_000 / (1 - drawdown), marketReturn: priorReturn, marketReturnYear: 2029 },
      cash:   { high: 0 },
    },
  };
};
const gatedFlow = (gate) => normalizeLiquidityGraph({
  pools: [
    { id: 'cash',   spendOrder: 10, claims: [{ key: 'usSavingsAccount' }], target: { mode: 'AMOUNT', value: 200_000 } },
    { id: 'growth', spendOrder: 20, claims: [{ key: 'usStockAccount', sleeves: ['EQUITY'] }] },
  ],
  flows: [{ id: 'g2c', from: 'growth', to: 'cash', gate }],
}, ACCOUNTS);
const opens = (gate, state, date = D(2030)) =>
  fire(new PoolFlowReducer({ graph: gatedFlow(gate) }), state, { date }).next.length === 1;

test('POOL-13: clauses on one node are an AND, and that is what a flat gate always meant', () => {
  // The compatibility statement, and the reason the goldens do not move: every gate authored
  // before §20.15 is a single node, and a single node is its clauses ANDed.
  const both = { sourceDrawdownUnder: 0.05, sourceReturnOver: 0 };
  assert.equal(opens(both, gateWorld({ drawdown: 0.02, priorReturn: 0.08 })), true);
  assert.equal(opens(both, gateWorld({ drawdown: 0.20, priorReturn: 0.08 })), false, 'drawdown clause alone shuts it');
  assert.equal(opens(both, gateWorld({ drawdown: 0.02, priorReturn: -0.3 })), false, 'return clause alone shuts it');
});

test('POOL-13b: anyOf is an OR, allOf and a bare array are an AND, not inverts', () => {
  const world = gateWorld({ drawdown: 0.20, priorReturn: 0.08 });

  // The first branch is false at a 20% drawdown, the second is true ⇒ open.
  assert.equal(opens({ anyOf: [{ sourceDrawdownUnder: 0.05 }, { sourceReturnOver: 0 }] }, world), true);
  // Both branches false ⇒ shut, and the reason names both.
  const shut = fire(new PoolFlowReducer({ graph: gatedFlow({
    anyOf: [{ sourceDrawdownUnder: 0.05 }, { sourceReturnOver: 0.5 }] }) }), world);
  assert.equal(shut.next.length, 0);
  assert.match(shut.state.poolRefillPlan.gated[0].reason, /no branch open/);

  // allOf and the array sugar are the same AND, and both are shut by the 20% drawdown.
  assert.equal(opens({ allOf: [{ sourceDrawdownUnder: 0.05 }, { sourceReturnOver: 0 }] }, world), false);
  assert.equal(opens([{ sourceDrawdownUnder: 0.05 }, { sourceReturnOver: 0 }], world), false);
  assert.equal(opens({ allOf: [{ sourceDrawdownUnder: 0.5 }, { sourceReturnOver: 0 }] }, world), true);

  // not inverts, and nests.
  assert.equal(opens({ not: { sourceDrawdownUnder: 0.05 } }, world), true);
  assert.equal(opens({ not: { sourceDrawdownUnder: 0.5 } }, world), false);
});

test('POOL-13c: sustainedYears holds the gate shut until the condition has held that long', () => {
  // The lever §20.13 measured as the one that matters: the threshold barely moved the arms,
  // the DURATION moved them by two orders of magnitude more.
  const gate    = { sourceDrawdownUnder: 0.05, sustainedYears: 2 };
  const reducer = new PoolFlowReducer({ graph: gatedFlow(gate) });
  const near    = gateWorld({ drawdown: 0.02 });

  // Year one: the condition is true for the first time — one year of two.
  const y1 = fire(reducer, near, { date: D(2030) });
  assert.equal(y1.next.length, 0, 'a 2-year dwell cannot be satisfied on its first year');
  assert.match(y1.state.poolRefillPlan.gated[0].reason, /held 1 of 2 years/);
  assert.equal(y1.state.liquidityPools.cash.gateStreaks.g2c.gate.n, 1);

  // Year two, carrying the cube forward: the dwell is met.
  const y2 = fire(reducer, { ...near, liquidityPools: y1.state.liquidityPools }, { date: D(2031) });
  assert.equal(y2.next.length, 1);
  assert.equal(y2.state.liquidityPools.cash.gateStreaks.g2c.gate.n, 2);

  // A year in which the condition fails resets the count to zero, not to one. The world has
  // to be broken ON THE CARRIED CUBE — `high` is monotone pool state, so handing the reducer
  // a fresh world with a bigger high would simply be ignored in favour of the one it kept.
  const fallen = { ...near, liquidityPools: {
    ...y2.state.liquidityPools,
    growth: { ...y2.state.liquidityPools.growth, high: 800_000 / (1 - 0.30) },
  } };
  const broken = fire(reducer, fallen, { date: D(2032) });
  assert.equal(broken.next.length, 0);
  assert.equal(broken.state.liquidityPools.cash.gateStreaks.g2c.gate.n, 0);
});

test('POOL-13d: a dwell counts YEARS, so a second advance in one year does not advance it', () => {
  // The same statement POOL-12d makes about the market reading. A dwell counted in
  // evaluations would mean one year in a US-only plan and half a year in a cross-border one,
  // from the same authored number — and the cross-border plan is the ordinary case here.
  const reducer = new PoolFlowReducer({ graph: gatedFlow({ sourceDrawdownUnder: 0.05, sustainedYears: 2 }) });
  const near    = gateWorld({ drawdown: 0.02 });

  const jan = fire(reducer, near, { date: D(2030) });
  assert.equal(jan.next.length, 0);
  const jul = fire(reducer, { ...near, liquidityPools: jan.state.liquidityPools },
    { date: new Date(Date.UTC(2030, 6, 1)) });
  assert.equal(jul.next.length, 0, 'the second advance of the same year must not satisfy a 2-year dwell');
  assert.equal(jul.state.liquidityPools.cash.gateStreaks.g2c.gate.n, 1);
});

test('POOL-13e: the author\'s composed rule — near the high for a year OR at it for two', () => {
  // The rule this grammar was built for, stated as it was asked for: refill when the source
  // is within 5% of its high for one year, OR within 1% of it for two. Each branch carries
  // its own dwell, which is the whole reason dwell attaches to a NODE rather than to a gate.
  const gate = { anyOf: [
    { sourceDrawdownUnder: 0.05, sustainedYears: 1 },
    { sourceDrawdownUnder: 0.01, sustainedYears: 2 },
  ] };
  const reducer = new PoolFlowReducer({ graph: gatedFlow(gate) });

  // Within 5% ⇒ the first branch alone opens it, on its first year.
  assert.equal(opens(gate, gateWorld({ drawdown: 0.03 })), true);

  // Below both thresholds ⇒ neither branch can open, however long it holds.
  const far = gateWorld({ drawdown: 0.30 });
  const f1  = fire(reducer, far, { date: D(2030) });
  const f2  = fire(reducer, { ...far, liquidityPools: f1.state.liquidityPools }, { date: D(2031) });
  assert.equal(f2.next.length, 0);

  // At the high but only for one year: the 5% branch would open it, so to see the 1%/2-year
  // branch on its own the world has to sit between the two thresholds first — 3% down for a
  // year (5% branch open) then 0.5% down (1% branch in year one). The composed gate stays
  // open throughout, which is the point: the branches cover each other.
  const near = gateWorld({ drawdown: 0.005 });
  const n1   = fire(reducer, near, { date: D(2030) });
  assert.equal(n1.next.length, 1, 'the 5% branch carries year one');
  const n2   = fire(reducer, { ...near, liquidityPools: n1.state.liquidityPools }, { date: D(2031) });
  assert.equal(n2.next.length, 1);
  // …and by year two BOTH branches are satisfied, which the streaks record separately.
  const streaks = n2.state.liquidityPools.cash.gateStreaks.g2c;
  assert.equal(streaks['gate.anyOf[0]'].n, 2);
  assert.equal(streaks['gate.anyOf[1]'].n, 2);
});

test('POOL-13f: a composed gate replays byte-identically', () => {
  // The dwell is the first piece of gate state that is neither a balance nor a rate, so it
  // has to survive serialization on its own terms (§12.3's rule for the trailing high).
  const params = {
    behavioralStrategies: ['LIQUIDITY_POOLS'],
    liquidityGraph: {
      pools: [
        { id: 'cash',   spendOrder: 10, claims: [{ key: 'usSavingsAccount' }], target: { mode: 'YEARS_OF_SPEND', value: 1 } },
        { id: 'growth', spendOrder: 20, claims: [{ key: 'usStockAccount', sleeves: ['EQUITY'] }] },
      ],
      flows: [{ id: 'g2c', from: 'growth', to: 'cash', gate: { anyOf: [
        { sourceDrawdownUnder: 0.05, sustainedYears: 2 },
        { sourceReturnOver: 0.02, sustainedYears: 1 },
      ] } }],
    },
  };
  const a = loadScenarioSim({ params, simStart: '2026-01-01', simEnd: '2029-01-01', stepTo: '2029-01-01' });
  const b = loadScenarioSim({ params, simStart: '2026-01-01', simEnd: '2029-01-01', stepTo: '2029-01-01' });
  assert.equal(JSON.stringify(a.sim.state), JSON.stringify(b.sim.state));
  assert.ok(a.sim.state.liquidityPools.cash.gateStreaks.g2c['gate.anyOf[0]']);
});

test('POOL-13g: a branch that decides nothing is a config error, not an open gate', () => {
  // The most expensive way this feature could fail: an empty `anyOf` branch normalizes to
  // "no conditions", an unconditioned branch is always open, and one always-open branch makes
  // the whole gate always open — silently, and the run still looks plausible.
  throws({ pools: [
    { id: 'a', spendOrder: 1, claims: [{ key: 'usSavingsAccount' }] },
    { id: 'b', spendOrder: 2, claims: [{ key: 'auSavingsAccount' }], target: 1 },
  ], flows: [{ id: 'ab', from: 'a', to: 'b', gate: { anyOf: [{ sourceReturnOver: 0 }, {}] } }] },
    /always-open branch/);
  throws({ pools: [
    { id: 'a', spendOrder: 1, claims: [{ key: 'usSavingsAccount' }] },
    { id: 'b', spendOrder: 2, claims: [{ key: 'auSavingsAccount' }], target: 1 },
  ], flows: [{ id: 'ab', from: 'a', to: 'b', gate: { sustainedYears: 3 } }] },
    /no condition to sustain/);
  throws({ pools: [
    { id: 'a', spendOrder: 1, claims: [{ key: 'usSavingsAccount' }] },
    { id: 'b', spendOrder: 2, claims: [{ key: 'auSavingsAccount' }], target: 1 },
  ], flows: [{ id: 'ab', from: 'a', to: 'b', gate: { sourceReturnOver: 0, sustainedYears: 1.5 } }] },
    /whole number of years/);
});

test('POOL-12e: a drawdownBasis INDEX gate is not moved by spending, where BALANCE is', () => {
  // Design 97 §20.14, and it is POOL-12's world seen from the other side. POOL-12 shows the
  // trailing-BALANCE gate cannot separate "the market fell" from "the household spent the
  // pool", and answers it with a return gate. The index answers it without giving up the
  // gate's own question: it is a unit-value series, so a withdrawal cannot move it.
  //
  // One state, two gates. The pool is 20% below its peak BALANCE with its return index at a
  // fresh high — the market recovered, the money was spent. BALANCE must shut, INDEX must not.
  const graphOf = (gate) => normalizeLiquidityGraph({
    pools: [
      { id: 'cash',   spendOrder: 10, claims: [{ key: 'usSavingsAccount' }], target: { mode: 'AMOUNT', value: 200_000 } },
      { id: 'growth', spendOrder: 20, claims: [{ key: 'usStockAccount', sleeves: ['EQUITY'] }] },
    ],
    flows: [{ id: 'g2c', from: 'growth', to: 'cash', gate }],
  }, ACCOUNTS);

  const savings = new CheckingAccount(0, { country: 'US', currency: USD });
  const broker  = new BrokerageAccount(800_000, { country: 'US', currency: USD });
  broker.holdings = [new Holding({ id: 'eq', allocation: ALLOCATION.EQUITY, marketValue: 800_000, costBasis: 800_000, purchaseDate: D(2010), rateKey: 'EQUITY_US' })];
  const state = {
    usSavingsAccount: savings, usStockAccount: broker, monthlyExpenses: 10_000,
    effectiveExchangeRates: { USD_AUD: 1 },
    effectiveGrowthRates: { EQUITY_US: 0.08 },
    liquidityPools: {
      // 1,000,000 peak against an 800,000 balance = 20% down on BALANCE …
      growth: { high: 1_000_000, returnIndex: 1.5, returnIndexHigh: 1.5, marketReturn: 0.08, marketReturnYear: 2029 },
      cash:   { high: 0 },
    },
  };

  const balanceGate = fire(new PoolFlowReducer({ graph: graphOf({ sourceDrawdownUnder: 0.05 }) }), state);
  assert.equal(balanceGate.next.length, 0, 'the BALANCE basis counts the spending as drawdown');
  assert.match(balanceGate.state.poolRefillPlan.gated[0].reason, /below its high/);

  // … and 0% down on the index, which is what the gate's name actually asks.
  const indexGate = fire(new PoolFlowReducer({
    graph: graphOf({ sourceDrawdownUnder: 0.05, drawdownBasis: 'INDEX' }) }), state);
  assert.equal(indexGate.next.length, 1, 'the INDEX basis is flow-neutral');

  // And the reverse world, or the test passes against a gate that reads nothing: the index
  // below its own peak must shut the INDEX gate even with the balance at a fresh high.
  const fallen = { ...state, liquidityPools: {
    growth: { high: 800_000, returnIndex: 1.2, returnIndexHigh: 1.5, marketReturn: 0.08, marketReturnYear: 2029 },
    cash:   { high: 0 } } };
  const shut = fire(new PoolFlowReducer({
    graph: graphOf({ sourceDrawdownUnder: 0.05, drawdownBasis: 'INDEX' }) }), fallen);
  assert.equal(shut.next.length, 0);
  assert.match(shut.state.poolRefillPlan.gated[0].reason, /below its return index's high/);
});

test('POOL-12f: the return index compounds COMPLETED years only, once per year', () => {
  // The index is the series a gate acts on, so it inherits §20.2 exactly: compounding the
  // year in progress would hand the gate that year's return, which is the foresight POOL-12c
  // exists to forbid. The two assertions are the same statement POOL-12d makes about the
  // return stamp, one derivative up.
  const graph = normalizeLiquidityGraph({
    pools: [
      { id: 'cash',   spendOrder: 10, claims: [{ key: 'usSavingsAccount' }], target: { mode: 'AMOUNT', value: 200_000 } },
      { id: 'growth', spendOrder: 20, claims: [{ key: 'usStockAccount', sleeves: ['EQUITY'] }] },
    ],
    flows: [{ id: 'g2c', from: 'growth', to: 'cash', gate: { sourceDrawdownUnder: 0.05, drawdownBasis: 'INDEX' } }],
  }, ACCOUNTS);

  const savings = new CheckingAccount(0, { country: 'US', currency: USD });
  const broker  = new BrokerageAccount(800_000, { country: 'US', currency: USD });
  broker.holdings = [new Holding({ id: 'eq', allocation: ALLOCATION.EQUITY, marketValue: 800_000, costBasis: 800_000, purchaseDate: D(2010), rateKey: 'EQUITY_US' })];
  const base = {
    usSavingsAccount: savings, usStockAccount: broker, monthlyExpenses: 10_000,
    effectiveExchangeRates: { USD_AUD: 1 },
    effectiveGrowthRates: { EQUITY_US: -0.35 },              // THIS year, in progress
    liquidityPools: {
      growth: { high: 800_000, returnIndex: 1, returnIndexHigh: 1, marketReturn: 0.10, marketReturnYear: 2029 },
      cash:   { high: 0 },
    },
  };
  const reducer = new PoolFlowReducer({ graph });

  // January 2030 compounds 2029's completed +10% and NOT the −35% now in progress.
  const jan = fire(reducer, base, { date: D(2030) });
  assert.equal(jan.state.liquidityPools.growth.returnIndex, 1.1);
  assert.equal(jan.state.liquidityPools.growth.returnIndexHigh, 1.1);
  assert.equal(jan.next.length, 1, 'a completed up year leaves the gate open');

  // July 2030 is the same year: nothing more compounds, and the two advances agree.
  const jul = fire(reducer, { ...base, liquidityPools: jan.state.liquidityPools },
    { date: new Date(Date.UTC(2030, 6, 1)) });
  assert.equal(jul.state.liquidityPools.growth.returnIndex, 1.1);
  assert.equal(jul.next.length, 1);

  // January 2031 compounds 2030's −35%: the index falls below its peak and the gate shuts.
  const y31 = fire(reducer, { ...base, liquidityPools: jul.state.liquidityPools }, { date: D(2031) });
  assert.ok(Math.abs(y31.state.liquidityPools.growth.returnIndex - 0.715) < 1e-9);
  assert.equal(y31.state.liquidityPools.growth.returnIndexHigh, 1.1);
  assert.equal(y31.next.length, 0);
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

// ═════════════════════════════════════════════════════════════════════════════
// §20.18 — a market clause on a pool that has no market
// ═════════════════════════════════════════════════════════════════════════════

/** Run `fn` capturing console.warn, so a config-time warning is a value a test can assert on. */
function capturingWarnings(fn) {
  const real = console.warn;
  const lines = [];
  console.warn = (...a) => lines.push(a.join(' '));
  try { fn(); } finally { console.warn = real; }
  return lines;
}

const CASH_MARKET_GRAPH = (gate) => ({
  pools: [
    { id: 'cash',   spendOrder: 10, claims: [{ key: 'usSavingsAccount' }], target: { mode: 'AMOUNT', value: 100_000 } },
    { id: 'offset', spendOrder: 20, claims: [{ key: 'offsetAccount' }], capacity: { mode: 'OFFSET_CAP' } },
    { id: 'growth', spendOrder: 30, claims: [{ key: 'usStockAccount', sleeves: ['EQUITY'] }] },
  ],
  flows: [{ id: 'o2c', from: 'offset', to: 'cash', gate }],
});

test('POOL-14: an INDEX drawdown clause on a cash pool warns — it can only ever be constant', () => {
  // The defect this exists for, from a real plan: `not { sourceDrawdownUnder, INDEX }` on an
  // OFFSET source. The offset holds no lots, so its return is null, its index never moves off
  // its high, the drawdown is 0 forever, and the clause is permanently satisfied — which under
  // the `not` makes the edge permanently SHUT. It fired 0 times in a 35-year run.
  const warnings = capturingWarnings(() =>
    normalizeLiquidityGraph(CASH_MARKET_GRAPH({ not: { sourceDrawdownUnder: 0.1, drawdownBasis: 'INDEX' } }), ACCOUNTS));
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /flow 'o2c' gate\.not\.sourceDrawdownUnder/);
  assert.match(warnings[0], /pool 'offset'/);
  assert.match(warnings[0], /ALWAYS FALSE/, 'a `not` above the clause flips its absent-reading default');
});

test('POOL-14b: the same clause WITHOUT the negation is always TRUE, and says so', () => {
  const warnings = capturingWarnings(() =>
    normalizeLiquidityGraph(CASH_MARKET_GRAPH({ sourceDrawdownUnder: 0.1, drawdownBasis: 'INDEX' }), ACCOUNTS));
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /ALWAYS TRUE/);
});

test('POOL-14c: the BALANCE basis on the same pool does NOT warn — a balance is a real series', () => {
  // The working-detector control, and the reason this is a warning and not an error: a cash
  // pool really does have a balance to measure against, so the same clause on the default
  // basis is a legitimate authoring.
  const warnings = capturingWarnings(() =>
    normalizeLiquidityGraph(CASH_MARKET_GRAPH({ sourceDrawdownUnder: 0.1 }), ACCOUNTS));
  assert.deepEqual(warnings, []);
});

test('POOL-14d: a market clause on a pool that HOLDS lots does not warn', () => {
  const graph = {
    pools: CASH_MARKET_GRAPH({}).pools,
    flows: [{ id: 'g2c', from: 'growth', to: 'cash',
              gate: { sourceDrawdownUnder: 0.1, drawdownBasis: 'INDEX' } }],
  };
  assert.deepEqual(capturingWarnings(() => normalizeLiquidityGraph(graph, ACCOUNTS)), []);
});

test('POOL-14e: the return pair has no basis to choose, so it warns on a cash pool either way', () => {
  const warnings = capturingWarnings(() =>
    normalizeLiquidityGraph(CASH_MARKET_GRAPH({ sourceReturnOver: 0 }), ACCOUNTS));
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /sourceReturnOver/);
});

test('POOL-15: a gated source the rebalancer cannot sell records no veto', () => {
  // `_applyVeto` pins the target of the vetoed pool's ALLOCATION classes. A cash/offset pool
  // narrows no sleeves, so it names no class and the veto is a no-op — logging one anyway put
  // a "rebalance veto" row in the panel for every period of a run, for a decision never taken.
  const graph = normalizeLiquidityGraph(CASH_MARKET_GRAPH({ notBefore: '2040-01-01' }), ACCOUNTS);
  const state = {
    usSavingsAccount: new CheckingAccount(0, { country: 'US', currency: USD }),
    offsetAccount: new OffsetAccount(300_000, { offsetsPropertyKey: 'house', country: 'US', currency: USD }),
    usStockAccount: new BrokerageAccount(0, { country: 'US', currency: USD }),
    houseLoan: new LoanAccount(200_000, { linkedPropertyKey: 'house', country: 'US', currency: USD }),
    monthlyExpenses: 10_000, effectiveExchangeRates: { USD_AUD: 1 },
  };
  const out = fire(new PoolFlowReducer({ graph }), state);
  // The gate really is shut and the non-event really is recorded…
  assert.equal(out.state.poolRefillPlan.gated.length, 1);
  assert.equal(out.state.poolRefillPlan.gated[0].from, 'offset');
  // …but there is no sale for a veto to stop.
  assert.deepEqual(out.state.poolRefillPlan.vetoed, []);
});

// ═════════════════════════════════════════════════════════════════════════════
// §20.19/§20.20 — the two settings a refill edge cannot see
// ═════════════════════════════════════════════════════════════════════════════

/** ACCOUNTS, plus the ROLE the rebalancer keys off — the fixture set carries only types. */
const ROLED = [
  { stateKey: 'usSavingsAccount', type: ACCOUNT_TYPE.SAVINGS,   role: 'us-savings' },
  { stateKey: 'usStockAccount',   type: ACCOUNT_TYPE.BROKERAGE, role: 'us-stock' },
  { stateKey: 'fixedIncomeAccount', type: ACCOUNT_TYPE.BROKERAGE, role: 'fixed-income' },
];

const REFILL_GRAPH = (bondKey) => ({
  pools: [
    { id: 'bonds',  spendOrder: 10, target: { mode: 'AMOUNT', value: 50_000 },
      claims: [{ key: bondKey, sleeves: ['BOND'] }] },
    { id: 'growth', spendOrder: 20, claims: [{ key: 'usStockAccount', sleeves: ['EQUITY'] }] },
  ],
  flows: [{ id: 'g2b', from: 'growth', to: 'bonds' }],
});

test('POOL-16: a REBALANCE edge into a role the rebalancer cannot trade warns', () => {
  // `fixed-income` is in neither TAX_ADVANTAGED_ROLES nor TAXABLE_ROLES, so the reducer never
  // sees the account: the edge validates, saves, and moves nothing, for ever, without even a
  // failed firing to look at — a REBALANCE edge emits no action of its own.
  const warnings = capturingWarnings(() =>
    normalizeLiquidityGraph(REFILL_GRAPH('fixedIncomeAccount'), ROLED));
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /flow 'g2b' is an in-portfolio \(REBALANCE\) edge/);
  assert.match(warnings[0], /destination pool 'bonds' claims 'fixedIncomeAccount'/);
});

test('POOL-16b: the same edge into a taxable brokerage sleeve is silent', () => {
  // The working-detector control, and the shape design 97 §20.19 recommends: two pools over
  // two sleeves of ONE brokerage.
  const g = REFILL_GRAPH('usStockAccount');
  g.pools[1].claims = [{ key: 'usStockAccount', sleeves: ['EQUITY'] }];
  assert.deepEqual(capturingWarnings(() => normalizeLiquidityGraph(g, ROLED)), []);
});

test('POOL-16c: no roles supplied ⇒ no warning (an absent role is not an untradeable one)', () => {
  // Several call sites pass `{stateKey, type}` projections. Warning on those would fire on
  // every graph in the test suite and mean nothing.
  assert.deepEqual(
    capturingWarnings(() => normalizeLiquidityGraph(REFILL_GRAPH('usStockAccount'), ACCOUNTS)), []);
});

test('POOL-17: an interest-bearing account may not hold EQUITY or GOLD', async () => {
  const { assertInterestBearingHoldings, INTEREST_BEARING_ALLOCATIONS } =
    await import('../../src/finance/holdings/default-allocations.js');
  assert.deepEqual([...INTEREST_BEARING_ALLOCATIONS], ['BOND', 'CASH']);

  const acct = (allocation) => ({
    stateKey: 'fixedIncomeAccount', role: 'fixed-income',
    holdings: [{ id: 'h1', allocation, label: 'X', marketValue: 1000 }],
  });
  // BOND and CASH resolve FIXED_INCOME_<cc> / SAVINGS_<cc>, both of which the interest
  // series carries.
  assert.doesNotThrow(() => assertInterestBearingHoldings(acct('BOND')));
  assert.doesNotThrow(() => assertInterestBearingHoldings(acct('CASH')));
  // EQUITY and GOLD have no entry in it, so they would silently take the ACCOUNT's interest
  // rate and be booked as ordinary interest income.
  assert.throws(() => assertInterestBearingHoldings(acct('EQUITY')),
    /holds a EQUITY holding .*effectiveInterestRates/s);
  assert.throws(() => assertInterestBearingHoldings(acct('GOLD')), /GOLD/);
  // An empty account is fine — that is every scenario that has one and does not use it.
  assert.doesNotThrow(() => assertInterestBearingHoldings({ stateKey: 'k', role: 'fixed-income', holdings: [] }));
});
