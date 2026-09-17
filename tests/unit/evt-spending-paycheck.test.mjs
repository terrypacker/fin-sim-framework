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
 * Design 107 §5 — THE PAYCHECK.
 *
 * `FLOW_CADENCE.PAYCHECK` plus the `SPENDING_REFILL` action let one evaluator serve two
 * triggers. The tests here are mostly about the SEAM rather than the arithmetic — the (s, S)
 * demand, the gates and the shortfall sharing are POOL-5..POOL-23's subject and are reused
 * unchanged. What is new, and what breaks silently if it regresses, is:
 *
 *   · the two trigger sets are disjoint (PAY-1, PAY-2);
 *   · a paycheck does NOT restamp the per-calendar-year series (PAY-4, PAY-5) — the failure
 *     mode there is a later year's gate reading a mid-year sample of the year it is deciding
 *     in, which is §20.2's clairvoyance defect arriving by a new road;
 *   · the two evaluations ACCUMULATE their flow record rather than overwriting it (PAY-6),
 *     because a US paycheck shares 1 January with the US advance.
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import { normalizeLiquidityGraph, FLOW_CADENCE } from '../../src/finance/pools/liquidity-graph.js';
import { poolMetrics, poolContext } from '../../src/finance/pools/pool-metrics.js';
import { PoolFlowReducer }   from '../../src/finance/pools/pool-flow-reducer.js';
import { SpendingRefillHandler } from '../../src/finance/handlers/spending-refill-handler.js';
import { CheckingAccount, USD, ACCOUNT_TYPE } from '../../src/finance/assets/account.js';
import { BrokerageAccount }  from '../../src/finance/assets/investment-account.js';
import { Holding }           from '../../src/finance/holdings/holding.js';
import { ALLOCATION }        from '../../src/finance/holdings/allocation.js';

const ACCOUNTS = [
  { stateKey: 'usSavingsAccount', type: ACCOUNT_TYPE.CHECKING },
  { stateKey: 'usStockAccount',   type: ACCOUNT_TYPE.BROKERAGE },
];

/**
 * A float fed by one PAYCHECK edge and one ordinary PERIOD edge out of the same source, so
 * every test can ask "which of the two fired?" and get an unambiguous answer.
 */
function fixture({ float = 0, equity = 1_000_000, paycheckFlow = {}, periodFlow = null, prior = null } = {}) {
  const flows = [{
    id: 'paycheck', from: 'growth', to: 'float',
    cadence: FLOW_CADENCE.PAYCHECK, amount: { toTarget: true },
    ...paycheckFlow,
  }];
  if (periodFlow) flows.push({ id: 'period', from: 'growth', to: 'float', amount: { toTarget: true }, ...periodFlow });

  const graph = normalizeLiquidityGraph({
    pools: [
      { id: 'float',  spendOrder: 0,  claims: [{ key: 'usSavingsAccount' }],
        target: { mode: 'YEARS_OF_SPEND', value: 1 } },
      { id: 'growth', spendOrder: 20, claims: [{ key: 'usStockAccount', sleeves: ['EQUITY'] }] },
    ],
    flows,
  }, ACCOUNTS);

  const savings = new CheckingAccount(float, { country: 'US', currency: USD });
  const broker  = new BrokerageAccount(equity, { country: 'US', currency: USD, drawdownPriority: 4 });
  broker.holdings = [new Holding({ id: 'eq', allocation: ALLOCATION.EQUITY, marketValue: equity,
    costBasis: equity / 2, purchaseDate: new Date(Date.UTC(2010, 0, 1)), rateKey: 'EQUITY_US' })];

  const state = {
    usSavingsAccount: savings, usStockAccount: broker,
    monthlyExpenses: 10_000,                     // 120k/yr ⇒ the float's target is 120k
    effectiveExchangeRates: { USD_AUD: 1 },
    people: { p1: { birthDate: new Date(Date.UTC(1975, 0, 1)) } },
    ...(prior ? { liquidityPools: prior } : {}),
  };
  return { graph, state, reducer: new PoolFlowReducer({ graph }) };
}

