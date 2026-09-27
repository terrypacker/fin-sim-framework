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
 * pool-shape-expansion.test.mjs
 *
 * DESIGN 114 Part I — pool shapes that inherit (`extends`), expanded before anything reads them.
 *
 * PSE-1  No delta ⇒ the caller's own object back (every existing plan takes no new path)
 * PSE-2  Override in place, addition appended, remove dropped — ORDER preserved
 * PSE-3  Chains resolve parent-first; expansion is idempotent
 * PSE-4  Refusals: cycle, unknown parent, no base graph, bad remove, duplicates, missing ids
 * PSE-5  Lenient never throws; a broken shape comes back as authored
 * PSE-6  `shapeLineage`
 * PSE-7  Conversion — the delta is PROVEN, and refused when order would change
 * PSE-8  The loader: a delta resolves to exactly the graph its copy does; `base` is reserved
 * PSE-9  The authoring report: expansion refusals filed under the shape; no parent-cell echo
 * PSE-10 Readers see inherited pools (axes, hygiene, MPC gates, target rows)
 * PSE-11 A whole run: a delta shape and its copy are byte-identical, before and after the switch
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import {
  expandLiquidityShapes, expandedShapesOf, applyShapeDelta, shapeLineage, shapeDeltaAgainst,
  poolGraphEntries, poolGraphFor, liquidityShapeIds, sameGraphValue, isDeltaShape,
  ShapeExpansionError, BASE_SHAPE_ID,
} from '../../src/finance/pools/pool-shape-expansion.js';
import {
  resolveLiquidityGraphSchedule, collectAuthoredGraphProblems, blockingProblems,
} from '../../src/finance/pools/liquidity-graph.js';
import { scalablePoolTargets, describeScaledTarget } from '../../src/finance/pools/pool-target-scale.js';
import { gateClauseAxes } from '../../src/finance/pools/pool-gate-axis.js';
import { scheduledShapeAxes } from '../../src/finance/pools/pool-shape-year-axis.js';
import { poolGraphCompilesSpendOrder, shapeIdsOf } from '../../src/finance/mpc/lever-schedule.js';
import { ACCOUNT_TYPE } from '../../src/finance/assets/account.js';
import { loadScenarioSim } from '../helpers/scenario-harness.js';

const ACCOUNTS = [
  { stateKey: 'usSavingsAccount', type: ACCOUNT_TYPE.SAVINGS },
  { stateKey: 'usStockAccount',   type: ACCOUNT_TYPE.BROKERAGE },
];

const CASH   = { id: 'cash',   spendOrder: 10, claims: [{ key: 'usSavingsAccount' }] };
const BONDS  = { id: 'bonds',  spendOrder: 20, target: { mode: 'YEARS_OF_SPEND', value: 2 },
                 claims: [{ key: 'usStockAccount', sleeves: ['BOND'] }] };
const GROWTH = { id: 'growth', spendOrder: 40, claims: [{ key: 'usStockAccount', sleeves: ['EQUITY', 'GOLD', 'CASH'] }] };
const G2B    = { id: 'g2b', from: 'growth', to: 'bonds', trigger: { belowTargetFraction: 0.5 },
                 gate: { id: 'harvest', sourceDrawdownUnder: 0.05, drawdownBasis: 'INDEX' } };

const BASE = { pools: [CASH, BONDS, GROWTH], flows: [G2B] };

/** `bonds` sized larger — the one-field change design 114 §2 found on the author's plan. */
const BONDS_5 = { ...BONDS, target: { mode: 'YEARS_OF_SPEND', value: 5 } };
const BRIDGE_COPY  = { pools: [CASH, BONDS_5, GROWTH], flows: [G2B] };
const BRIDGE_DELTA = { extends: BASE_SHAPE_ID, pools: [BONDS_5] };

const throwsExpansion = (fn, re) => assert.throws(fn, (e) => {
  assert.ok(e instanceof ShapeExpansionError, `expected a ShapeExpansionError, got ${e}`);
  assert.match(e.message, re);
  return true;
});

// ─── PSE-1 ──────────────────────────────────────────────────────────────────────

test('PSE-1: no delta shape ⇒ the caller\'s own object, untouched', () => {
  const shapes = { bridge: BRIDGE_COPY };
  assert.equal(expandLiquidityShapes(BASE, shapes), shapes);
  assert.equal(expandLiquidityShapes(BASE, null), null);
  assert.equal(expandLiquidityShapes(BASE, undefined), undefined);
  const notAMap = [BRIDGE_COPY];
  assert.equal(expandLiquidityShapes(BASE, notAMap), notAMap, 'the loader owns the container refusal');
});

