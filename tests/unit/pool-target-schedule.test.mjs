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
 * pool-target-schedule.test.mjs
 *
 * DESIGN 112 phase 1 — dated pool targets become steps in design 109's step function, and the
 * shape reducer restamps on a step, not only on a shape.
 *
 * DPT-1   No rows ⇒ the resolved schedule is exactly what it was (null, or the same entries)
 * DPT-2   A row scales the named pool from its 1 January, with or without a shape schedule
 * DPT-3   The latest row per pool wins, relative to AUTHORED; rows for different pools compose
 * DPT-4   Axis × row
 * DPT-5   A PERCENT factor past 1.0 is refused with the normalizer's sentence, naming the row
 * DPT-6   The reducer restamps a same-shape step, and stamps / clears liquidityTargetScales
 * DPT-9   A row carries across a shape switch, sleeps while its pool is absent, and wakes
 * DPT-15  Through a real load: absent with no rows, stamped with them
 * DPT-V   Row validation
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import { resolveLiquidityGraphSchedule } from '../../src/finance/pools/liquidity-graph.js';
import { PoolShapeScheduleReducer, liquidityStateAt } from '../../src/finance/pools/pool-shape-schedule-reducer.js';
import {
  normalizeTargetSchedule, scalesInForceAt, appliedScales, stepKeyOf, composeScales,
} from '../../src/finance/pools/pool-target-schedule.js';
import { diffStates } from '../../src/simulation-framework/state-utils.js';
import { ACCOUNT_TYPE } from '../../src/finance/assets/account.js';

const ACCOUNTS = [
  { stateKey: 'usSavingsAccount', type: ACCOUNT_TYPE.SAVINGS },
  { stateKey: 'usStockAccount',   type: ACCOUNT_TYPE.BROKERAGE },
];

const yrs = (value) => ({ mode: 'YEARS_OF_SPEND', value });

const BASE = {
  pools: [
    { id: 'cash',   spendOrder: 10, target: yrs(2), claims: [{ key: 'usSavingsAccount' }] },
    { id: 'bonds',  spendOrder: 20, target: yrs(3), claims: [{ key: 'usStockAccount', sleeves: ['BOND'] }] },
    { id: 'growth', spendOrder: 40, claims: [{ key: 'usStockAccount', sleeves: ['EQUITY', 'GOLD', 'CASH'] }] },
  ],
};
const BRIDGE = {
  pools: [
    { id: 'cash',   spendOrder: 10, target: yrs(2), claims: [{ key: 'usSavingsAccount' }] },
    { id: 'bonds',  spendOrder: 20, target: yrs(5), claims: [{ key: 'usStockAccount', sleeves: ['BOND'] }] },
    { id: 'growth', spendOrder: 40, claims: [{ key: 'usStockAccount', sleeves: ['EQUITY', 'GOLD', 'CASH'] }] },
  ],
};
/** No `bonds` — its sleeve folds into growth. */
const LATE = {
  pools: [
    { id: 'cash',   spendOrder: 10, target: yrs(1), claims: [{ key: 'usSavingsAccount' }] },
    { id: 'growth', spendOrder: 40, claims: [{ key: 'usStockAccount', sleeves: ['EQUITY', 'GOLD', 'CASH', 'BOND'] }] },
  ],
};

const paramsOf = (over = {}) => ({ liquidityGraph: BASE, ...over });
const JAN = (y) => Date.UTC(y, 0, 1);
const targetOf = (entry, id) => entry.graph.pools.find(p => p.id === id)?.target?.value;

function quietly(fn) {
  const seen = [];
  const real = console.warn;
  console.warn = (...a) => seen.push(a.join(' '));
  try { return { result: fn(), warnings: seen }; } finally { console.warn = real; }
}

// ─── DPT-1 ───────────────────────────────────────────────────────────────────

test('DPT-1: no target rows ⇒ still null without a shape schedule; empty rows are no rows', () => {
  assert.equal(resolveLiquidityGraphSchedule(paramsOf(), ACCOUNTS), null);
  assert.equal(resolveLiquidityGraphSchedule(paramsOf({ liquidityTargetSchedule: [] }), ACCOUNTS), null);
  assert.equal(resolveLiquidityGraphSchedule(paramsOf({ liquidityTargetSchedule: null }), ACCOUNTS), null);
});

