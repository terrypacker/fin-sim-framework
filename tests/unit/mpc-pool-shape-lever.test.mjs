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
 * mpc-pool-shape-lever.test.mjs
 *
 * DESIGN 39 §14.10 step 3 — the graph-swap lever. `POOL_SHAPE` lets the MPC decide which design
 * 109 shape governs from a year on. The requirement it answers is that a swap has to be
 * something the solver can TEST (a rollout sees the candidate's shape) and ACTUATE (the live sim
 * carries it, and a Rebuild or a design 81 replay reproduces it).
 *
 * PSL-1  the gate: needs a named shape, and a base graph or a schedule to swap from
 * PSL-2  the scaffold row carries the shape the plan already has in force (the no-op is the plan)
 * PSL-3  one ENUM variable over [base, ...shapes], addressing the scaffolded row
 * PSL-4  the fold: a recorded row becomes a schedule row, null is the base graph, junk is dropped
 * PSL-5  a no-op candidate prices EXACTLY the base plan's rollout, with or without a schedule
 * PSL-6  a candidate reaches the rollout: on the spot at a 1-January epoch, at the row otherwise
 * PSL-7  the live actuate: the running sim swaps, and matches a t₀ compile of the saved schedule
 * PSL-8  base-graph rows (`shape: null`) — the schedule can return to the base graph
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import { OptimizationProblem }     from '../../src/finance/optimization/optimization-problem.js';
import { OPTIMIZATION_OBJECTIVES } from '../../src/finance/optimization/optimization-objectives.js';
import { COCKPIT_CONTROLS }        from '../../src/finance/mpc/cockpit-controller.js';
import { ServiceRegistry }         from '../../src/services/service-registry.js';
import { IntlRetirementScenario }  from '../../src/scenarios/intl-retirement-scenario.js';
import { ScenarioLoader }          from '../../src/scenarios/scenario-loader.js';
import { ScenarioSerializer }      from '../../src/scenarios/scenario-serializer.js';
import { applyParamBagToConfig }   from '../../src/scenarios/scenario-param-apply.js';
import { computeNetWorth }         from '../../src/finance/derived-metrics/net-worth.js';

const SHAPE = COCKPIT_CONTROLS.POOL_SHAPE;

const SIM_START = new Date(Date.UTC(2026, 0, 1));
const SIM_END   = new Date(Date.UTC(2060, 0, 1));
/**
 * Every epoch addresses the first 1 January whose year-open has not run (design 112 §8): a
 * snapshot includes its own date's events, so at 1 January that day's advance is behind it.
 */
const JAN_1     = new Date(Date.UTC(2045, 0, 1));
const MID_YEAR  = new Date(Date.UTC(2045, 5, 15));
/** The cockpit's own epoch date: the year-open is the next day, so there is no lag. */
const YEAR_END  = new Date(Date.UTC(2044, 11, 31));

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

/** The same graph with one pool's field changed. */
function graphWith(poolId, mutate) {
  const g = structuredClone(GRAPH);
  mutate(g.pools.find(p => p.id === poolId));
  return g;
}

/** Wrappers drawn right after cash: a different compiled spend order, visible in state. */
const WRAPPERS_EARLY = graphWith('wrappers', p => { p.spendOrder = 15; });

/** Shapes, no schedule: the base graph governs the whole run until the lever decides. */
const UNSCHEDULED = {
  spendingStrategy:     ['EXPLICIT_BANDS'],
  spendingExpenseBands: [{ startAge: 45, monthlyAmount: 9000 }],
  behavioralStrategies: ['TARGET_ALLOCATION', 'LIQUIDITY_POOLS'],
  liquidityGraph:       GRAPH,
  liquidityShapes:      { early: WRAPPERS_EARLY },
  liquidityGraphSchedule: [],
};

/** Shapes and a schedule that switched before either epoch. */
const SCHEDULED = { ...UNSCHEDULED, liquidityGraphSchedule: [{ year: 2040, shape: 'early' }] };

const quiet = (fn) => {
  const l = console.log, w = console.warn;
  console.log = () => {}; console.warn = () => {};
  try { return fn(); } finally { console.log = l; console.warn = w; }
};

const problem = (params, initialState) => new OptimizationProblem({
  variables: [], baseParams: params, objective: OPTIMIZATION_OBJECTIVES.MAX_NET_WORTH,
  simStart: SIM_START, simEnd: SIM_END, initialState,
});