// ─── PSE-2 ──────────────────────────────────────────────────────────────────────

test('PSE-2: an override replaces the WHOLE item, in its parent\'s position', () => {
  const out = expandLiquidityShapes(BASE, { bridge: BRIDGE_DELTA });
  assert.deepEqual(out.bridge, BRIDGE_COPY);
  assert.equal(out.bridge.pools[0], CASH, 'inherited items are the parent\'s own objects');
  assert.ok(!('extends' in out.bridge));
});

test('PSE-2b: additions append in delta order; removals drop; flows follow the same rules', () => {
  const RESERVE = { id: 'reserve', spendOrder: 15, claims: [{ key: 'usSavingsAccount' }] };
  const G2R = { id: 'g2r', from: 'growth', to: 'reserve' };
  const out = expandLiquidityShapes(BASE, {
    late: { extends: 'base', pools: [RESERVE], flows: [G2R],
            remove: { pools: ['bonds'], flows: ['g2b'] } },
  });
  assert.deepEqual(out.late.pools.map(p => p.id), ['cash', 'growth', 'reserve']);
  assert.deepEqual(out.late.flows.map(f => f.id), ['g2r']);
});

test('PSE-2c: a parent with no flows and a delta with none ⇒ no flows key at all', () => {
  const out = expandLiquidityShapes({ pools: [CASH] }, { s: { extends: 'base' } });
  assert.deepEqual(out.s, { pools: [CASH] });
});

test('PSE-2d: a graph-level key the delta sets wins; the parent\'s is otherwise inherited', () => {
  const out = expandLiquidityShapes({ ...BASE, ui: { zoom: 1 } }, { s: { extends: 'base', ui: { zoom: 2 } } });
  assert.deepEqual(out.s.ui, { zoom: 2 });
  const kept = expandLiquidityShapes({ ...BASE, ui: { zoom: 1 } }, { s: { extends: 'base' } });
  assert.deepEqual(kept.s.ui, { zoom: 1 });
});

// ─── PSE-3 ──────────────────────────────────────────────────────────────────────

test('PSE-3: a chain of three resolves parent-first, whatever the authored key order', () => {
  const shapes = {
    pension: { extends: 'bridge', remove: { pools: ['cash'] } },
    bridge:  BRIDGE_DELTA,
    copy:    BRIDGE_COPY,
  };
  const out = expandLiquidityShapes(BASE, shapes);
  assert.deepEqual(Object.keys(out), ['pension', 'bridge', 'copy'], 'authored key order kept');
  assert.deepEqual(out.pension.pools, [BONDS_5, GROWTH]);
  assert.equal(out.copy, BRIDGE_COPY, 'a standalone shape is carried by reference');
});

test('PSE-3b: expansion is idempotent', () => {
  const once = expandLiquidityShapes(BASE, { bridge: BRIDGE_DELTA });
  assert.equal(expandLiquidityShapes(BASE, once), once);
});

// ─── PSE-4 ──────────────────────────────────────────────────────────────────────

