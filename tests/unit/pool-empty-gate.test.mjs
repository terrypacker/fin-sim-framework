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
 * pool-empty-gate.test.mjs
 *
 * DESIGN 124 — what a pool gate measures, and protects, once its pool is empty.
 *
 * EPG-1  an empty sleeve pool's market is the household's holdings of its sleeves, base-weighted
 * EPG-2  a pool that holds anything measures its own lots, and stamps no basis
 * EPG-3  a whole-account empty pool has no class to fall back to: no signal, as before
 * EPG-4  the index keeps compounding once the pool is empty; a later crash shuts the gate and
 *        the source veto floors the household's equity
 * EPG-5  a pool that emptied during a drawdown reopens when the household's equity recovers
 * EPG-6  a BALANCE gate on an empty pool reads no signal (open), not a 100% drawdown
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import { normalizeLiquidityGraph } from '../../src/finance/pools/liquidity-graph.js';
import { allPoolMetrics, poolContext, householdSleeveReturn } from '../../src/finance/pools/pool-metrics.js';
import { PoolFlowReducer }   from '../../src/finance/pools/pool-flow-reducer.js';
import { CheckingAccount, USD, AUD, ACCOUNT_TYPE } from '../../src/finance/assets/account.js';
import { BrokerageAccount, RothAccount } from '../../src/finance/assets/investment-account.js';
import { Holding }           from '../../src/finance/holdings/holding.js';
import { ALLOCATION }        from '../../src/finance/holdings/allocation.js';

const D = (y) => new Date(Date.UTC(y, 0, 1));
const ACCOUNTS = [
  { stateKey: 'usSavingsAccount', type: ACCOUNT_TYPE.SAVINGS },
  { stateKey: 'usStockAccount',   type: ACCOUNT_TYPE.BROKERAGE },
  { stateKey: 'auStockAccount',   type: ACCOUNT_TYPE.BROKERAGE },
  { stateKey: 'rothAccount',      type: ACCOUNT_TYPE.ROTH },
];

const lot = (id, allocation, marketValue, rateKey) =>
  new Holding({ id, allocation, marketValue, costBasis: marketValue, purchaseDate: D(2010), rateKey });

/**
 * cash ← growth (taxable EQUITY, gated) and a whole-account `wrappers` pool over the Roth, so the
 * Roth's equity is in the book but in no gated pool — the shape of the traced plan (§2).
 */
function world({ taxableEquity = 0, rothEquity = 600_000, gate = { sourceDrawdownUnder: 0.2, drawdownBasis: 'INDEX' },
                 rates = { EQUITY_US: 0.08 }, pools = null, au = null } = {}) {
  const graph = normalizeLiquidityGraph({
    pools: [
      { id: 'cash',     spendOrder: 10, claims: [{ key: 'usSavingsAccount' }], target: { mode: 'AMOUNT', value: 200_000 } },
      { id: 'growth',   spendOrder: 20, claims: [{ key: 'usStockAccount', sleeves: ['EQUITY'] }] },
      { id: 'wrappers', spendOrder: 60, claims: [{ key: 'rothAccount' }, ...(au ? [{ key: 'auStockAccount' }] : [])] },
    ],
    flows: [{ id: 'g2c', from: 'growth', to: 'cash', gate }],
  }, ACCOUNTS);
  const broker = new BrokerageAccount(taxableEquity, { country: 'US', currency: USD });
  broker.holdings = [lot('eq', ALLOCATION.EQUITY, taxableEquity, 'EQUITY_US')];
  const roth = new RothAccount(rothEquity, { country: 'US', currency: USD });
  roth.holdings = [lot('r-eq', ALLOCATION.EQUITY, rothEquity, 'EQUITY_US'), lot('r-bd', ALLOCATION.BOND, 100_000, 'FIXED_INCOME_US')];
  const state = {
    usSavingsAccount: new CheckingAccount(0, { country: 'US', currency: USD }),
    usStockAccount: broker, rothAccount: roth,
    monthlyExpenses: 10_000,
    effectiveExchangeRates: { USD_AUD: 1.5 },
    effectiveGrowthRates: { FIXED_INCOME_US: 0.04, ...rates },
    people: { p1: { birthDate: new Date(Date.UTC(1960, 0, 1)) } },
    ...(pools ? { liquidityPools: pools } : {}),
  };
  if (au) {
    const a = new BrokerageAccount(au.mv, { country: 'AU', currency: AUD });
    a.holdings = [lot('au-eq', ALLOCATION.EQUITY, au.mv, 'EQUITY_AU')];
    state.auStockAccount = a;
  }
  return { graph, state, reducer: new PoolFlowReducer({ graph }) };
}

const fire = (reducer, state, date) => {
  const iso = date.toISOString();
  const out = reducer.reduce(state, { type: 'US_PERIOD_ADVANCE', date: iso }, new Date(iso));
  return { next: out.next.filter(a => a.type === 'POOL_FLOW_APPLY'), state: out };
};
const metricsOf = ({ graph, state }) =>
  allPoolMetrics(state, graph, poolContext(state, { baseCurrency: 'USD', asOf: D(2030).getTime() }));

// ─── EPG-1…3 — the measurement ───────────────────────────────────────────────