test('DPT-1b: with a shape schedule and no rows, every step key is the bare shape id', () => {
  const sched = resolveLiquidityGraphSchedule(paramsOf({
    liquidityShapes: { bridge: BRIDGE }, liquidityGraphSchedule: [{ year: 2035, shape: 'bridge' }],
  }), ACCOUNTS);
  assert.deepEqual(sched.map(e => e.stepKey), ['', 'bridge']);
  assert.deepEqual(sched.map(e => e.scales), [{}, {}]);
  // The key the reducer derives from an unrowed state is the same bare id, so a plan without
  // rows compares exactly as it did before design 112.
  assert.equal(stepKeyOf('bridge', undefined), 'bridge');
  assert.equal(stepKeyOf(null, null), '');
});

test('DPT-1c: a row of 1.0 changes nothing and reuses the unscaled graph object', () => {
  const sched = resolveLiquidityGraphSchedule(paramsOf({
    liquidityTargetSchedule: [{ year: 2030, pool: 'bonds', scale: 1 }],
  }), ACCOUNTS);
  assert.equal(sched.length, 2);
  assert.deepEqual(sched[1].scales, {}, 'identity is not a factor in force');
  assert.equal(sched[1].stepKey, sched[0].stepKey);
  assert.equal(sched[1].graph, sched[0].graph, 'the same object — no re-normalization');
});

// ─── DPT-2 ───────────────────────────────────────────────────────────────────

test('DPT-2: a row alone makes a schedule, scaling the pool from its 1 January', () => {
  const sched = resolveLiquidityGraphSchedule(paramsOf({
    liquidityTargetSchedule: [{ year: 2030, pool: 'bonds', scale: 1.5 }],
  }), ACCOUNTS);
  assert.equal(sched.length, 2);
  assert.deepEqual(sched.map(e => e.shapeId), [null, null], 'the shape never changes');
  assert.equal(sched[1].fromMs, JAN(2030));
  assert.equal(targetOf(sched[0], 'bonds'), 3, 'authored before the row');
  assert.equal(targetOf(sched[1], 'bonds'), 4.5, '1.5 × authored from 2030');
  assert.equal(targetOf(sched[1], 'cash'), 2, 'other pools untouched');
  assert.deepEqual(sched[1].scales, { bonds: 1.5 });
  assert.equal(sched[1].stepKey, '|bonds=1.5');
});

test('DPT-2b: the authored param object is never written to', () => {
  const p = paramsOf({ liquidityTargetSchedule: [{ year: 2030, pool: 'bonds', scale: 1.5 }] });
  const before = JSON.stringify(p);
  resolveLiquidityGraphSchedule(p, ACCOUNTS);
  assert.equal(JSON.stringify(p), before);
});

// ─── DPT-3 ───────────────────────────────────────────────────────────────────

test('DPT-3: the latest row wins, and is relative to AUTHORED, not to the previous row', () => {
  const sched = resolveLiquidityGraphSchedule(paramsOf({
    liquidityTargetSchedule: [
      { year: 2040, pool: 'bonds', scale: 1.2 },          // out of order on purpose
      { year: 2030, pool: 'bonds', scale: 1.5 },
    ],
  }), ACCOUNTS);
  assert.deepEqual(sched.map(e => e.year), [null, 2030, 2040]);
  assert.equal(targetOf(sched[1], 'bonds'), 4.5);
  assert.equal(targetOf(sched[2], 'bonds'), 3.6, '1.2 × 3, not 1.2 × 1.5 × 3');
});

test('DPT-3b: rows for different pools compose; each keeps its own factor', () => {
  const sched = resolveLiquidityGraphSchedule(paramsOf({
    liquidityTargetSchedule: [
      { year: 2030, pool: 'bonds', scale: 1.5 },
      { year: 2032, pool: 'cash',  scale: 0.5 },
    ],
  }), ACCOUNTS);
  assert.deepEqual(sched.map(e => e.scales), [{}, { bonds: 1.5 }, { bonds: 1.5, cash: 0.5 }]);
  assert.equal(targetOf(sched[2], 'bonds'), 4.5);
  assert.equal(targetOf(sched[2], 'cash'), 1);
});