const run = (reducer, state, type, date = '2030-01-01') =>
  reducer.reduce(state, { type, date: new Date(date).toISOString() }, new Date(date));

const transfers = out => out.next.filter(a => a.type === 'POOL_FLOW_APPLY');

// ─── the seam ────────────────────────────────────────────────────────────────────

test('PAY-1: a PERIOD ADVANCE does not fire a PAYCHECK edge', () => {
  const { reducer, state } = fixture({ float: 0 });
  const out = run(reducer, state, 'US_PERIOD_ADVANCE');
  assert.equal(transfers(out).length, 0,
    'the float is empty and wants 120k, but only a SPENDING_REFILL may fill it');
});

test('PAY-2: a SPENDING_REFILL fires ONLY the PAYCHECK edge, never the ordinary ones', () => {
  // Both edges want the same 120k. Exactly one of them is allowed to answer.
  const { reducer, state } = fixture({ float: 0, periodFlow: { priority: 1 } });
  const paid = transfers(run(reducer, state, 'SPENDING_REFILL'));
  assert.equal(paid.length, 1);
  assert.equal(paid[0].flowId, 'paycheck');
  assert.equal(paid[0].amountBase, 120_000, 'filled to the pool target, i.e. amount.toTarget');

  // …and the mirror: the period advance answers with the other edge alone.
  const adv = transfers(run(reducer, state, 'US_PERIOD_ADVANCE'));
  assert.equal(adv.length, 1);
  assert.equal(adv[0].flowId, 'period');
});

test('PAY-3: the paycheck is NET of what already arrived — it fills the shortfall, not the target', () => {
  // 50k of dividend cash has already landed in the float (it claims the transaction account,
  // so yield lands INSIDE the pool). The paycheck must sell 70k, not 120k — design 107 §5.3.
  const { reducer, state } = fixture({ float: 50_000 });
  const paid = transfers(run(reducer, state, 'SPENDING_REFILL'));
  assert.equal(paid[0].amountBase, 70_000);
});

// ─── the annual series a paycheck must not touch ─────────────────────────────────

/** A cube as a period advance would have left it at the end of 2029. */
const priorCube = () => ({
  float:  { balance: 0, high: 400_000, marketReturn: 0.11, marketReturnYear: 2029,
            returnIndex: 1.5, returnIndexHigh: 1.5, inflow: 0, outflow: 0,
            firedFlows: [], gatedFlows: [], lastFired: {} },
  growth: { balance: 1_000_000, high: 1_000_000, marketReturn: 0.11, marketReturnYear: 2029,
            returnIndex: 1.5, returnIndexHigh: 1.5, inflow: 0, outflow: 0,
            firedFlows: [], gatedFlows: [], lastFired: {} },
});

test('PAY-4: a paycheck does not restamp the market observation or the return index', () => {
  const { reducer, state } = fixture({ float: 0, prior: priorCube() });
  const cube = run(reducer, state, 'SPENDING_REFILL', '2030-07-01').liquidityPools;
  for (const id of ['float', 'growth']) {
    assert.equal(cube[id].marketReturnYear, 2029, `${id}: the year of the observation is untouched`);
    assert.equal(cube[id].marketReturn,     0.11, `${id}: the observation itself is untouched`);
    assert.equal(cube[id].returnIndex,      1.5,  `${id}: the compounded index is untouched`);
    assert.equal(cube[id].returnIndexHigh,  1.5,  `${id}: and so is its peak`);
  }
});

