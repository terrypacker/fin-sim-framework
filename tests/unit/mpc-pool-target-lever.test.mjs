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
 * mpc-pool-target-lever.test.mjs
 *
 * DESIGN 112 phase 3 — `POOL_TARGET`, a pool's size as an MPC control. Built on the POOL_SHAPE
 * template: a dated `liquidityTargetSchedule` row the solver can TEST (the rollout sees it) and
 * the cockpit can ACTUATE (the live sim carries it; a Rebuild or a design 81 replay reproduces it).
 *
 * PTL-1  the gate: a sized pool and something running the pools; INERT with no target reader
 * PTL-2  the scaffold carries the factor already in force (the no-op is the plan)
 * PTL-3  one CONTINUOUS variable per pool in the search list, with per-pool bounds (§5.1, DPT-10/13)
 * PTL-4  the fold: `year@Y::pool` rows become schedule rows; junk is dropped
 * PTL-5  a no-op candidate prices EXACTLY the plan (DPT-7)
 * PTL-6  a candidate reaches the rollout at a 1-January epoch
 * PTL-7  the live actuate resizes the running sim, marks `by`, and matches a compile of what it saved
 * PTL-8  lever hygiene carries the §2.5 rows
 * PTL-9  the harvest bakes dated rows (SCHEDULE), not the POINT default's index key
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import { OptimizationProblem }     from '../../src/finance/optimization/optimization-problem.js';
import { OPTIMIZATION_OBJECTIVES, OPT_PARAM_TYPES } from '../../src/finance/optimization/optimization-objectives.js';
import { COCKPIT_CONTROLS }        from '../../src/finance/mpc/cockpit-controller.js';
import { poolTargetKeyParts }      from '../../src/finance/mpc/lever-schedule.js';
import { leverHygieneProblems }    from '../../src/finance/mpc/lever-hygiene.js';
import { ServiceRegistry }         from '../../src/services/service-registry.js';
import { IntlRetirementScenario }  from '../../src/scenarios/intl-retirement-scenario.js';
import { ScenarioLoader }          from '../../src/scenarios/scenario-loader.js';
import { ScenarioSerializer }      from '../../src/scenarios/scenario-serializer.js';
import { applyParamBagToConfig }   from '../../src/scenarios/scenario-param-apply.js';
import { computeNetWorth }         from '../../src/finance/derived-metrics/net-worth.js';

const TARGET = COCKPIT_CONTROLS.POOL_TARGET;

const SIM_START = new Date(Date.UTC(2026, 0, 1));
const SIM_END   = new Date(Date.UTC(2060, 0, 1));
const JAN_1     = new Date(Date.UTC(2045, 0, 1));
const MID_YEAR  = new Date(Date.UTC(2045, 5, 15));

const GRAPH = {
  pools: [
    { id: 'cash',   spendOrder: 10, claims: [{ key: 'usSavingsAccount' }] },
    { id: 'buffer', spendOrder: 20, target: { mode: 'YEARS_OF_SPEND', value: 5 },
      claims: [{ key: 'usStockAccount', sleeves: ['BOND'] }] },
    { id: 'growth', spendOrder: 40, claims: [{ key: 'usStockAccount', sleeves: ['EQUITY'] }] },
    { id: 'wrappers', spendOrder: 60,
      claims: [{ key: 'iraAccount' }, { key: 'k401Account' }, { key: 'superAccount' }] },
  ],
};

const BASE = {
  spendingStrategy:     ['EXPLICIT_BANDS'],
  spendingExpenseBands: [{ startAge: 45, monthlyAmount: 9000 }],
  behavioralStrategies: ['TARGET_ALLOCATION', 'LIQUIDITY_POOLS'],
  liquidityGraph:       GRAPH,
};

const quiet = (fn) => {
  const l = console.log, w = console.warn;
  console.log = () => {}; console.warn = () => {};
  try { return fn(); } finally { console.log = l; console.warn = w; }
};

const problem = (params, initialState) => new OptimizationProblem({
  variables: [], baseParams: params, objective: OPTIMIZATION_OBJECTIVES.MAX_NET_WORTH,
  simStart: SIM_START, simEnd: SIM_END, initialState,
});
const seededFrom = (p) => p._seededSim({ ...p._resolveBase(), endDate: SIM_END });
const snapshotOf = (params, asOf) => quiet(() =>
  problem(params, { kind: 'compile', cfgTemplate: null }).rollToSnapshot({}, asOf));