test('DPT-3c: two rows in one year for different pools are one step', () => {
  const sched = resolveLiquidityGraphSchedule(paramsOf({
    liquidityTargetSchedule: [
      { year: 2030, pool: 'bonds', scale: 1.5 },
      { year: 2030, pool: 'cash',  scale: 2 },
    ],
  }), ACCOUNTS);
  assert.equal(sched.length, 2);
  assert.deepEqual(sched[1].scales, { bonds: 1.5, cash: 2 });
});

// ─── DPT-4 ───────────────────────────────────────────────────────────────────

test('DPT-4: the hidden axis multiplies the row (axis × row)', () => {
  const sched = resolveLiquidityGraphSchedule(paramsOf({
    'pool.bonds.targetScale': 2,
    liquidityTargetSchedule: [{ year: 2030, pool: 'bonds', scale: 1.5 }],
  }), ACCOUNTS);
  assert.equal(targetOf(sched[0], 'bonds'), 6, 'the axis alone before the row');
  assert.equal(targetOf(sched[1], 'bonds'), 9, '2 × 1.5 × 3');
  // The stamped factor is the ROW's: the axis is constant for the run and is not a step.
  assert.deepEqual(sched[1].scales, { bonds: 1.5 });
});

test('DPT-4b: composeScales returns the axis map itself when there are no row factors', () => {
  const axis = new Map([['bonds', 2]]);
  assert.equal(composeScales(axis, {}), axis);
  assert.equal(composeScales(axis, null), axis);
  assert.deepEqual([...composeScales(axis, { bonds: 1.5, cash: 0.5 })], [['bonds', 3], ['cash', 0.5]]);
});

// ─── DPT-5 ───────────────────────────────────────────────────────────────────

test('DPT-5: a PERCENT factor past 1.0 is refused at resolve, naming the row and the graph', () => {
  const pct = {
    pools: [
      { id: 'cash',   spendOrder: 10, target: { mode: 'PERCENT', value: 0.6 }, claims: [{ key: 'usSavingsAccount' }] },
      { id: 'growth', spendOrder: 40, claims: [{ key: 'usStockAccount', sleeves: ['EQUITY', 'GOLD', 'CASH', 'BOND'] }] },
    ],
  };
  assert.throws(() => resolveLiquidityGraphSchedule({
    liquidityGraph: pct, liquidityTargetSchedule: [{ year: 2045, pool: 'cash', scale: 2 }],
  }, ACCOUNTS), /liquidityTargetSchedule \(from 2045, the base graph\):.*FRACTION/s);
  // Inside the ceiling it resolves.
  const ok = resolveLiquidityGraphSchedule({
    liquidityGraph: pct, liquidityTargetSchedule: [{ year: 2045, pool: 'cash', scale: 1.5 }],
  }, ACCOUNTS);
  assert.equal(targetOf(ok[1], 'cash'), 0.9);
});

// ─── DPT-9 ───────────────────────────────────────────────────────────────────

test('DPT-9: a row carries across a later shape switch into the new shape', () => {
  const sched = resolveLiquidityGraphSchedule(paramsOf({
    liquidityShapes: { bridge: BRIDGE },
    liquidityGraphSchedule: [{ year: 2035, shape: 'bridge' }],
    liquidityTargetSchedule: [{ year: 2030, pool: 'bonds', scale: 1.5 }],
  }), ACCOUNTS);
  assert.deepEqual(sched.map(e => [e.year, e.shapeId]), [[null, null], [2030, null], [2035, 'bridge']]);
  assert.equal(targetOf(sched[1], 'bonds'), 4.5);
  assert.equal(targetOf(sched[2], 'bonds'), 7.5, '1.5 × the BRIDGE\'s 5 — the row did not end at the switch');
  assert.equal(sched[2].stepKey, 'bridge|bonds=1.5');
});

test('DPT-9b: a row sleeps while its pool is absent and applies again when the pool returns', () => {
  const { result: sched } = quietly(() => resolveLiquidityGraphSchedule(paramsOf({
    liquidityShapes: { late: LATE, bridge: BRIDGE },
    liquidityGraphSchedule: [{ year: 2035, shape: 'late' }, { year: 2040, shape: 'bridge' }],
    liquidityTargetSchedule: [{ year: 2030, pool: 'bonds', scale: 1.5 }],
  }), ACCOUNTS));
  const late = sched.find(e => e.year === 2035);
  assert.deepEqual(late.scales, {}, 'nothing applies to a shape without the pool');
  assert.equal(late.stepKey, 'late');
  const bridge = sched.find(e => e.year === 2040);
  assert.deepEqual(bridge.scales, { bonds: 1.5 });
  assert.equal(targetOf(bridge, 'bonds'), 7.5);
});

