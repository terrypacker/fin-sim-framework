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
 * shape-year-axis.test.mjs — design 110 leg C, phase 9 (§6.4, design 109 Q1).
 *
 * Q1's question is "what does moving the bridge shape two years earlier do", and Q1 itself
 * named the trap in the obvious answer: `liquidityGraphSchedule[i].year` is a nested path, a
 * dotted key is dropped by `set()`, and an axis that reads as authored and is inert is this
 * repo's most expensive recurring defect. The answer is a flat scalar companion — a SHIFT.
 *
 *   SYA-3   the defining assertion: one key moves every row selecting that shape, and the GAP
 *           between them is unchanged. An absolute year could not even express it.
 *   CTRL-8  the axis reaches a LOADED sim — two shifts, two rollouts
 *   CTRL-9  it does not round-trip
 *   CTRL-16 identity — an unswept plan is byte-identical
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import {
  shapeYearShiftKey, parseShapeYearShiftKey, shapeYearShiftsFrom, applyShapeYearShifts,
  scheduledShapeAxes, shapeYearShiftLabel, resolveShapeYearShiftCenters, SHAPE_YEAR_SHIFT_RANGE,
} from '../../src/finance/pools/pool-shape-year-axis.js';
import { resolveLiquidityGraphSchedule, activeGraphAt }
                                  from '../../src/finance/pools/liquidity-graph.js';
import { poolAxisProblems, POOL_AXIS_PROBLEM_KIND }
                                  from '../../src/finance/pools/pool-axis-hygiene.js';
import { ScenarioParamGenerator, isGeneratedParamKey, decodeGeneratedParamKey }
                                  from '../../src/scenarios/params/scenario-param-generator.js';
import { buildOptVariables, buildGridAxes }
                                  from '../../src/finance/optimization/intl-retirement-opt-config.js';
import { OPT_PARAM_TYPES }        from '../../src/finance/optimization/optimization-objectives.js';
import { set, get }               from '../../src/finance/monte-carlo/mc-param-paths.js';
import { IntlRetirementScenario } from '../../src/scenarios/intl-retirement-scenario.js';
import { ACCOUNT_TYPE }           from '../../src/finance/assets/account.js';
import { loadScenarioSim }        from '../helpers/scenario-harness.js';

const ACCOUNTS = [
  { stateKey: 'usSavingsAccount', type: ACCOUNT_TYPE.SAVINGS },
  { stateKey: 'usStockAccount',   type: ACCOUNT_TYPE.BROKERAGE },
];

const BRIDGE = shapeYearShiftKey('bridge');

const poolsAt = (years) => [
  { id: 'cash',    spendOrder: 10, claims: [{ key: 'usSavingsAccount' }],
    target: { mode: 'YEARS_OF_SPEND', value: 1 } },
  { id: 'reserve', spendOrder: 20, claims: [{ key: 'usStockAccount', sleeves: ['BOND'] }],
    target: { mode: 'YEARS_OF_SPEND', value: years } },
  { id: 'growth',  spendOrder: 30, claims: [{ key: 'usStockAccount', sleeves: ['EQUITY', 'GOLD', 'CASH'] }] },
];

/** Base graph, then `bridge` from 2035 and `late` from 2050. */
const PLAN = {
  liquidityGraph:  { pools: poolsAt(2) },
  liquidityShapes: { bridge: { pools: poolsAt(6) }, late: { pools: poolsAt(1) } },
  liquidityGraphSchedule: [{ year: 2035, shape: 'bridge' }, { year: 2050, shape: 'late' }],
};

const yearsOf = (p, shape) => resolveLiquidityGraphSchedule(p, ACCOUNTS)
  .filter(r => r.shapeId === shape).map(r => r.year);

// ── the key ────────────────────────────────────────────────────────────────────────────

test('SYA-1 the key is flat, generated, and decodes to NO cascade node', () => {
  assert.equal(BRIDGE, 'shape.bridge.yearShift');
  assert.equal(parseShapeYearShiftKey(BRIDGE), 'bridge');
  assert.equal(parseShapeYearShiftKey('shape.bridge.year'), null, 'only the one field');
  assert.equal(parseShapeYearShiftKey('pool.reserve.targetScale'), null);

  // Q1 named this exact trap: a nested path into the array is dropped, a generated namespace
  // key is written FLAT (design 98 W0 / `optimizer-param-key-dot-collision`).
  assert.ok(isGeneratedParamKey(BRIDGE));
  const bag = {};
  set(bag, BRIDGE, -2);
  assert.deepEqual(bag, { [BRIDGE]: -2 }, 'one flat key, no nested `shape` object');
  assert.equal(get(bag, BRIDGE), -2);
  assert.equal(decodeGeneratedParamKey(BRIDGE), null, 'a shape is not a record');
});