const seeded = (params, snap) => quiet(() =>
  seededFrom(problem(params, { kind: 'snapshot', snapshot: snap, cfgTemplate: null })));
const terminal = (params, snap) => quiet(() => {
  const sim = seeded(params, snap);
  sim.stepTo(SIM_END);
  return computeNetWorth(sim.state, 'USD');
});
const bufferTarget = (st) => st.liquidityGraph?.pools?.find(p => p.id === 'buffer')?.target?.value;

/** The candidate the cockpit would roll out: every variable set to `k`. */
function candidate(base, asOf, k, range = null) {
  const prepared = TARGET.prepareBaseParams({ baseParams: base, asOf });
  const vars = TARGET.buildVariables({ baseParams: prepared, asOf, range });
  const sched = prepared.liquidityTargetSchedule.map(e => ({ ...e }));
  for (const v of vars) sched.find(e => e.year === v._year && e.pool === v._pool).scale = k;
  return { params: { ...prepared, liquidityTargetSchedule: sched }, vars };
}

// ─── PTL-1 ───────────────────────────────────────────────────────────────────

test('PTL-1: the gate needs a sized pool and something that runs the pools', () => {
  assert.equal(TARGET.appliesTo(BASE), true);
  const unsized = { ...BASE, liquidityGraph: { pools: GRAPH.pools.map(p => ({ ...p, target: undefined })) } };
  assert.equal(TARGET.appliesTo(unsized), false, 'no pool has a target to scale');
  const zero = { ...BASE, liquidityGraph: { pools: GRAPH.pools.map(p =>
    (p.id === 'buffer' ? { ...p, target: { mode: 'YEARS_OF_SPEND', value: 0 } } : p)) } };
  assert.equal(TARGET.appliesTo(zero), false, 'a zero target cannot be scaled (design 110 §13.10)');
  assert.equal(TARGET.appliesTo({ ...BASE, liquidityGraphEnabled: false }), false);
  assert.equal(TARGET.appliesTo({ ...BASE, liquidityGraph: null }), false);
});

test('PTL-1b: with no target reader it is INERT, and the requirement says which remedy', () => {
  const unread = { ...BASE, behavioralStrategies: ['BOND_LADDER'] };
  assert.equal(TARGET.appliesTo(unread), false);
  assert.equal(TARGET.inertWhen(unread), true);
  assert.equal(TARGET.inertWhen(BASE), false);
  assert.match(TARGET.requirement(unread), /TARGET_ALLOCATION or LIQUIDITY_POOLS/);
  assert.match(TARGET.requirement({ ...BASE, liquidityGraph: null }), /non-zero target/);
  // Either reader alone is enough.
  assert.equal(TARGET.appliesTo({ ...BASE, behavioralStrategies: ['LIQUIDITY_POOLS'] }), true);
});

// ─── PTL-2 ───────────────────────────────────────────────────────────────────

test('PTL-2: the scaffold carries the factor already in force; the year follows the epoch', () => {
  const at = (p, y) => p.liquidityTargetSchedule.filter(e => e.year === y);
  assert.deepEqual(at(TARGET.prepareBaseParams({ baseParams: BASE, asOf: JAN_1 }), 2045),
    [{ year: 2045, pool: 'buffer', scale: 1 }], 'only the sized pool; 1 before any row');
  const rowed = { ...BASE, liquidityTargetSchedule: [{ year: 2040, pool: 'buffer', scale: 1.5 }] };
  assert.deepEqual(at(TARGET.prepareBaseParams({ baseParams: rowed, asOf: MID_YEAR }), 2046),
    [{ year: 2046, pool: 'buffer', scale: 1.5 }], 'the 2040 row is in force at 2046');

  const once  = TARGET.prepareBaseParams({ baseParams: rowed, asOf: JAN_1 });
  const twice = TARGET.prepareBaseParams({ baseParams: once, asOf: JAN_1 });
  assert.equal(twice, once, 'idempotent: nothing to add returns the same object');
  assert.deepEqual(rowed.liquidityTargetSchedule, [{ year: 2040, pool: 'buffer', scale: 1.5 }],
    'the caller\'s rows are not mutated');
});

// ─── PTL-3 ───────────────────────────────────────────────────────────────────