/** Production params: the resolved base, as `evaluate` / `rollToSnapshot` compile. */
const seededFrom = (p) => p._seededSim({ ...p._resolveBase(), endDate: SIM_END });

const snapshotOf = (params, asOf) => quiet(() =>
  problem(params, { kind: 'compile', cfgTemplate: null }).rollToSnapshot({}, asOf));

const seeded = (params, snap) => quiet(() =>
  seededFrom(problem(params, { kind: 'snapshot', snapshot: snap, cfgTemplate: null })));

/** A rollout's terminal net worth, from the snapshot, under `params`. */
const terminal = (params, snap) => quiet(() => {
  const sim = seeded(params, snap);
  sim.stepTo(SIM_END);
  return computeNetWorth(sim.state, 'USD');
});

const order = (st) => st.drawdownSequence?.map(e => e.key);

/** The candidate the cockpit would roll out: the scaffolded row for `asOf` set to `shape`. */
function candidate(base, asOf, shape) {
  const prepared = SHAPE.prepareBaseParams({ baseParams: base, asOf });
  const [v] = SHAPE.buildVariables({ baseParams: prepared, asOf });
  const sched = prepared.liquidityGraphSchedule.map(e => (e.year === v._year ? { ...e, shape } : e));
  return { ...prepared, liquidityGraphSchedule: sched };
}

// ─── PSL-1 ───────────────────────────────────────────────────────────────────

test('PSL-1: the gate needs a named shape, and a graph or schedule to swap from', () => {
  assert.equal(SHAPE.appliesTo(UNSCHEDULED), true);
  assert.equal(SHAPE.appliesTo({ ...UNSCHEDULED, liquidityShapes: {} }), false, 'nothing to swap to');
  assert.equal(SHAPE.appliesTo({ ...UNSCHEDULED, liquidityGraph: null }), false,
    'no base graph and no schedule: no pool reducer exists to apply a decision');
  assert.equal(SHAPE.appliesTo({ ...SCHEDULED, liquidityGraph: null }), true);
  assert.equal(SHAPE.appliesTo({ ...UNSCHEDULED, liquidityGraphEnabled: false }), false);
  assert.ok(SHAPE.requirement);
});

// ─── PSL-2 ───────────────────────────────────────────────────────────────────

test('PSL-2: the scaffold carries the shape already in force; the year follows the epoch', () => {
  const rowAt = (p, y) => p.liquidityGraphSchedule.find(e => e.year === y);

  // Any instant in a year addresses the next year's row — including 1 January itself, whose
  // year-open has already run — and a year-end epoch addresses the very next day.
  assert.deepEqual(rowAt(SHAPE.prepareBaseParams({ baseParams: UNSCHEDULED, asOf: JAN_1 }), 2046),
    { year: 2046, shape: null }, 'before any row the base graph is in force');
  assert.deepEqual(rowAt(SHAPE.prepareBaseParams({ baseParams: UNSCHEDULED, asOf: YEAR_END }), 2045),
    { year: 2045, shape: null }, 'a year-end epoch addresses the next day\'s year-open');
  assert.deepEqual(rowAt(SHAPE.prepareBaseParams({ baseParams: SCHEDULED, asOf: MID_YEAR }), 2046),
    { year: 2046, shape: 'early' }, 'after the 2040 row, its shape is in force');

  const once  = SHAPE.prepareBaseParams({ baseParams: SCHEDULED, asOf: JAN_1 });
  const twice = SHAPE.prepareBaseParams({ baseParams: once, asOf: JAN_1 });
  assert.deepEqual(twice.liquidityGraphSchedule, once.liquidityGraphSchedule, 'idempotent');
  assert.deepEqual(once.liquidityGraphSchedule.map(e => e.year), [2040, 2046], 'sorted');
  assert.deepEqual(SCHEDULED.liquidityGraphSchedule, [{ year: 2040, shape: 'early' }],
    'the caller\'s schedule is not mutated');
});

// ─── PSL-3 ───────────────────────────────────────────────────────────────────

test('PSL-3: one ENUM variable over [base, ...shapes], addressing the scaffolded row', () => {
  const prepared = SHAPE.prepareBaseParams({ baseParams: SCHEDULED, asOf: JAN_1 });
  const [v, ...rest] = SHAPE.buildVariables({ baseParams: prepared, asOf: JAN_1 });
  assert.equal(rest.length, 0);
  assert.equal(v.paramKey, 'liquidityGraphSchedule[1].shape');
  assert.deepEqual(v.values, [null, 'early']);
  assert.equal(v._year, 2046);
  assert.match(SHAPE.describe({ [v.paramKey]: 'early' }, [v]), /'early' from 2046/);
  assert.match(SHAPE.describe({ [v.paramKey]: null }, [v]), /base pool graph from 2046/);
  assert.equal(SHAPE.scheduleKey(v), 'year@2046', 'recorded by year, never by row index');
});