test('DPT-9c: a row dated inside a shape that lacks the pool waits for the pool', () => {
  const { result: sched } = quietly(() => resolveLiquidityGraphSchedule(paramsOf({
    liquidityShapes: { late: LATE, bridge: BRIDGE },
    liquidityGraphSchedule: [{ year: 2035, shape: 'late' }, { year: 2040, shape: 'bridge' }],
    liquidityTargetSchedule: [{ year: 2037, pool: 'bonds', scale: 2 }],
  }), ACCOUNTS));
  const at2037 = sched.find(e => e.year === 2037);
  assert.equal(at2037.shapeId, 'late', 'the step repeats the shape in force');
  assert.deepEqual(at2037.scales, {});
  assert.equal(targetOf(sched.find(e => e.year === 2040), 'bonds'), 10);
});

// ─── DPT-6 ───────────────────────────────────────────────────────────────────

const advance = (reducer, state, ms, type = 'US_PERIOD_ADVANCE') => {
  const { next, ...after } = reducer.reduce(state, { type, date: new Date(ms) }, new Date(ms));
  return after;
};

const ROWED = () => resolveLiquidityGraphSchedule(paramsOf({
  liquidityTargetSchedule: [
    { year: 2030, pool: 'bonds', scale: 1.5 },
    { year: 2040, pool: 'bonds', scale: 1 },
  ],
}), ACCOUNTS);

test('DPT-6: a same-shape step restamps the graph and stamps the factors in force', () => {
  const r = new PoolShapeScheduleReducer({ schedule: ROWED() });
  const before = {};
  const quiet = advance(r, before, JAN(2029));
  assert.deepEqual(diffStates(before, quiet), [], 'before the row nothing is written');
  assert.equal('liquidityTargetScales' in quiet, false);

  const stepped = advance(r, quiet, JAN(2030));
  assert.equal(stepped.liquidityShapeId, null, 'the shape is unchanged');
  assert.deepEqual(stepped.liquidityTargetScales, { bonds: 1.5 });
  assert.equal(stepped.liquidityGraph.pools.find(p => p.id === 'bonds').target.value, 4.5);

  const again = advance(r, stepped, Date.UTC(2030, 6, 1), 'AU_PERIOD_ADVANCE');
  assert.deepEqual(diffStates(stepped, again), [], 'a second advance in the step is silent');
});

test('DPT-6b: a row back to 1.0 clears the stamp to null and restores the authored graph', () => {
  const r = new PoolShapeScheduleReducer({ schedule: ROWED() });
  const s30 = advance(r, {}, JAN(2030));
  const s40 = advance(r, s30, JAN(2040));
  assert.equal(s40.liquidityTargetScales, null);
  assert.equal(s40.liquidityGraph.pools.find(p => p.id === 'bonds').target.value, 3);
  const diff = diffStates(s30, s40).map(d => d.field);
  assert.ok(diff.includes('liquidityTargetScales'), 'the lapse is a readable journal line');
});

test('DPT-6c: liquidityStateAt answers the step too — a rollout seeded mid-row sees it', () => {
  const schedule = ROWED();
  const snap = { currentPeriods: { US: { startMs: JAN(2031) } } };
  const patch = liquidityStateAt({ graph: schedule[0].graph, schedule }, snap, JAN(2031));
  assert.deepEqual(patch.liquidityTargetScales, { bonds: 1.5 });
  assert.equal(patch.liquidityGraph.pools.find(p => p.id === 'bonds').target.value, 4.5);
  // Before any row: no stamp at all, not a null.
  const early = liquidityStateAt({ graph: schedule[0].graph, schedule },
    { currentPeriods: { US: { startMs: JAN(2027) } } }, JAN(2027));
  assert.equal('liquidityTargetScales' in early, false);
});

// ─── DPT-V ───────────────────────────────────────────────────────────────────