test('SYA-2 identity is free: no shift returns the caller\'s own array', () => {
  assert.equal(shapeYearShiftsFrom({}).size, 0);
  assert.equal(shapeYearShiftsFrom({ [BRIDGE]: 0 }).size, 0, 'zero is identity, not a shift');
  // A fractional shift is DROPPED, never rounded: `_normalizeSchedule` requires a whole year,
  // so rounding here would silently decide what the normalizer would have refused.
  assert.equal(shapeYearShiftsFrom({ [BRIDGE]: 1.5 }).size, 0);
  assert.equal(shapeYearShiftsFrom({ [BRIDGE]: 'x' }).size, 0);
  assert.equal(shapeYearShiftsFrom({ [BRIDGE]: -2 }).get('bridge'), -2);

  for (const bag of [{}, { [BRIDGE]: 0 }, { [shapeYearShiftKey('nope')]: 3 }]) {
    assert.equal(applyShapeYearShifts(PLAN.liquidityGraphSchedule, shapeYearShiftsFrom(bag)),
      PLAN.liquidityGraphSchedule, 'the same array back');
  }
});

// ── SYA-3, the defining assertion ──────────────────────────────────────────────────────

test('SYA-3 one key moves every row selecting that shape, and the GAP is unchanged', () => {
  // §10.3's argument, one object over. A shape id can carry SEVERAL authored years — two rows
  // in one YEAR is refused, two rows naming one SHAPE is not — so an absolute key would set
  // both to the same year, which is the refusal. A shift moves both and preserves the gap.
  const twice = { ...PLAN, liquidityGraphSchedule: [
    { year: 2035, shape: 'bridge' }, { year: 2045, shape: 'late' }, { year: 2055, shape: 'bridge' },
  ] };
  const before = yearsOf(twice, 'bridge');
  assert.deepEqual(before, [2035, 2055]);

  const moved = yearsOf({ ...twice, [BRIDGE]: -2 }, 'bridge');
  assert.deepEqual(moved, [2033, 2053], 'both rows move');
  assert.equal(moved[1] - moved[0], before[1] - before[0], 'and the gap between them is unchanged');
  // The shape nobody swept stays exactly where it was authored.
  assert.deepEqual(yearsOf({ ...twice, [BRIDGE]: -2 }, 'late'), [2045]);
  // The authored array is never written to.
  assert.deepEqual(twice.liquidityGraphSchedule.map(r => r.year), [2035, 2045, 2055]);
});

test('SYA-4 the shift reaches the schedule, the base-graph handover and activeGraphAt', () => {
  const p = { ...PLAN, [BRIDGE]: -2 };
  assert.deepEqual(yearsOf(p, 'bridge'), [2033]);
  // Moving the FIRST row is how the base graph's period is shortened — it has no axis of its
  // own because it is the `liquidityGraph` param and not a named shape.
  const opening = resolveLiquidityGraphSchedule(p, ACCOUNTS).find(r => r.shapeId === null);
  assert.equal(opening.year, null, 'the opening entry is still the base graph');
  const at = (y) => activeGraphAt(resolveLiquidityGraphSchedule(p, ACCOUNTS), Date.UTC(y, 5, 1));
  assert.equal(at(2032).shapeId, null, 'the base graph still governs in 2032');
  assert.equal(at(2034).shapeId, 'bridge', 'and the bridge has taken over by 2034 — two years early');
  assert.equal(activeGraphAt(resolveLiquidityGraphSchedule(PLAN, ACCOUNTS), Date.UTC(2034, 5, 1)).shapeId,
    null, 'which it had not, unswept');
});

test('SYA-5 no second validator: a shift onto another switch\'s year is REFUSED', () => {
  // §17.2 — the overlay never clamps. Only one shape can take over in a given year, and
  // coalescing two switches would run a schedule nobody wrote.
  const tight = { ...PLAN, liquidityGraphSchedule: [
    { year: 2035, shape: 'bridge' }, { year: 2037, shape: 'late' }] };
  assert.ok(resolveLiquidityGraphSchedule(tight, ACCOUNTS), 'the authored plan compiles');
  assert.throws(() => resolveLiquidityGraphSchedule({ ...tight, [BRIDGE]: 2 }, ACCOUNTS),
    /two rows for 2037/);
});

