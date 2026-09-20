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
 * mpc-lever-pool-gates.test.mjs
 *
 * DESIGN 39 §14.8 — the levers a liquidity graph makes inert.
 *
 * Measured against a real pooled plan: four drawdown levers returned the identical run at every
 * value, to the dollar, and the cockpit advised on all four. Two of them were gated on nothing at
 * all, on the argument that they are inert only under a data condition no gate can see.
 *
 * PLG-1  `poolGraphCompilesSpendOrder` — the predicate, including the master switch, a graph
 *        with no spend order, and an order that arrives in a scheduled SHAPE
 * PLG-2  The predicate is true EXACTLY when the compile happens — asserted against the
 *        compiler, not against a reading of it. This is the test the whole section rests on.
 * PLG-3  The four gates refuse under a compiled order, and pass without one
 * PLG-4  A two-clause gate names the remedy for the clause that actually failed
 * PLG-5  `assertRunIsPlayable` — an INERT lever warns and loads, a DISABLED one still throws
 * PLG-6  `leverHygieneProblems` — ALLOCATION_MIX is reported, and only when every class the
 *        lever searches is claimed
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import {
  LEVER_SCHEDULE, poolGraphCompilesSpendOrder, leverRequirement,
} from '../../src/finance/mpc/lever-schedule.js';
import { leverHygieneProblems, LEVER_PROBLEM_KIND } from '../../src/finance/mpc/lever-hygiene.js';
import { assertRunIsPlayable } from '../../src/finance/mpc/run-compile-fold.js';
import { resolveLiquidityGraph, compileToDrawdownSequence }
  from '../../src/finance/pools/liquidity-graph.js';
import { ACCOUNT_TYPE } from '../../src/finance/assets/account.js';

const ACCOUNTS = [
  { stateKey: 'usSavingsAccount', type: ACCOUNT_TYPE.SAVINGS },
  { stateKey: 'auSavingsAccount', type: ACCOUNT_TYPE.SAVINGS },
  { stateKey: 'usStockAccount',   type: ACCOUNT_TYPE.BROKERAGE },
];

/** A spend graph, shaped like the author's: one pool per sleeve, so every draw is narrowed. */
const SPEND_GRAPH = {
  pools: [
    { id: 'cash',   spendOrder: 10, claims: [{ key: 'usSavingsAccount' },
                                             { key: 'usStockAccount', sleeves: ['CASH'] }] },
    { id: 'buffer', spendOrder: 20, claims: [{ key: 'usStockAccount', sleeves: ['BOND'] }] },
    { id: 'growth', spendOrder: 40, claims: [{ key: 'usStockAccount', sleeves: ['EQUITY'] }] },
    { id: 'gold',   spendOrder: 50, claims: [{ key: 'usStockAccount', sleeves: ['GOLD'] }] },
  ],
};

/** The same pools with no `spendOrder` — a graph that refills but never decides an order. */
const NO_ORDER_GRAPH = {
  pools: SPEND_GRAPH.pools.map(({ spendOrder, ...rest }) => rest),
};

/** The drawdown preconditions satisfied, so only the pool clause can fail a gate. */
const DRAWDOWN_ON = { drawdownStrategy: 'WEIGHTED', drawdownSleeveOrder: 'WEIGHTED' };

/** The four levers §14.8 gates. */
const POOLED_INERT_LEVERS =
  ['DRAWDOWN_WEIGHTS', 'DRAWDOWN_SLEEVE', 'DRAWDOWN_XBORDER', 'DRAWDOWN_WITHINTIER'];

/** Captures `console.warn` for the cases whose whole content is a warning. */
function capturingWarnings(fn) {
  const seen = [];
  const real = console.warn;
  console.warn = (...a) => seen.push(a.join(' '));
  try { fn(); } finally { console.warn = real; }
  return seen;
}

// ─── PLG-1 ───────────────────────────────────────────────────────────────────

test('PLG-1: the predicate — a spend order, the master switch, and a graph without one', () => {
  assert.equal(poolGraphCompilesSpendOrder({ liquidityGraph: SPEND_GRAPH }), true);
  // Absent is ON, matching `resolveLiquidityGraph`'s reading of the same switch.
  assert.equal(poolGraphCompilesSpendOrder(
    { liquidityGraph: SPEND_GRAPH, liquidityGraphEnabled: true }), true);
  assert.equal(poolGraphCompilesSpendOrder(
    { liquidityGraph: SPEND_GRAPH, liquidityGraphEnabled: false }), false);
  // A graph is not enough: pools that refill but never name an order leave the drawdown
  // sequence absent, and then every lever above is live.
  assert.equal(poolGraphCompilesSpendOrder({ liquidityGraph: NO_ORDER_GRAPH }), false);
  assert.equal(poolGraphCompilesSpendOrder({}), false);
  assert.equal(poolGraphCompilesSpendOrder(undefined), false);
});