test('PTL-3: one CONTINUOUS variable per eligible pool, keyed by year and pool', () => {
  const prepared = TARGET.prepareBaseParams({ baseParams: BASE, asOf: JAN_1 });
  const [v, ...rest] = TARGET.buildVariables({ baseParams: prepared, asOf: JAN_1 });
  assert.equal(rest.length, 0);
  assert.equal(v.paramKey, 'liquidityTargetSchedule[0].scale');
  assert.equal(v.type, OPT_PARAM_TYPES.CONTINUOUS);
  assert.deepEqual([v.min, v.max, v.step], [0.5, 2, 0.25]);
  assert.equal(TARGET.scheduleKey(v), 'year@2045::buffer', 'recorded by year and pool, never by index');
  // §2.3 "Legibility": the size first, then the factor.
  assert.equal(TARGET.describe({ [v.paramKey]: 1.5 }, [v]), 'Hold buffer 7.5y (×1.5) from 2045');
  assert.equal(TARGET.describe({}, []), 'No pool target decision');
});

test('PTL-3b: the search list narrows the variables; absent is all, empty is none (DPT-10)', () => {
  const two = { ...BASE, liquidityGraph: { pools: GRAPH.pools.map(p =>
    (p.id === 'cash' ? { ...p, target: { mode: 'YEARS_OF_SPEND', value: 1 } } : p)) } };
  const prepared = TARGET.prepareBaseParams({ baseParams: two, asOf: JAN_1 });
  const pools = (range) => TARGET.buildVariables({ baseParams: prepared, asOf: JAN_1, range }).map(v => v._pool);
  assert.deepEqual(pools(null), ['buffer', 'cash']);
  assert.deepEqual(pools({ pools: ['cash'] }), ['cash']);
  assert.deepEqual(pools({ pools: [] }), [], 'an empty list means none, not all');
});

test('PTL-3c: per-pool bounds, then the control range, then the default (DPT-13)', () => {
  const prepared = TARGET.prepareBaseParams({ baseParams: BASE, asOf: JAN_1 });
  const one = (range) => TARGET.buildVariables({ baseParams: prepared, asOf: JAN_1, range })[0];
  assert.deepEqual([one({ min: 0.75, max: 1.5 }).min, one({ min: 0.75, max: 1.5 }).max], [0.75, 1.5]);
  const own = one({ min: 0.75, max: 1.5, pools: [{ pool: 'buffer', max: 3 }] });
  assert.deepEqual([own.min, own.max], [0.75, 3], 'the pool\'s own max wins; its min falls back');
});

test('PTL-3d: a named pool with no target in force is skipped, and describe says so', () => {
  const prepared = TARGET.prepareBaseParams({ baseParams: BASE, asOf: JAN_1 });
  const vars = TARGET.buildVariables({ baseParams: prepared, asOf: JAN_1, range: { pools: ['buffer', 'cash'] } });
  assert.deepEqual(vars.map(v => v._pool), ['buffer']);
  assert.match(TARGET.describe({ [vars[0].paramKey]: 1 }, vars), /not decided: cash — no target in force from 2045/);
});

test('PTL-3e: a PERCENT pool is capped where the normalizer would refuse, against the axis', () => {
  const pct = { ...BASE, 'pool.buffer.targetScale': 2, liquidityGraph: { pools: GRAPH.pools.map(p =>
    (p.id === 'buffer' ? { ...p, target: { mode: 'PERCENT', value: 0.3 } } : p)) } };
  const prepared = TARGET.prepareBaseParams({ baseParams: pct, asOf: JAN_1 });
  const [v] = TARGET.buildVariables({ baseParams: prepared, asOf: JAN_1 });
  assert.ok(Math.abs(v.max - 1 / 0.6) < 1e-12, `0.3 × axis 2 = 0.6, so the row caps at 1/0.6, got ${v.max}`);
});

test('PTL-3f: a pool sized only in a shape the plan has already left is not offered', () => {
  const sized = { pools: GRAPH.pools.map(p =>
    (p.id === 'cash' ? { ...p, target: { mode: 'YEARS_OF_SPEND', value: 2 } } : p)) };
  const plan = { ...BASE, liquidityShapes: { early: sized },
    liquidityGraphSchedule: [{ year: 2030, shape: 'early' }, { year: 2040, shape: null }] };
  const prepared = TARGET.prepareBaseParams({ baseParams: plan, asOf: JAN_1 });
  assert.deepEqual(TARGET.buildVariables({ baseParams: prepared, asOf: JAN_1 }).map(v => v._pool), ['buffer'],
    '`cash` is sized only in `early`, which ended in 2040');
  // Scheduled AFTER the decision, it is offered.
  const later = { ...plan, liquidityGraphSchedule: [{ year: 2050, shape: 'early' }] };
  const p2 = TARGET.prepareBaseParams({ baseParams: later, asOf: JAN_1 });
  assert.deepEqual(TARGET.buildVariables({ baseParams: p2, asOf: JAN_1 }).map(v => v._pool), ['buffer', 'cash']);
});