// ─── PSL-4 ───────────────────────────────────────────────────────────────────

test('PSL-4: the fold turns recorded rows into schedule rows', () => {
  const folded = SHAPE.foldAt({ baseParams: SCHEDULED, rows: [
    { key: 'year@2045', value: null },
    { key: 'year@2040', value: 'early' },
    { key: 'year@2050', value: 7 },           // junk: dropped, not coerced
  ] });
  assert.deepEqual(folded, [{ year: 2040, shape: 'early' }, { year: 2045, shape: null }]);
  assert.equal(SHAPE.foldAt({ baseParams: SCHEDULED, rows: [] }), null, 'nothing decided, no fold');
});

// ─── PSL-5 ───────────────────────────────────────────────────────────────────

test('PSL-5: a no-op candidate prices EXACTLY the plan, with or without a schedule', () => {
  // The scaffold adds a row naming the shape already in force. On an unscheduled plan that row
  // CREATES a schedule, and with it a shape reducer and a schedule on both flow reducers — so
  // "exact" here is a statement about all of that machinery, not just the row.
  for (const [name, base, asOf] of [['unscheduled', UNSCHEDULED, JAN_1], ['scheduled', SCHEDULED, MID_YEAR]]) {
    const snap = snapshotOf(base, asOf);
    const prepared = SHAPE.prepareBaseParams({ baseParams: base, asOf });
    assert.equal(terminal(prepared, snap), terminal(base, snap), `${name}: the no-op moved the rollout`);
  }
});

// ─── PSL-6 ───────────────────────────────────────────────────────────────────

test('PSL-6: a candidate reaches the rollout at the next year-open, and prices what a compile prices', () => {
  // Year-end epoch: nothing moves at "now"; the swap lands at the next day's year-open.
  const snapE = snapshotOf(UNSCHEDULED, YEAR_END);
  const candE = candidate(UNSCHEDULED, YEAR_END, 'early');
  const simE  = seeded(candE, snapE);
  assert.equal(simE.state.liquidityShapeId ?? null, null, 'not yet: the row is 2045\'s');
  quiet(() => simE.stepTo(new Date(Date.UTC(2045, 0, 2))));
  assert.equal(simE.state.liquidityShapeId, 'early', 'swapped at the 1 January 2045 year-open');
  assert.deepEqual(order(simE.state), order(compiledAt(candE, new Date(Date.UTC(2045, 0, 2)))));

  // Mid-year epoch: the row is next year's, so "now" is untouched and the swap lands at the row.
  const snapM = snapshotOf(SCHEDULED, MID_YEAR);
  const candM = candidate(SCHEDULED, MID_YEAR, null);
  const simM  = seeded(candM, snapM);
  assert.equal(simM.state.liquidityShapeId, 'early', 'not yet: the base-graph row is 2046\'s');
  quiet(() => simM.stepTo(new Date(Date.UTC(2046, 1, 1))));
  assert.equal(simM.state.liquidityShapeId ?? null, null, 'swapped back to the base graph at the row');
  assert.deepEqual(order(simM.state), order(compiledAt(UNSCHEDULED, new Date(Date.UTC(2046, 1, 1)))),
    'and runs the base graph\'s spend order');
});

test('PSL-6b: from any epoch — year-end, 1 January, mid-year — the rollout ≡ a t₀ compile of the rows', () => {
  // The design 112 §8 property. The old "at or after" rule addressed THIS year's row from a
  // 1-January epoch, after its year-open had run: the rollout realised it one advance late and a
  // compile (a replay) did not, and the two terminals differed.
  for (const asOf of [YEAR_END, JAN_1, MID_YEAR]) {
    const cand = candidate(UNSCHEDULED, asOf, 'early');
    const snap = snapshotOf(UNSCHEDULED, asOf);
    const rollout = terminal(cand, snap);
    const compile = quiet(() => {
      const sim = seededFrom(problem(cand, { kind: 'compile', cfgTemplate: null }));
      sim.stepTo(SIM_END);
      return computeNetWorth(sim.state, 'USD');
    });
    assert.equal(rollout, compile, `epoch ${asOf.toISOString().slice(0, 10)}: rollout and compile differ`);
  }
});