test('PSE-4: refusals name the shape and say what is wrong', () => {
  throwsExpansion(() => expandLiquidityShapes(BASE, { a: { extends: 'b' }, b: { extends: 'a' } }),
    /shape 'a': `extends` forms a cycle: 'a' → 'b' → 'a'/);
  throwsExpansion(() => expandLiquidityShapes(BASE, { a: { extends: 'a' } }), /cycle/);
  throwsExpansion(() => expandLiquidityShapes(BASE, { a: { extends: 'nope' }, b: BRIDGE_COPY }),
    /shape 'a': extends 'nope', which is not a shape \(known: 'base', 'b'\)/);
  throwsExpansion(() => expandLiquidityShapes(null, { a: { extends: 'base' } }),
    /no base Liquidity Pools graph is authored/);
  throwsExpansion(() => expandLiquidityShapes(BASE, { a: { extends: '' } }), /has to name 'base'/);
  throwsExpansion(() => expandLiquidityShapes(BASE, { a: { extends: 'base', remove: { pools: ['ghost'] } } }),
    /removes pool 'ghost', which the parent does not have/);
  throwsExpansion(() => expandLiquidityShapes(BASE, { a: { extends: 'base', remove: { claims: ['x'] } } }),
    /`remove.claims` is unknown/);
  throwsExpansion(() => expandLiquidityShapes(BASE, { a: { extends: 'base', remove: { pools: 'cash' } } }),
    /`remove.pools` has to be a list of ids/);
  throwsExpansion(() => expandLiquidityShapes(BASE,
    { a: { extends: 'base', pools: [CASH], remove: { pools: ['cash'] } } }),
    /pool 'cash' is both removed and overridden/);
  throwsExpansion(() => expandLiquidityShapes(BASE, { a: { extends: 'base', pools: [CASH, CASH] } }),
    /pool 'cash' appears twice/);
  throwsExpansion(() => expandLiquidityShapes(BASE, { a: { extends: 'base', flows: [{ from: 'cash' }] } }),
    /every flow a shape overrides or adds needs an id/);
  throwsExpansion(() => expandLiquidityShapes(BASE, { a: { extends: 'base', pools: {} } }),
    /`pools` has to be a list/);
  throwsExpansion(() => expandLiquidityShapes({ pools: [CASH] }, { a: { extends: 'base', remove: { flows: ['x'] } } }),
    /removes flow 'x', which the parent does not have/);
});

// ─── PSE-5 ──────────────────────────────────────────────────────────────────────

test('PSE-5: lenient never throws — a broken shape comes back as authored, the rest expand', () => {
  const broken = { extends: 'nope' };
  const out = expandLiquidityShapes(BASE, { broken, bridge: BRIDGE_DELTA }, { lenient: true });
  assert.equal(out.broken, broken);
  assert.deepEqual(out.bridge, BRIDGE_COPY);
});

// ─── PSE-6 ──────────────────────────────────────────────────────────────────────

test('PSE-6: shapeLineage — nearest first, ending at base; empty when standalone; safe on cycles', () => {
  const shapes = { pension: { extends: 'bridge' }, bridge: BRIDGE_DELTA, copy: BRIDGE_COPY,
                   a: { extends: 'b' }, b: { extends: 'a' } };
  assert.deepEqual(shapeLineage(shapes, 'pension'), ['bridge', 'base']);
  assert.deepEqual(shapeLineage(shapes, 'copy'), []);
  assert.deepEqual(shapeLineage(shapes, 'a'), ['b']);
  assert.deepEqual(shapeLineage(null, 'a'), []);
  assert.ok(isDeltaShape(BRIDGE_DELTA) && !isDeltaShape(BRIDGE_COPY));
});

// ─── PSE-7 ──────────────────────────────────────────────────────────────────────

test('PSE-7: conversion finds the one differing pool, and the delta is proven', () => {
  const res = shapeDeltaAgainst(BASE, BRIDGE_COPY, 'base');
  assert.equal(res.ok, true);
  assert.deepEqual(res.delta, BRIDGE_DELTA);
  assert.ok(sameGraphValue(applyShapeDelta(BASE, res.delta, 'x'), BRIDGE_COPY));
});

test('PSE-7b: conversion records removals and additions', () => {
  const RESERVE = { id: 'reserve', spendOrder: 15, claims: [{ key: 'usSavingsAccount' }] };
  const shape = { pools: [CASH, GROWTH, RESERVE] };
  const res = shapeDeltaAgainst(BASE, shape, 'base');
  assert.equal(res.ok, true);
  assert.deepEqual(res.delta, { extends: 'base', pools: [RESERVE],
                                remove: { pools: ['bonds'], flows: ['g2b'] } });
});

test('PSE-7c: conversion is REFUSED when inheriting would reorder the graph', () => {
  const res = shapeDeltaAgainst(BASE, { pools: [BONDS, CASH, GROWTH], flows: [G2B] }, 'base');
  assert.equal(res.ok, false);
  assert.match(res.reason, /different order/);
  assert.equal(shapeDeltaAgainst(BASE, BRIDGE_DELTA, 'base').ok, false, 'already a delta');
});

test('PSE-7d: object key order is not a difference; array order is', () => {
  assert.ok(sameGraphValue({ a: 1, b: [1, 2] }, { b: [1, 2], a: 1 }));
  assert.ok(!sameGraphValue([1, 2], [2, 1]));
  assert.ok(!sameGraphValue({ a: 1 }, { a: 1, b: undefined }));
});