test('DPT-V: malformed rows are refused with the row index', () => {
  const known = new Set(['cash', 'bonds']);
  assert.throws(() => normalizeTargetSchedule({}, known), /has to be an array/);
  assert.throws(() => normalizeTargetSchedule([null], known), /\[0\] is not a/);
  assert.throws(() => normalizeTargetSchedule([{ year: 2030.5, pool: 'cash', scale: 1 }], known), /not a whole year/);
  assert.throws(() => normalizeTargetSchedule([{ year: 2030, scale: 1 }], known), /names no pool/);
  assert.throws(() => normalizeTargetSchedule([{ year: 2030, pool: 'cahs', scale: 1 }], known),
    /names pool 'cahs', which is in no graph \('cash', 'bonds'\)/);
  assert.throws(() => normalizeTargetSchedule([{ year: 2030, pool: 'cash', scale: -1 }], known), /factor ≥ 0/);
  assert.throws(() => normalizeTargetSchedule([{ year: 2030, pool: 'cash', scale: '1.5' }], known), /factor ≥ 0/);
  assert.throws(() => normalizeTargetSchedule([
    { year: 2030, pool: 'cash', scale: 1 }, { year: 2030, pool: 'cash', scale: 2 },
  ], known), /two rows for pool 'cash' in 2030/);
});

test('DPT-V2: a pool only a SHAPE contains is a valid row; `by` is accepted and ignored', () => {
  const sched = resolveLiquidityGraphSchedule({
    liquidityGraph: LATE,
    liquidityShapes: { bridge: BRIDGE },
    liquidityGraphSchedule: [{ year: 2040, shape: 'bridge' }],
    liquidityTargetSchedule: [{ year: 2030, pool: 'bonds', scale: 2, by: 'mpc-session-1' }],
  }, ACCOUNTS);
  assert.equal(targetOf(sched.at(-1), 'bonds'), 10);
  assert.deepEqual(normalizeTargetSchedule([{ year: 2030, pool: 'bonds', scale: 2, by: 'x' }], new Set(['bonds'])),
    [{ year: 2030, pool: 'bonds', scale: 2 }], '`by` never reaches the resolver');
});

test('DPT-V3: the helpers — scalesInForceAt and appliedScales', () => {
  const rows = normalizeTargetSchedule([
    { year: 2030, pool: 'bonds', scale: 1.5 }, { year: 2035, pool: 'cash', scale: 1 },
  ], new Set(['cash', 'bonds']));
  assert.deepEqual([...scalesInForceAt(rows, 2029)], []);
  assert.deepEqual([...scalesInForceAt(rows, null)], []);
  assert.deepEqual([...scalesInForceAt(rows, 2036)], [['bonds', 1.5], ['cash', 1]]);
  assert.deepEqual(appliedScales(scalesInForceAt(rows, 2036), BASE), { bonds: 1.5 }, 'identity dropped');
  assert.deepEqual(appliedScales(scalesInForceAt(rows, 2036), LATE), {}, 'absent pool dropped');
  assert.deepEqual(appliedScales(scalesInForceAt(rows, 2036), null), {});
});

test('DPT-V4: liquidityGraphEnabled:false makes the rows inert like everything else', () => {
  assert.equal(resolveLiquidityGraphSchedule(paramsOf({
    liquidityGraphEnabled: false,
    liquidityTargetSchedule: [{ year: 2030, pool: 'bonds', scale: 1.5 }],
  }), ACCOUNTS), null);
});

// ─── DPT-15 — through a real scenario load ───────────────────────────────────

import { loadScenarioSim } from '../helpers/scenario-harness.js';

const LIVE = {
  pools: [
    { id: 'cash',   spendOrder: 10, claims: [{ key: 'usSavingsAccount' }] },
    { id: 'bonds',  spendOrder: 20, target: yrs(3), claims: [{ key: 'usStockAccount', sleeves: ['BOND'] }] },
    { id: 'growth', spendOrder: 40, claims: [{ key: 'usStockAccount', sleeves: ['EQUITY', 'GOLD', 'CASH'] }] },
  ],
};
const reducerTypes = (sim) => [...sim.reducers.map.values()].flat().map(e => e.reducer?.constructor?.type);

test('DPT-15: no rows ⇒ no shape reducer and no liquidityTargetScales in state', () => {
  const { sim } = loadScenarioSim({
    params: { behavioralStrategies: ['LIQUIDITY_POOLS'], liquidityGraph: LIVE },
    simStart: '2026-01-01', simEnd: '2029-01-01', stepTo: '2028-06-01',
  });
  assert.ok(!reducerTypes(sim).includes('PoolShapeScheduleReducer'));
  assert.equal('liquidityTargetScales' in sim.state, false);
});