test('PAY-5: a paycheck does not ratchet the trailing balance HIGH', () => {
  // The float goes from 0 to 120k. On a period advance that would raise its high; on a
  // paycheck it must not, or a quarterly cadence would sample the peak four extra times a
  // year and widen every BALANCE-basis drawdown for reasons unrelated to the market.
  const { reducer, state } = fixture({ float: 0, prior: priorCube() });
  const pay = run(reducer, state, 'SPENDING_REFILL', '2030-07-01');
  assert.equal(pay.liquidityPools.float.high, 400_000, 'carried, not raised');

  const { reducer: r2, state: s2 } = fixture({ float: 500_000, prior: priorCube() });
  const adv = run(r2, s2, 'US_PERIOD_ADVANCE', '2030-07-01');
  assert.equal(adv.liquidityPools.float.high, 500_000, 'a period advance DOES ratchet it');
});

test('PAY-6: the two evaluations ACCUMULATE the flow record rather than overwriting it', () => {
  // A US paycheck shares 1 January with the US advance, so whichever runs second must not
  // erase the first one's record of what it moved.
  const { reducer, state } = fixture({ float: 0, periodFlow: { priority: 1 }, prior: priorCube() });
  const afterAdvance = run(reducer, state, 'US_PERIOD_ADVANCE');
  assert.equal(afterAdvance.liquidityPools.float.inflow, 120_000);
  assert.equal(afterAdvance.liquidityPools.float.firedFlows.length, 1);

  // Feed the advance's cube back in, as the sim would, then fire the paycheck.
  // The reducer decides; POOL_FLOW_APPLY moves the money. The account balance in `state` is
  // therefore still 0, so the paycheck sees the same shortfall and fires its own edge — which
  // is what makes this a real test of accumulation rather than of one evaluation.
  const afterPaycheck = run(reducer, { ...state, liquidityPools: afterAdvance.liquidityPools }, 'SPENDING_REFILL');
  assert.equal(afterPaycheck.liquidityPools.float.inflow, 240_000,
    'the advance\'s 120k inflow is ADDED to, not replaced by, the paycheck\'s');
  assert.deepEqual(afterPaycheck.liquidityPools.float.firedFlows.map(f => f.id), ['period', 'paycheck'],
    'both records survive, in the order they happened');
});

// ─── the handler ─────────────────────────────────────────────────────────────────

test('PAY-7: the handler emits SPENDING_REFILL carrying its own date, and no amount', () => {
  const h = new SpendingRefillHandler();
  const [a] = h.call({ date: new Date('2031-07-01') });
  assert.equal(a.type, 'SPENDING_REFILL');
  assert.equal(a.date, '2031-07-01T00:00:00.000Z',
    'a quarterly paycheck fires three times inside one tax period; without its own date all '
    + 'three would be stamped at the period start');
  assert.equal(a.amount, undefined, 'the pool target decides the amount, not the event');
});

test('PAY-8: the event and the action are named differently, on purpose', () => {
  // Sharing one name makes the design-71 payload scan read an EventSeries\' scheduling
  // fields (interval/month/order) as undeclared fields of the action.
  // The static value is only the direct-wiring fallback; `handledEvents` (which the strategy
  // always populates, one per calendar) is what `_wireHandler` actually prefers.
  assert.equal(SpendingRefillHandler.eventType, 'PAYCHECK_US');
  assert.equal(new SpendingRefillHandler().generatedActionTypes[0], 'SPENDING_REFILL');
});

test('PAY-9: PAYCHECK is a valid authored cadence, and an unknown one still throws', () => {
  const build = cadence => normalizeLiquidityGraph({
    pools: [
      { id: 'float',  spendOrder: 0,  claims: [{ key: 'usSavingsAccount' }], target: { mode: 'AMOUNT', value: 1 } },
      { id: 'growth', spendOrder: 20, claims: [{ key: 'usStockAccount', sleeves: ['EQUITY'] }] },
    ],
    flows: [{ id: 'f', from: 'growth', to: 'float', cadence, amount: { toTarget: true } }],
  }, ACCOUNTS);

  assert.equal(build('PAYCHECK').flows[0].cadence, 'PAYCHECK');
  assert.throws(() => build('FORTNIGHTLY'), /unknown cadence 'FORTNIGHTLY'/);
});