// ─── PSE-8 ──────────────────────────────────────────────────────────────────────

const sched = (shapes) => ({ liquidityGraph: BASE, liquidityShapes: shapes,
                             liquidityGraphSchedule: [{ year: 2035, shape: 'bridge' }] });

test('PSE-8: a delta resolves to exactly the graph its copy resolves to', () => {
  const copy  = resolveLiquidityGraphSchedule(sched({ bridge: BRIDGE_COPY }), ACCOUNTS);
  const delta = resolveLiquidityGraphSchedule(sched({ bridge: BRIDGE_DELTA }), ACCOUNTS);
  assert.equal(JSON.stringify(delta), JSON.stringify(copy));
  assert.equal(delta[1].graph.pools.find(p => p.id === 'bonds').target.value, 5);
});

test('PSE-8b: `base` is reserved as a shape id', () => {
  assert.throws(() => resolveLiquidityGraphSchedule(
    { liquidityGraph: BASE, liquidityShapes: { base: BRIDGE_COPY },
      liquidityGraphSchedule: [{ year: 2035, shape: 'base' }] }, ACCOUNTS),
  /'base' is reserved for the base graph/);
});

test('PSE-8c: an expansion refusal fails the LOAD, with the shape named', () => {
  assert.throws(() => resolveLiquidityGraphSchedule(sched({ bridge: { extends: 'nope' } }), ACCOUNTS),
    /^Error: liquidityGraph: shape 'bridge': extends 'nope'/);
});

test('PSE-8d: dated target rows scale a pool the shape only INHERITS', () => {
  const p = { liquidityGraph: BASE,
              liquidityShapes: { bridge: { extends: 'base', pools: [CASH] } },
              liquidityGraphSchedule: [{ year: 2035, shape: 'bridge' }],
              liquidityTargetSchedule: [{ year: 2036, pool: 'bonds', scale: 2 }] };
  const steps = resolveLiquidityGraphSchedule(p, ACCOUNTS);
  const at2036 = steps.find(s => s.year === 2036);
  assert.equal(at2036.shapeId, 'bridge');
  assert.equal(at2036.graph.pools.find(x => x.id === 'bonds').target.value, 4);
});

// ─── PSE-9 ──────────────────────────────────────────────────────────────────────

test('PSE-9: an expansion refusal is filed under the shape, not the schedule', () => {
  const problems = blockingProblems(collectAuthoredGraphProblems(
    sched({ bridge: { extends: 'nope' } }), ACCOUNTS));
  assert.equal(problems.length, 1);
  assert.equal(problems[0].param, 'liquidityShapes');
  assert.equal(problems[0].shape, 'bridge');
});

test('PSE-9b: a bad BASE cell is reported once — not again under every shape inheriting it', () => {
  const badBase = { ...BASE, pools: [CASH, { ...BONDS, target: { mode: 'PERCENT', value: 40 } }, GROWTH] };
  const problems = blockingProblems(collectAuthoredGraphProblems({
    liquidityGraph: badBase,
    liquidityShapes: { bridge: { extends: 'base', pools: [CASH] }, copy: BRIDGE_COPY },
    liquidityGraphSchedule: [{ year: 2035, shape: 'bridge' }, { year: 2040, shape: 'copy' }],
  }, ACCOUNTS));
  assert.deepEqual(problems.map(p => [p.param, p.shape ?? null, p.field]),
    [['liquidityGraph', null, 'target']]);
});

test('PSE-9c: a delta\'s own bad cell is localized to the delta\'s own row index', () => {
  const problems = blockingProblems(collectAuthoredGraphProblems(sched({
    bridge: { extends: 'base', pools: [{ ...BONDS, target: { mode: 'PERCENT', value: 40 } }] },
  }), ACCOUNTS));
  assert.deepEqual(problems.map(p => [p.param, p.shape, p.index, p.field]),
    [['liquidityShapes', 'bridge', 0, 'target']]);
});

test('PSE-9d: a clean delta plan reports no refusal', () => {
  assert.deepEqual(blockingProblems(collectAuthoredGraphProblems(sched({ bridge: BRIDGE_DELTA }), ACCOUNTS)), []);
});

// ─── PSE-10 ─────────────────────────────────────────────────────────────────────