test('DPT-15b: a row reaches the sim (it is forwarded), registers the reducer and is stamped', () => {
  const { sim } = loadScenarioSim({
    params: {
      behavioralStrategies: ['LIQUIDITY_POOLS'], liquidityGraph: LIVE,
      liquidityTargetSchedule: [{ year: 2028, pool: 'bonds', scale: 1.5 }],
    },
    simStart: '2026-01-01', simEnd: '2029-06-01', stepTo: '2028-06-01',
  });
  assert.ok(reducerTypes(sim).includes('PoolShapeScheduleReducer'));
  assert.deepEqual(sim.state.liquidityTargetScales, { bonds: 1.5 });
  assert.equal(sim.state.liquidityGraph.pools.find(p => p.id === 'bonds').target.value, 4.5);
});

// ═════════════════════════════════════════════════════════════════════════════
// Phase 2 — the formatter (DPT-14), the display collapse (DPT-17), the §2.5 hygiene rows
// (DPT-11/12) and the authoring-path report.
// ═════════════════════════════════════════════════════════════════════════════

import { describeScaledTarget } from '../../src/finance/pools/pool-target-scale.js';
import { collapseTargetRuns } from '../../src/finance/pools/pool-target-schedule.js';
import { poolAxisProblems, targetVocabularyProblems, POOL_AXIS_PROBLEM_KIND }
  from '../../src/finance/pools/pool-axis-hygiene.js';
import { collectAuthoredGraphProblems, blockingProblems } from '../../src/finance/pools/liquidity-graph.js';

test('DPT-14: size first, then the factor — one graph, several graphs, and every mode', () => {
  assert.equal(describeScaledTarget({ liquidityGraph: BASE }, 'cash', 1.5), 'cash 3y (×1.5)');
  assert.equal(describeScaledTarget({ liquidityGraph: BASE, liquidityShapes: { bridge: BRIDGE } }, 'bonds', 1.5),
    'bonds base 4.5y / bridge 7.5y (×1.5)');
  const modes = { pools: [
    { id: 'p', target: { mode: 'PERCENT', value: 0.2 } },
    { id: 'a', target: { mode: 'AMOUNT', value: 40000 } },
    { id: 'n' },
  ] };
  assert.equal(describeScaledTarget({ liquidityGraph: modes }, 'p', 1.5), 'p 30% (×1.5)');
  assert.equal(describeScaledTarget({ liquidityGraph: modes }, 'a', 1.25), 'a $50,000 (×1.25)');
  assert.equal(describeScaledTarget({ liquidityGraph: modes }, 'n', 2), 'n no target (×2)');
  assert.equal(describeScaledTarget({ liquidityGraph: modes }, 'gone', 2), 'gone (not in any graph) (×2)');
});

test('DPT-14b: a REMAINDER pool shows its residual, which moves by more than the factor', () => {
  const g = { pools: [
    { id: 'cash', target: yrs(4) },
    { id: 'bonds', target: { mode: 'YEARS_OF_SPEND_REMAINDER', value: 6, after: ['cash'] } },
  ] };
  assert.equal(describeScaledTarget({ liquidityGraph: g }, 'bonds', 1), 'bonds 2y left of 6y (×1)');
  assert.equal(describeScaledTarget({ liquidityGraph: g }, 'bonds', 1.5), 'bonds 5y left of 9y (×1.5)');
  // A pool it sits behind with no static years figure ⇒ the aggregate, labelled so.
  const h = { pools: [
    { id: 'offset', capacity: { mode: 'OFFSET_CAP' } },
    { id: 'bonds', target: { mode: 'YEARS_OF_SPEND_REMAINDER', value: 6, after: ['offset'] } },
  ] };
  assert.equal(describeScaledTarget({ liquidityGraph: h }, 'bonds', 1.5), 'bonds 9y aggregate (×1.5)');
});