// ─── PTL-4 ───────────────────────────────────────────────────────────────────

test('PTL-4: the fold turns recorded rows into schedule rows; junk is dropped', () => {
  const base = { ...BASE, liquidityTargetSchedule: [{ year: 2040, pool: 'buffer', scale: 1.5, by: 'hand' }] };
  const folded = TARGET.foldAt({ baseParams: base, rows: [
    { key: 'year@2045::buffer', value: 2 },
    { key: 'year@2040::buffer', value: 1.25 },
    { key: 'year@2050::buffer', value: -1 },     // not a factor: dropped
    { key: 'year@2050', value: 2 },              // no pool: dropped
  ] });
  assert.deepEqual(folded, [
    { year: 2040, pool: 'buffer', scale: 1.25, by: 'hand' },
    { year: 2045, pool: 'buffer', scale: 2 },
  ]);
  assert.equal(TARGET.foldAt({ baseParams: base, rows: [] }), null);
  assert.deepEqual(poolTargetKeyParts('year@2045::a::b'), { year: 2045, pool: 'a::b' },
    'a pool id containing the separator is kept whole');
});

// ─── PTL-5 ───────────────────────────────────────────────────────────────────

test('PTL-5: a no-op candidate prices EXACTLY the plan (DPT-7)', () => {
  for (const [name, base, asOf] of [
    ['no rows, 1 Jan', BASE, JAN_1],
    ['a 1.5 row in force, mid-year', { ...BASE, liquidityTargetSchedule: [{ year: 2040, pool: 'buffer', scale: 1.5 }] }, MID_YEAR],
  ]) {
    const snap = snapshotOf(base, asOf);
    const prepared = TARGET.prepareBaseParams({ baseParams: base, asOf });
    assert.equal(terminal(prepared, snap), terminal(base, snap), `${name}: the no-op moved the rollout`);
  }
});

// ─── PTL-6 ───────────────────────────────────────────────────────────────────

test('PTL-6: at a 1-January epoch the candidate reaches the rollout on the spot', () => {
  const snap = snapshotOf(BASE, JAN_1);
  const { params } = candidate(BASE, JAN_1, 1.5);
  const st = seeded(params, snap).state;
  assert.equal(bufferTarget(st), 7.5);
  assert.deepEqual(st.liquidityTargetScales, { buffer: 1.5 });
  assert.notEqual(terminal(params, snap), terminal(BASE, snap), 'and the rollout prices a different plan');
});

// ─── PTL-7 ───────────────────────────────────────────────────────────────────

function liveSim(params) {
  return quiet(() => {
    const registry = new ServiceRegistry();
    const scenario = new IntlRetirementScenario({
      context: registry.simulationContext, params, simStart: SIM_START, simEnd: SIM_END,
    });
    scenario.buildSim({ telemetry: 'off' });
    const cfg = ScenarioSerializer.serializeScenario(
      IntlRetirementScenario.buildDefaultConfig({}, SIM_START, SIM_END));
    // No `liquidityTargetSchedule` entry: the actuate must create the param it saves into.
    cfg.params = [];
    applyParamBagToConfig(cfg, params);
    new ScenarioLoader().load(cfg, registry);
    return { sim: scenario.sim, services: registry, cfg };
  });
}

function compiledAt(params, date) {
  return quiet(() => {
    const sim = seededFrom(problem(params, { kind: 'compile', cfgTemplate: null }));
    sim.stepTo(date);
    return sim.state;
  });
}