test('PSE-10: the pool-target axis lists an inherited pool in the shape that inherits it', () => {
  const p = { liquidityGraph: BASE, liquidityShapes: { bridge: { extends: 'base', pools: [CASH] } } };
  const bonds = scalablePoolTargets(p).find(r => r.poolId === 'bonds');
  assert.deepEqual(bonds.authored.map(a => a.where), [null, 'bridge']);
  const asCopy = { liquidityGraph: BASE, liquidityShapes: { bridge: { ...BASE, pools: [CASH, BONDS, GROWTH] } } };
  assert.equal(describeScaledTarget(p, 'bonds', 2), describeScaledTarget(asCopy, 'bonds', 2));
});

test('PSE-10b: the gate axis finds an inherited flow\'s clause in the inheriting shape', () => {
  const p = { liquidityGraph: BASE, liquidityShapes: { bridge: BRIDGE_DELTA } };
  const row = gateClauseAxes(p).find(r => r.clauseId === 'harvest');
  assert.deepEqual(row.shapes, [null, 'bridge']);
});

test('PSE-10c: ids-only readers are unchanged by deltas', () => {
  const p = { liquidityGraph: BASE, liquidityShapes: { bridge: BRIDGE_DELTA, late: BRIDGE_COPY },
              liquidityGraphSchedule: [{ year: 2035, shape: 'bridge' }] };
  assert.deepEqual(liquidityShapeIds(p), ['bridge', 'late']);
  assert.deepEqual(shapeIdsOf(p), ['bridge', 'late']);
  assert.deepEqual(scheduledShapeAxes(p).map(r => r.shapeId), ['bridge']);
});

test('PSE-10d: MPC\'s spend-order gate sees an order a delta only inherits', () => {
  const noOrders = { pools: [{ id: 'cash', claims: [{ key: 'usSavingsAccount' }] }] };
  const p = { liquidityGraph: noOrders,
              liquidityShapes: { a: BRIDGE_COPY, b: { extends: 'a', pools: [{ id: 'x', claims: [] }] } } };
  assert.equal(poolGraphCompilesSpendOrder(p), true);
  assert.equal(poolGraphCompilesSpendOrder({ liquidityGraph: noOrders,
    liquidityShapes: { b: { extends: 'base', pools: [{ id: 'x', claims: [] }] } } }), false);
});

test('PSE-10e: poolGraphEntries / poolGraphFor / expandedShapesOf agree', () => {
  const p = { liquidityGraph: BASE, liquidityShapes: { bridge: BRIDGE_DELTA } };
  assert.deepEqual(poolGraphEntries(p), [[null, BASE], ['bridge', BRIDGE_COPY]]);
  assert.equal(poolGraphFor(p, null), BASE);
  assert.deepEqual(poolGraphFor(p, 'bridge'), BRIDGE_COPY);
  assert.deepEqual(expandedShapesOf(p).bridge, BRIDGE_COPY);
});

// ─── PSE-11 ─────────────────────────────────────────────────────────────────────

const LIVE = (shapes) => ({
  behavioralStrategies: ['LIQUIDITY_POOLS'],
  liquidityGraph: BASE,
  liquidityShapes: shapes,
  liquidityGraphSchedule: [{ year: 2028, shape: 'bridge' }],
});

test('PSE-11: a whole run — the delta and its copy are byte-identical across the switch', () => {
  const span = { simStart: '2026-01-01', simEnd: '2030-01-01', stepTo: '2030-01-01' };
  const copy  = loadScenarioSim({ params: LIVE({ bridge: BRIDGE_COPY }), ...span });
  const delta = loadScenarioSim({ params: LIVE({ bridge: BRIDGE_DELTA }), ...span });
  assert.equal(copy.sim.state.liquidityShapeId, 'bridge', 'the switch happened');
  assert.equal(JSON.stringify(delta.sim.state), JSON.stringify(copy.sim.state));
});

test('PSE-11b: a CONVERTED copy runs byte-identically to the copy it came from', () => {
  const span = { simStart: '2026-01-01', simEnd: '2030-01-01', stepTo: '2030-01-01' };
  const { delta } = shapeDeltaAgainst(BASE, BRIDGE_COPY, 'base');
  const copy      = loadScenarioSim({ params: LIVE({ bridge: BRIDGE_COPY }), ...span });
  const converted = loadScenarioSim({ params: LIVE({ bridge: delta }), ...span });
  assert.equal(JSON.stringify(converted.sim.state), JSON.stringify(copy.sim.state));
});