test('DPT-17: equal consecutive rows collapse into runs; display only, never throws', () => {
  const runs = collapseTargetRuns([
    { year: 2031, pool: 'cash', scale: 1.5, by: 'mpc-1' },
    { year: 2032, pool: 'cash', scale: 1.5, by: 'mpc-1' },
    { year: 2033, pool: 'cash', scale: 1.25, by: 'mpc-1' },
    { year: 2030, pool: 'bonds', scale: 2 },
    { year: 2034, pool: 'cash', scale: 1.25 },
    { year: 'x', pool: 'cash', scale: 1 },          // unreadable rows are skipped
    null,
  ]);
  assert.deepEqual(runs, [
    { pool: 'bonds', scale: 2,    fromYear: 2030, lastYear: 2030, count: 1, by: [] },
    { pool: 'cash',  scale: 1.5,  fromYear: 2031, lastYear: 2032, count: 2, by: ['mpc-1'] },
    { pool: 'cash',  scale: 1.25, fromYear: 2033, lastYear: 2034, count: 2, by: ['mpc-1'] },
  ]);
  assert.deepEqual(collapseTargetRuns(null), []);
});

const kinds = (rows) => rows.map(r => `${r.kind}:${r.pool}`);

test('DPT-11: a REMAINDER pool and a pool in front of one are both reported CONFOUNDED', () => {
  const g = { pools: [
    { id: 'cash',  target: yrs(2), claims: [] },
    { id: 'bonds', target: { mode: 'YEARS_OF_SPEND_REMAINDER', value: 6, after: ['cash'] }, claims: [] },
  ] };
  const rows = targetVocabularyProblems({ liquidityGraph: g }, null);
  assert.deepEqual(kinds(rows).sort(), ['confounded:bonds', 'confounded:cash']);
  assert.match(rows.find(r => r.pool === 'cash').message, /shrinks 'bonds' by the same amount/);
  assert.match(rows.find(r => r.pool === 'bonds').message, /AGGREGATE/);
});

test('DPT-11b: a pool with a real ceiling in front of a REMAINDER is not a mix lever', () => {
  const g = { pools: [
    { id: 'cash',  target: yrs(2), capacity: { mode: 'YEARS_OF_SPEND', value: 10 } },
    { id: 'bonds', target: { mode: 'YEARS_OF_SPEND_REMAINDER', value: 6, after: ['cash'] } },
  ] };
  assert.deepEqual(kinds(targetVocabularyProblems({ liquidityGraph: g }, null)), ['confounded:bonds']);
});

test('DPT-12: a static ceiling below the top of the span is a plateau (INERT); OFFSET_CAP says it falls', () => {
  const g = { pools: [
    { id: 'cash',   target: yrs(2), capacity: { mode: 'YEARS_OF_SPEND', value: 3 } },
    { id: 'roomy',  target: yrs(2), capacity: { mode: 'YEARS_OF_SPEND', value: 10 } },
    { id: 'mixed',  target: yrs(2), capacity: { mode: 'AMOUNT', value: 1 } },    // units differ: not comparable
    { id: 'offset', target: { mode: 'AMOUNT', value: 50000 }, capacity: { mode: 'OFFSET_CAP' } },
  ] };
  const rows = targetVocabularyProblems({ liquidityGraph: g }, null);
  assert.deepEqual(kinds(rows), ['inert:cash', 'inert:offset']);
  assert.match(rows[0].message, /factors above 1\.5/);
  assert.match(rows[1].message, /falls as the loan amortises/);
});

test('DPT-12b: a floor above the bottom of the span is reported; a row factor widens the span', () => {
  const g = { pools: [{ id: 'cash', target: { mode: 'AMOUNT', value: 100000 }, floor: { mode: 'AMOUNT', value: 40000 } }] };
  assert.deepEqual(kinds(targetVocabularyProblems({ liquidityGraph: g }, null)), [],
    '0.5 × 100k is still above a 40k floor');
  const rows = targetVocabularyProblems({ liquidityGraph: g }, [{ year: 2030, pool: 'cash', scale: 0.5 }]);
  assert.deepEqual(kinds(rows), ['confounded:cash'], 'a 0.5 row makes the bottom 0.25 × 100k');
  assert.match(rows[0].message, /factors below 0\.4/);
});