test('PTL-7: the live actuate resizes the running sim, marks `by`, and matches a compile of it', () => {
  for (const [name, asOf] of [['1 Jan', JAN_1], ['mid-year', MID_YEAR]]) {
    const { sim, services, cfg } = liveSim(BASE);
    quiet(() => sim.stepTo(asOf));
    const prepared = TARGET.prepareBaseParams({ baseParams: BASE, asOf });
    const vars = TARGET.buildVariables({ baseParams: prepared, asOf });
    const ok = quiet(() => TARGET.actuate({
      services, scenario: cfg, candidate: { [vars[0].paramKey]: 1.5 }, vars, runId: 'run:test' }));
    assert.equal(ok, true, `${name}: actuate reported failure`);

    const saved = cfg.params.find(p => p.name === 'liquidityTargetSchedule').value;
    assert.deepEqual(saved, [{ year: vars[0]._year, pool: 'buffer', scale: 1.5, by: 'run:test' }]);

    const after = new Date(Date.UTC(vars[0]._year, 2, 1));
    quiet(() => sim.stepTo(after));
    const ref = compiledAt({ ...BASE, liquidityTargetSchedule: saved }, after);
    assert.equal(bufferTarget(sim.state), 7.5, `${name}: the live sim did not resize`);
    assert.equal(bufferTarget(ref), 7.5);
    assert.deepEqual(sim.state.liquidityTargetScales, ref.liquidityTargetScales);
    assert.deepEqual(sim.state.liquidityTargetScales, { buffer: 1.5 });
  }
});

test('PTL-7b: `by` never changes a run (DPT-16)', () => {
  const at = new Date(Date.UTC(2046, 2, 1));
  const rows = [{ year: 2045, pool: 'buffer', scale: 1.5 }];
  const a = compiledAt({ ...BASE, liquidityTargetSchedule: rows }, at);
  const b = compiledAt({ ...BASE, liquidityTargetSchedule: rows.map(r => ({ ...r, by: 'run:x' })) }, at);
  assert.equal(computeNetWorth(a, 'USD'), computeNetWorth(b, 'USD'));
  assert.deepEqual(a.liquidityGraph, b.liquidityGraph);
});

// ─── PTL-8 ───────────────────────────────────────────────────────────────────

test('PTL-8: lever hygiene carries the §2.5 rows for POOL_TARGET, and only for it', () => {
  const g = { pools: [
    { id: 'cash',  spendOrder: 10, target: { mode: 'YEARS_OF_SPEND', value: 2 }, claims: [{ key: 'usSavingsAccount' }] },
    { id: 'bonds', spendOrder: 20, target: { mode: 'YEARS_OF_SPEND_REMAINDER', value: 6, after: ['cash'] },
      claims: [{ key: 'usStockAccount', sleeves: ['BOND'] }] },
  ] };
  const rows = leverHygieneProblems({ liquidityGraph: g }, ['POOL_TARGET']);
  assert.deepEqual(rows.map(r => `${r.lever}:${r.kind}`), ['POOL_TARGET:confounded', 'POOL_TARGET:confounded']);
  assert.deepEqual(leverHygieneProblems({ liquidityGraph: g }, ['POOL_SHAPE']), []);
});

// ─── PTL-9 — the harvest ─────────────────────────────────────────────────────

import { harvestDecisions } from '../../src/finance/mpc/harvest.js';

test('PTL-9: the harvest bakes every decided (year, pool) as a dated row, marked with the run', () => {
  const v45 = { paramKey: 'liquidityTargetSchedule[0].scale', _year: 2045, _pool: 'buffer', _controlKey: 'POOL_TARGET' };
  const v46 = { paramKey: 'liquidityTargetSchedule[1].scale', _year: 2046, _pool: 'buffer', _controlKey: 'POOL_TARGET' };
  const records = [
    { asOfDate: '2045-01-01', runId: 'run:1', controlKeys: ['POOL_TARGET'], controlVars: [v45],
      controlParams: { [v45.paramKey]: 1.5 } },
    { asOfDate: '2046-01-01', runId: 'run:1', controlKeys: ['POOL_TARGET'], controlVars: [v46],
      controlParams: { [v46.paramKey]: 1.25 } },
  ];
  const plan = harvestDecisions(records, {
    controlsByKey: { POOL_TARGET: TARGET },
    baseParams: { ...BASE, liquidityTargetSchedule: [{ year: 2030, pool: 'buffer', scale: 0.75 }] },
  });
  assert.equal(plan.entries.length, 1);
  assert.equal(plan.entries[0].paramKey, 'liquidityTargetSchedule');
  assert.equal(plan.entries[0].form, 'SCHEDULE');
  assert.deepEqual(plan.entries[0].to, [
    { year: 2030, pool: 'buffer', scale: 0.75 },
    { year: 2045, pool: 'buffer', scale: 1.5, by: 'run:1' },
    { year: 2046, pool: 'buffer', scale: 1.25, by: 'run:1' },
  ]);
});