test('SYA-6 the master switch sits in front of the axis', () => {
  assert.equal(resolveLiquidityGraphSchedule({ ...PLAN, [BRIDGE]: -2,
    liquidityGraphEnabled: false }, ACCOUNTS), null);
});

// ── the axis surface ───────────────────────────────────────────────────────────────────

test('SYA-7 one axis per SCHEDULED shape — an unscheduled shape grows none', () => {
  assert.deepEqual(scheduledShapeAxes(PLAN).map(r => r.shapeId), ['bridge', 'late']);
  // A shape no row selects governs nothing, so an axis on it would move nothing at every
  // value — the dead lever PTS-13 already cost this design once.
  const orphan = { ...PLAN, liquidityShapes: { ...PLAN.liquidityShapes, unused: { pools: poolsAt(3) } } };
  assert.deepEqual(scheduledShapeAxes(orphan).map(r => r.shapeId), ['bridge', 'late']);
  // …and a row naming a shape that does not exist is skipped rather than offered.
  assert.deepEqual(scheduledShapeAxes({ liquidityShapes: {}, liquidityGraphSchedule: PLAN.liquidityGraphSchedule }), []);
  assert.deepEqual(scheduledShapeAxes({}), []);
});

test('SYA-8 the label names the years, and says when one key moves several', () => {
  const one = scheduledShapeAxes(PLAN).find(r => r.shapeId === 'bridge');
  assert.match(shapeYearShiftLabel(one), /from 2035/);
  assert.equal(/one key/.test(shapeYearShiftLabel(one)), false, 'one switch needs no caveat');

  const twice = scheduledShapeAxes({ ...PLAN, liquidityGraphSchedule: [
    { year: 2035, shape: 'bridge' }, { year: 2055, shape: 'bridge' }] })[0];
  const label = shapeYearShiftLabel(twice);
  assert.match(label, /from 2035, 2055/);
  assert.match(label, /2 switches, gap preserved/,
    'the reader must not have to infer that the gap survives');
});

test('SYA-9 the generated entry is a hidden, compile-only INTEGER centred on zero', () => {
  const entry = ScenarioParamGenerator.generate({ parameters: PLAN })
    .find(e => e.key === BRIDGE);
  assert.ok(entry);
  assert.equal(entry.hidden, true);
  assert.equal(entry.type, 'Integer', 'a whole number of years');
  assert.equal(entry.defaultValue, 0, 'zero is identity');
  assert.equal(entry.node, undefined, 'a shape is not a record');
  assert.equal(entry.mc, false, 'when a plan re-plumbs itself is chosen, not uncertain');
  assert.deepEqual(resolveShapeYearShiftCenters(PLAN),
    { [BRIDGE]: 0, [shapeYearShiftKey('late')]: 0 });
});

test('SYA-10 it is an optimizer variable and a grid axis, ranged in years', () => {
  const params = { ...IntlRetirementScenario.buildDefaultConfig({}).parameters, ...PLAN };
  const row = buildOptVariables(params).find(v => v.paramKey === BRIDGE);
  assert.ok(row);
  assert.equal(row.type, OPT_PARAM_TYPES.INTEGER);
  assert.deepEqual([row.min, row.max], [SHAPE_YEAR_SHIFT_RANGE.min, SHAPE_YEAR_SHIFT_RANGE.max]);
  assert.equal(row.enabled, false);
  assert.ok(buildGridAxes(params).some(v => v.paramKey === BRIDGE));

  const bare = IntlRetirementScenario.buildDefaultConfig({}).parameters;
  assert.equal(buildOptVariables(bare).some(v => String(v.paramKey).startsWith('shape.')), false);
});

test('SYA-11 hygiene warns when a shift will land on another switch', () => {
  // The REFUSES kind: not a flat grid and not an inflated one — a grid with HOLES. Worth
  // saying before the run, because §17.2 means those cells fail rather than clamp.
  const tight = { ...PLAN, behavioralStrategies: ['LIQUIDITY_POOLS', 'TARGET_ALLOCATION'],
    liquidityGraphSchedule: [{ year: 2035, shape: 'bridge' }, { year: 2038, shape: 'late' }] };
  const row = poolAxisProblems({ parameters: tight })
    .find(p => p.param === 'liquidityGraphSchedule');
  assert.ok(row);
  assert.equal(row.kind, POOL_AXIS_PROBLEM_KIND.REFUSES);
  assert.match(row.message, /3 years apart/);
  assert.match(row.message, /holes in the grid/);

  // Switches further apart than the shift range cannot collide, so nothing is said.
  const roomy = { ...tight, liquidityGraphSchedule: PLAN.liquidityGraphSchedule };
  assert.equal(poolAxisProblems({ parameters: roomy })
    .some(p => p.kind === POOL_AXIS_PROBLEM_KIND.REFUSES), false);
});