test('DPT-12c: the shape is named when the pool is in one, and poolAxisProblems includes the rows', () => {
  const shape = { pools: [{ id: 'cash', target: yrs(2), capacity: { mode: 'YEARS_OF_SPEND', value: 3 } }] };
  const rows = targetVocabularyProblems({ liquidityGraph: null, liquidityShapes: { bridge: shape } }, null);
  assert.equal(rows[0].shape, 'bridge');
  assert.match(rows[0].message, /in shape 'bridge'/);
  const cfg = { parameters: { liquidityShapes: { bridge: shape } } };
  assert.ok(poolAxisProblems(cfg).some(r => r.kind === POOL_AXIS_PROBLEM_KIND.INERT && r.pool === 'cash'));
});

test('R7: a row pushing a PERCENT pool past 1.0 is a REFUSES row against the schedule', () => {
  const g = { pools: [{ id: 'cash', target: { mode: 'PERCENT', value: 0.6 } }] };
  const rows = poolAxisProblems({ parameters: { liquidityGraph: g,
    liquidityTargetSchedule: [{ year: 2030, pool: 'cash', scale: 2 }] } });
  const refuse = rows.find(r => r.kind === POOL_AXIS_PROBLEM_KIND.REFUSES);
  assert.equal(refuse.param, 'liquidityTargetSchedule');
  assert.match(refuse.message, /will not load/);
});

test('authoring: a bad target row is an ERROR against liquidityTargetSchedule, with the load\'s sentence', () => {
  const p = paramsOf({ liquidityTargetSchedule: [{ year: 2030, pool: 'cahs', scale: 2 }] });
  const probs = blockingProblems(collectAuthoredGraphProblems(p, ACCOUNTS));
  assert.equal(probs.length, 1);
  assert.equal(probs[0].param, 'liquidityTargetSchedule');
  assert.match(probs[0].message, /names pool 'cahs'/);
  // A clean schedule reports nothing blocking.
  assert.deepEqual(blockingProblems(collectAuthoredGraphProblems(
    paramsOf({ liquidityTargetSchedule: [{ year: 2030, pool: 'cash', scale: 2 }] }), ACCOUNTS)), []);
});

test('DPT-14c: a solver\'s continuous factor reads at two decimals; equal sizes across shapes read once', () => {
  const same = { liquidityGraph: BASE, liquidityShapes: { late: { pools: [BASE.pools[0]] } } };
  assert.equal(describeScaledTarget(same, 'cash', 1.25493289449), 'cash 2.51y (×1.25)');
  const pct = { liquidityGraph: { pools: [{ id: 'p', target: { mode: 'PERCENT', value: 0.3 } }] } };
  assert.equal(describeScaledTarget(pct, 'p', 1.2346), 'p 37.04% (×1.23)');
});

test('DPT-12d: the same warning in several graphs is ONE row naming each of them', () => {
  const g = { pools: [{ id: 'cash', target: yrs(2), capacity: { mode: 'YEARS_OF_SPEND', value: 3 } }] };
  const rows = targetVocabularyProblems({ liquidityGraph: g, liquidityShapes: { a: g, b: g } }, null);
  assert.equal(rows.length, 1);
  assert.match(rows[0].message, /^Pool 'cash' \(in the base graph, shape 'a', shape 'b'\) has a YEARS_OF_SPEND capacity/);
  // Base graph alone reads exactly as before — no parenthetical.
  assert.match(targetVocabularyProblems({ liquidityGraph: g }, null)[0].message, /^Pool 'cash' has a/);
});

import { buildPoolHistory, poolTargetScaleSteps } from '../../src/finance/pools/pool-history.js';

test('DPT-15c: a real run\'s journal carries the size step to the Pools panel derivation (R11)', () => {
  const { sim } = loadScenarioSim({
    params: {
      behavioralStrategies: ['LIQUIDITY_POOLS', 'TARGET_ALLOCATION'], liquidityGraph: LIVE,
      liquidityTargetSchedule: [{ year: 2028, pool: 'bonds', scale: 1.5 }, { year: 2030, pool: 'bonds', scale: 1 }],
    },
    simStart: '2026-01-01', simEnd: '2031-06-01', stepTo: '2030-06-01',
  });
  const { opening, steps } = poolTargetScaleSteps(buildPoolHistory({ journal: sim.journal }));
  assert.equal(opening, null);
  assert.deepEqual(steps.map(s => [s.at.toISOString().slice(0, 4), s.changes]), [
    ['2028', [{ pool: 'bonds', from: 1, to: 1.5 }]],
    ['2030', [{ pool: 'bonds', from: 1.5, to: 1 }]],
  ]);
});