test('EPG-1: an empty sleeve pool measures the household\'s holdings of its sleeves', () => {
  const m = metricsOf(world({ rates: { EQUITY_US: -0.3 } })).growth;
  assert.equal(m.marketReturn, -0.3, 'the Roth\'s equity, not the Roth\'s bonds');
  assert.equal(m.marketBasis, 'HOUSEHOLD');
});

test('EPG-1b: the household fallback weights in the BASE currency', () => {
  // Roth 600k USD at +10%, AU 300k AUD (= 200k USD at 1.5) at −30%:
  // (600k × 0.10 + 200k × −0.30) / 800k = 0. Weighting native amounts would read −0.0333.
  const w = world({ rates: { EQUITY_US: 0.10, EQUITY_AU: -0.30 }, au: { mv: 300_000 } });
  const m = metricsOf(w).growth;
  assert.equal(m.marketBasis, 'HOUSEHOLD');
  assert.ok(m.marketReturn != null && Math.abs(m.marketReturn) < 1e-12, String(m.marketReturn));
  assert.equal(householdSleeveReturn(w.state, ['GOLD'], ['rothAccount'], 'USD'), null, 'none of the class anywhere');
});

test('EPG-2: a pool that holds anything measures its own lots and stamps no basis', () => {
  const w = world({ taxableEquity: 50_000, rates: { EQUITY_US: 0.05 } });
  const m = metricsOf(w).growth;
  assert.equal(m.marketReturn, 0.05);
  assert.equal(m.marketBasis, undefined);
  const entry = fire(w.reducer, w.state, D(2030)).state.liquidityPools.growth;
  assert.equal('marketBasis' in entry, false, 'a pool that never empties stamps what it always did');
  assert.equal('marketBasisSince' in entry, false);
});

test('EPG-3: a whole-account empty pool has no class to fall back to', () => {
  const w = world();
  w.state.rothAccount.holdings = [];
  const m = metricsOf(w).wrappers;
  assert.equal(m.marketReturn, null);
  assert.equal(m.marketBasis, undefined);
});

// ─── EPG-4…6 — the gate ──────────────────────────────────────────────────────

test('EPG-4: the index keeps compounding once the pool is empty; a crash shuts the gate and vetoes', () => {
  // 2029: the pool is already empty; the household's equity falls 35% that year.
  const w = world({ rates: { EQUITY_US: -0.35 } });
  const y29 = fire(w.reducer, w.state, D(2029));
  const g29 = y29.state.liquidityPools.growth;
  assert.equal(g29.marketReturn, -0.35);
  assert.equal(g29.marketBasis, 'HOUSEHOLD');
  assert.equal(g29.marketBasisSince, 2029);
  assert.equal(y29.state.poolRefillPlan.vetoed.length, 0, 'nothing completed yet: index at its high');

  // 2030 compounds the completed −35%: index 0.65 against a high of 1, past the 20% gate.
  const y30 = fire(w.reducer, { ...w.state, liquidityPools: y29.state.liquidityPools }, D(2030));
  const g30 = y30.state.liquidityPools.growth;
  assert.ok(Math.abs(g30.returnIndex - 0.65) < 1e-9, 'before design 124 it froze at 1');
  assert.equal(g30.marketBasisSince, 2029, 'the year it began, carried');
  assert.deepEqual(y30.state.poolRefillPlan.vetoed, ['growth'],
    'the shut SOURCE gate vetoes the class — which the rebalancer floors household-wide');
});

test('EPG-5: a pool that emptied during a drawdown reopens when the household recovers', () => {
  // Emptied with the index 30% under its high: before design 124 that froze the gate shut.
  const frozen = { growth: { high: 0, returnIndex: 0.7, returnIndexHigh: 1, marketReturn: null, marketReturnYear: 2029 },
                   cash: { high: 0 } };
  const w = world({ rates: { EQUITY_US: 0.5 }, pools: frozen });
  const y30 = fire(w.reducer, w.state, D(2030));
  assert.deepEqual(y30.state.poolRefillPlan.vetoed, ['growth'], 'still shut: the frozen 30% drawdown');
  // 2030's household +50% completes; 0.7 × 1.5 = 1.05, a new high.
  const y31 = fire(w.reducer, { ...w.state, liquidityPools: y30.state.liquidityPools }, D(2031));
  assert.ok(Math.abs(y31.state.liquidityPools.growth.returnIndex - 1.05) < 1e-9);
  assert.deepEqual(y31.state.poolRefillPlan.vetoed, [], 'reopened');
});

test('EPG-6: a BALANCE gate on an empty pool reads no signal, not a 100% drawdown', () => {
  const pools = { growth: { high: 800_000 }, cash: { high: 0 } };
  const balanceGate = { sourceDrawdownUnder: 0.2 };
  const empty = world({ gate: balanceGate, pools });
  assert.deepEqual(fire(empty.reducer, empty.state, D(2030)).state.poolRefillPlan.vetoed, [],
    'open: before design 124 it was shut — and vetoing household equity — for good');
  // A pool that still holds something is measured exactly as before: 50k of an 800k high.
  const low = world({ gate: balanceGate, pools, taxableEquity: 50_000 });
  assert.deepEqual(fire(low.reducer, low.state, D(2030)).state.poolRefillPlan.vetoed, ['growth']);
});