test('PLG-1b: an order that arrives in a scheduled SHAPE counts', () => {
  // Design 109 — a plan whose order starts in 2043 is pooled for the part of the horizon the
  // levers would be tuned over, so a gate that looked only at the base graph would advise on
  // a lever that dies partway through the run.
  const p = {
    liquidityGraph: NO_ORDER_GRAPH,
    liquidityShapes: { wrapLast: SPEND_GRAPH },
    liquidityGraphSchedule: [{ year: 2043, shape: 'wrapLast' }],
  };
  assert.equal(poolGraphCompilesSpendOrder(p), true);
  assert.equal(poolGraphCompilesSpendOrder({ ...p, liquidityGraphEnabled: false }), false,
    'and the master switch still turns the whole thing off');
});

// ─── PLG-2 ───────────────────────────────────────────────────────────────────

test('PLG-2: the predicate is true exactly when a drawdown sequence compiles', () => {
  // The invariant the gates mean. `lever-schedule.js` may import leaves only, so the predicate
  // re-reads the authored param instead of calling the normalizer — which makes it a SECOND
  // derivation of one fact, and this is the test that keeps the two from drifting.
  const cases = [
    { liquidityGraph: SPEND_GRAPH },
    { liquidityGraph: SPEND_GRAPH, liquidityGraphEnabled: false },
    { liquidityGraph: NO_ORDER_GRAPH },
    {},
  ];
  for (const params of cases) {
    const graph = resolveLiquidityGraph(params, ACCOUNTS);
    const compiles = !!(graph && compileToDrawdownSequence(graph));
    assert.equal(poolGraphCompilesSpendOrder(params), compiles,
      `disagreed about ${JSON.stringify(params).slice(0, 60)}`);
  }
});

// ─── PLG-3 ───────────────────────────────────────────────────────────────────

test('PLG-3: all four drawdown gates refuse under a compiled spend order', () => {
  const pooled = { ...DRAWDOWN_ON, liquidityGraph: SPEND_GRAPH };
  for (const lever of POOLED_INERT_LEVERS) {
    const spec = LEVER_SCHEDULE[lever];
    assert.equal(spec.appliesTo(pooled), false, `${lever} should be refused`);
    assert.equal(spec.inertWhen(pooled), true, `${lever} is INERT, not disabled`);
    assert.match(leverRequirement(spec, pooled), /liquidity graph/i);
  }
});

test('PLG-3b: and every one of them is live again without a compiled order', () => {
  for (const params of [{ ...DRAWDOWN_ON },
                        { ...DRAWDOWN_ON, liquidityGraph: SPEND_GRAPH, liquidityGraphEnabled: false },
                        { ...DRAWDOWN_ON, liquidityGraph: NO_ORDER_GRAPH }]) {
    for (const lever of POOLED_INERT_LEVERS) {
      assert.equal(LEVER_SCHEDULE[lever].appliesTo(params), true,
        `${lever} should apply to ${JSON.stringify(params).slice(0, 50)}`);
      assert.equal(LEVER_SCHEDULE[lever].inertWhen(params), false);
    }
  }
});

// ─── PLG-4 ───────────────────────────────────────────────────────────────────

test('PLG-4: a two-clause gate names the remedy for the clause that failed', () => {
  // Telling an operator to set Drawdown Strategy to WEIGHTED when it already IS weighted and
  // the graph is what makes the lever inert costs a session. Both sentences are reachable.
  const sleeve = LEVER_SCHEDULE.DRAWDOWN_SLEEVE;
  assert.match(leverRequirement(sleeve, { liquidityGraph: SPEND_GRAPH, drawdownSleeveOrder: 'WEIGHTED' }),
    /liquidity graph/i);
  assert.match(leverRequirement(sleeve, { drawdownSleeveOrder: 'FIFO' }),
    /Drawdown Sleeve Order to WEIGHTED/);

  const weights = LEVER_SCHEDULE.DRAWDOWN_WEIGHTS;
  assert.match(leverRequirement(weights, { liquidityGraph: SPEND_GRAPH, drawdownStrategy: 'WEIGHTED' }),
    /liquidity graph/i);
  assert.match(leverRequirement(weights, { drawdownStrategy: 'TAXABLE_FIRST' }),
    /Drawdown Strategy to WEIGHTED/);

  // A plain string gate still reads through the same accessor.
  assert.match(leverRequirement(LEVER_SCHEDULE.SPENDING, {}), /EXPLICIT_BANDS/);
  assert.equal(leverRequirement(undefined, {}), undefined);
});