test('SYA-12 hygiene warns when a PERCENT pool cannot take the top of the factor range', () => {
  // The other §17.2 consequence, owed since phase 6: a PERCENT target is a fraction of the
  // book, so a factor that pushes it past 1.0 is refused rather than clamped.
  const pct = { liquidityGraph: { pools: [
    { id: 'reserve', spendOrder: 10, claims: [{ key: 'usStockAccount', sleeves: ['BOND'] }],
      target: { mode: 'PERCENT', value: 0.6 } }] },
    behavioralStrategies: ['LIQUIDITY_POOLS', 'TARGET_ALLOCATION'] };
  const row = poolAxisProblems({ parameters: pct }).find(p => p.param === 'liquidityGraph');
  assert.ok(row);
  assert.equal(row.kind, POOL_AXIS_PROBLEM_KIND.REFUSES);
  assert.match(row.message, /60%/);
  assert.match(row.message, /Factors over 1\.66/);
  // A pool sized in years has no ceiling, so it says nothing.
  const yrs = { ...pct, liquidityGraph: { pools: [{ ...pct.liquidityGraph.pools[0],
    target: { mode: 'YEARS_OF_SPEND', value: 6 } }] } };
  assert.equal(poolAxisProblems({ parameters: yrs })
    .some(p => p.kind === POOL_AXIS_PROBLEM_KIND.REFUSES), false);
});

// ── CTRL-8 / CTRL-9 / CTRL-16, on a loaded sim ─────────────────────────────────────────

const SPAN = { simStart: '2026-01-01', simEnd: '2040-01-01', stepTo: '2040-01-01', telemetry: 'off' };
const RUN = { behavioralStrategies: ['LIQUIDITY_POOLS', 'TARGET_ALLOCATION'],
              ...PLAN, liquidityGraphSchedule: [{ year: 2032, shape: 'bridge' }] };

test('CTRL-8 the shape-year axis reaches a LOADED sim: two shifts, two rollouts', () => {
  const plan   = loadScenarioSim({ params: RUN, ...SPAN });
  const sooner = loadScenarioSim({ params: { ...RUN, [BRIDGE]: -3 }, ...SPAN });

  // It arrives at all — the trap Q1 named and `pool-axis-dropped-by-toolset-forwarding`
  // re-found, asserted separately from the effect.
  assert.equal(sooner.cfg.parameters[BRIDGE], -3, 'the axis survives buildDefaultConfig');
  const reserveTarget = (s) => s.liquidityGraph.pools.find(p => p.id === 'reserve').target.value;
  // By 2040 both plans are on the bridge shape, so the graphs agree at the END…
  assert.equal(reserveTarget(plan.sim.state), 6);
  assert.equal(reserveTarget(sooner.sim.state), 6);
  // …and differ in the run, because one spent three more years holding six years of reserve.
  assert.notEqual(JSON.stringify(sooner.sim.state), JSON.stringify(plan.sim.state));
});

test('CTRL-9 the shape axis does not round-trip — cfg.params keeps the AUTHORED year', () => {
  const { cfg } = loadScenarioSim({ params: { ...RUN, [BRIDGE]: -3 }, ...SPAN });
  assert.equal(cfg.params.some(p => String(p.name).startsWith('shape.')), false,
    'a hidden generated param is never materialized into cfg.params');
  assert.deepEqual(cfg.params.find(p => p.name === 'liquidityGraphSchedule').value,
    [{ year: 2032, shape: 'bridge' }], 'the author\'s year, not the swept one');
  assert.deepEqual(RUN.liquidityGraphSchedule, [{ year: 2032, shape: 'bridge' }]);
});

test('CTRL-16 identity: a shift of zero is byte-identical to no axis at all', () => {
  const a = loadScenarioSim({ params: RUN, ...SPAN });
  const b = loadScenarioSim({ params: { ...RUN, [BRIDGE]: 0 }, ...SPAN });
  assert.equal(JSON.stringify(b.sim.state), JSON.stringify(a.sim.state));
});