// ─── PSL-7 ───────────────────────────────────────────────────────────────────

/**
 * A LIVE sim, built the way the app builds the active scenario: a registry, the scenario's
 * `buildSim`, and the loader over a cfg whose `params` list carries the schedule entry (the
 * store `actuate` persists into).
 */
function liveSim(params) {
  return quiet(() => {
    const registry = new ServiceRegistry();
    const scenario = new IntlRetirementScenario({
      context: registry.simulationContext, params, simStart: SIM_START, simEnd: SIM_END,
    });
    scenario.buildSim({ telemetry: 'off' });
    const cfg = ScenarioSerializer.serializeScenario(
      IntlRetirementScenario.buildDefaultConfig({}, SIM_START, SIM_END));
    cfg.params = [{ name: 'liquidityGraphSchedule', value: params.liquidityGraphSchedule ?? [] }];
    applyParamBagToConfig(cfg, params);
    new ScenarioLoader().load(cfg, registry);
    return { sim: scenario.sim, services: registry, cfg };
  });
}

/** A t₀ compile of `params`, stepped to `date` — what a Rebuild or replay would be at that date. */
function compiledAt(params, date) {
  return quiet(() => {
    const p = problem(params, { kind: 'compile', cfgTemplate: null });
    const sim = seededFrom(p);
    sim.stepTo(date);
    return sim.state;
  });
}

test('PSL-7: the live actuate swaps the running sim, and matches a compile of what it saved', () => {
  for (const [name, base, asOf, shape] of [
    // An unscheduled plan: the actuate must REGISTER a shape reducer the sim never had.
    ['unscheduled, 1 Jan', UNSCHEDULED, JAN_1, 'early'],
    // The same, mid-year: nothing is stamped at "now", so the swap next January can only come
    // from the reducer the actuate registered. This is the case that proves registration.
    ['unscheduled, mid-year', UNSCHEDULED, MID_YEAR, 'early'],
    ['scheduled, mid-year', SCHEDULED, MID_YEAR, null],
  ]) {
    const { sim, services, cfg } = liveSim(base);
    quiet(() => sim.stepTo(asOf));
    const prepared = SHAPE.prepareBaseParams({ baseParams: base, asOf });
    const vars = SHAPE.buildVariables({ baseParams: prepared, asOf });
    const ok = quiet(() => SHAPE.actuate({
      services, scenario: cfg, candidate: { [vars[0].paramKey]: shape }, vars }));
    assert.equal(ok, true, `${name}: actuate reported failure`);

    const saved = cfg.params.find(p => p.name === 'liquidityGraphSchedule').value;
    assert.ok(saved.some(r => r.year === vars[0]._year && r.shape === shape),
      `${name}: the decision must be saved as a schedule row`);

    // Past the row, the live sim and a t₀ compile of the SAVED schedule agree on the pools.
    const after = new Date(Date.UTC(vars[0]._year, 2, 1));
    quiet(() => sim.stepTo(after));
    const ref = compiledAt({ ...base, liquidityGraphSchedule: saved }, after);
    assert.equal(sim.state.liquidityShapeId ?? null, shape, `${name}: the live sim did not swap`);
    assert.equal(ref.liquidityShapeId ?? null, shape);
    assert.deepEqual(order(sim.state), order(ref), `${name}: live and replay spend orders differ`);
  }
});

// ─── PSL-8 ───────────────────────────────────────────────────────────────────

test('PSL-8: a `shape: null` row returns the schedule to the base graph', () => {
  const back = { ...SCHEDULED,
    liquidityGraphSchedule: [{ year: 2040, shape: 'early' }, { year: 2050, shape: null }] };
  const st2045 = compiledAt(back, new Date(Date.UTC(2045, 2, 1)));
  const st2051 = compiledAt(back, new Date(Date.UTC(2051, 2, 1)));
  const baseRun = compiledAt(UNSCHEDULED, new Date(Date.UTC(2051, 2, 1)));
  assert.equal(st2045.liquidityShapeId, 'early');
  assert.equal(st2051.liquidityShapeId ?? null, null);
  assert.deepEqual(order(st2051), order(baseRun), 'back on the base graph\'s spend order');

  // A row with no `shape` key at all is still the typo it always was.
  assert.throws(() => quiet(() => compiledAt(
    { ...SCHEDULED, liquidityGraphSchedule: [{ year: 2050 }] }, new Date(Date.UTC(2027, 0, 2)))),
    /names no shape/);
});