// ─── §15.3 — the calendar and the target follow residency ────────────────────────

test('PAY-10: a `whenResident` target is its full size at home and ZERO abroad', () => {
  const pool = normalizeLiquidityGraph({
    pools: [
      { id: 'float', spendOrder: 0, claims: [{ key: 'usSavingsAccount' }],
        target: { mode: 'YEARS_OF_SPEND', value: 1, whenResident: 'AU' } },
      { id: 'growth', spendOrder: 20, claims: [{ key: 'usStockAccount', sleeves: ['EQUITY'] }] },
    ],
    flows: [],
  }, ACCOUNTS).pools[0];

  const state = ccy => ({
    usSavingsAccount: new CheckingAccount(0, { country: 'US', currency: USD }),
    monthlyExpenses: 10_000, effectiveExchangeRates: { USD_AUD: 1 },
    people: { p1: { residency: ccy, birthDate: new Date(Date.UTC(1975, 0, 1)) } },
  });

  const au = state('AU');
  const us = state('US');
  assert.equal(poolMetrics(au, pool, poolContext(au)).target, 120_000, 'a year, at home');
  assert.equal(poolMetrics(us, pool, poolContext(us)).target, 0,
    'ZERO abroad — not null. Null means "sizes nothing" and would leave the sweep with no '
    + 'demand to read; 0 is a real instruction to hold nothing here.');
});

test('PAY-11: residency is read LIVE, so the same pool re-sizes itself across a move', () => {
  const pool = normalizeLiquidityGraph({
    pools: [
      { id: 'float', spendOrder: 0, claims: [{ key: 'usSavingsAccount' }],
        target: { mode: 'YEARS_OF_SPEND', value: 1, whenResident: 'AU' } },
      { id: 'growth', spendOrder: 20, claims: [{ key: 'usStockAccount', sleeves: ['EQUITY'] }] },
    ],
    flows: [],
  }, ACCOUNTS).pools[0];

  const state = {
    usSavingsAccount: new CheckingAccount(0, { country: 'US', currency: USD }),
    monthlyExpenses: 10_000, effectiveExchangeRates: { USD_AUD: 1 },
    people: { p1: { residency: 'US', birthDate: new Date(Date.UTC(1975, 0, 1)) } },
  };
  assert.equal(poolMetrics(state, pool, poolContext(state)).target, 0);
  state.people.p1.residency = 'AU';                        // the move
  assert.equal(poolMetrics(state, pool, poolContext(state)).target, 120_000,
    'no rebuild, no reload — the target is derived from live state every evaluation');
});

test('PAY-12: `whenResident` rejects anything that is not a country code', () => {
  const build = whenResident => normalizeLiquidityGraph({
    pools: [
      { id: 'float', spendOrder: 0, claims: [{ key: 'usSavingsAccount' }],
        target: { mode: 'AMOUNT', value: 1, whenResident } },
      { id: 'growth', spendOrder: 20, claims: [{ key: 'usStockAccount', sleeves: ['EQUITY'] }] },
    ],
    flows: [],
  }, ACCOUNTS);
  assert.equal(build('au').pools[0].target.whenResident, 'AU', 'case is normalised');
  assert.throws(() => build('NZ'), /whenResident must be a country code/);
});

test('PAY-13: the handler answers only its OWN calendar\'s residency', () => {
  const at = (country, residency) =>
    new SpendingRefillHandler({ country }).call({
      date: new Date('2031-07-01'), state: { people: { p1: { residency } } },
    });

  assert.equal(at('AU', 'AU').length, 1, 'the AU paycheck fires once the household is AU-resident');
  assert.equal(at('AU', 'US').length, 0, 'and is silent before the move');
  assert.equal(at('US', 'US').length, 1);
  assert.equal(at('US', 'AU').length, 0, 'the US paycheck stops at the move — no double funding');
});