// ─── PLG-5 ───────────────────────────────────────────────────────────────────

const D = (y) => new Date(Date.UTC(y, 0, 1)).toISOString();

/** A recorded run that decided a sleeve order in 2030. */
const SLEEVE_RUN = {
  mpcRuns: {
    'run:s': {
      source: { recordedAt: '2026-09-20', levers: ['DRAWDOWN_SLEEVE'], epochs: 1 },
      decisions: [{ date: D(2030), lever: 'DRAWDOWN_SLEEVE', key: 'sleeveWeight::EQUITY', value: 0.4 }],
    },
  },
  mpcActiveRun: 'run:s',
};

test('PLG-5: an INERT lever WARNS and the scenario loads', () => {
  // The distinction §14.8 turns on. A disabled mechanic drops the rows and plays a different
  // plan, so it throws. Here every row applies exactly as recorded and changes nothing, so the
  // plan is byte-identical to the base — refusing to load it would be a refusal with no
  // behaviour behind it.
  const params = { ...SLEEVE_RUN, ...DRAWDOWN_ON, liquidityGraph: SPEND_GRAPH };
  const warns = capturingWarnings(() => assertRunIsPlayable(params));
  assert.equal(warns.length, 1);
  assert.match(warns[0], /INERT/);
  assert.match(warns[0], /DRAWDOWN_SLEEVE/);
  assert.match(warns[0], /run:s/);
});

test('PLG-5b: a DISABLED lever still throws, and says nothing about inertness', () => {
  // No graph, and the sleeve order is not WEIGHTED — the gate fails on the mechanic.
  assert.throws(
    () => assertRunIsPlayable({ ...SLEEVE_RUN, drawdownSleeveOrder: 'FIFO' }),
    (e) => /DRAWDOWN_SLEEVE/.test(e.message)
        && /Drawdown Sleeve Order to WEIGHTED/.test(e.message)
        && !/INERT/.test(e.message));
});

test('PLG-5c: a live lever is silent', () => {
  const warns = capturingWarnings(() =>
    assertRunIsPlayable({ ...SLEEVE_RUN, ...DRAWDOWN_ON }));
  assert.deepEqual(warns, []);
});

// ─── PLG-6 ───────────────────────────────────────────────────────────────────

test('PLG-6: ALLOCATION_MIX is REPORTED when pools claim every class it searches', () => {
  const rows = leverHygieneProblems({ liquidityGraph: SPEND_GRAPH }, ['ALLOCATION_MIX'], ACCOUNTS);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].lever, 'ALLOCATION_MIX');
  assert.equal(rows[0].kind, LEVER_PROBLEM_KIND.INERT);
  assert.equal(rows[0].severity, 'warn');
  assert.match(rows[0].message, /every class this lever searches/);

  // And it is a REPORT, not a gate: the lever still applies, so Advise is not disabled.
  assert.equal(LEVER_SCHEDULE.ALLOCATION_MIX.appliesTo({
    liquidityGraph: SPEND_GRAPH, allocationStrategy: 'OPTIMIZED',
    behavioralStrategies: ['TARGET_ALLOCATION'],
  }), true);
});

test('PLG-6b: free ONE class and the report goes quiet — this is why it is not a gate', () => {
  // Measured on a real plan: dropping the CASH claim moved terminal wealth by over a percent.
  // The inertness is a property of the claims, not of pooling.
  const freeCash = {
    pools: SPEND_GRAPH.pools
      .map(p => ({ ...p, claims: p.claims.filter(c => !(c.sleeves ?? []).includes('CASH')) }))
      .filter(p => p.claims.length > 0),
  };
  assert.deepEqual(leverHygieneProblems({ liquidityGraph: freeCash }, ['ALLOCATION_MIX'], ACCOUNTS), []);
  // No graph at all, and a lever nobody asked about.
  assert.deepEqual(leverHygieneProblems({}, ['ALLOCATION_MIX'], ACCOUNTS), []);
  assert.deepEqual(leverHygieneProblems({ liquidityGraph: SPEND_GRAPH }, ['ROTH'], ACCOUNTS), []);
});
