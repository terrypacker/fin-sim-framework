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
 * pool-target-scale-axis.test.mjs — design 110 leg C, phase 6 (§6.2, §10.3).
 *
 * `pool.<poolId>.targetScale` is a hidden, compile-only lever that multiplies a pool's
 * authored target in every shape that contains it. The properties, from §9's plan:
 *
 *   CTRL-8   the axis reaches a LOADED sim — two values, two rollouts
 *   CTRL-9   it does not round-trip — never in `cfg.params`, and the authored graph survives
 *   CTRL-10  a renamed pool takes its axis with it
 *   CTRL-14  a shape-spanning axis preserves the authored PROFILE — both values move and
 *            their ratio is unchanged. §10.3 says this is the defining assertion of the key
 *            rather than a guard on it: if it is deleted the key has no meaning left.
 *   CTRL-16  identity — with no axis used, nothing moves
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import {
  poolTargetScaleKey, parsePoolTargetScaleKey, poolTargetScalesFrom,
  scaleRawPoolGraph, scaleRawPoolShapes, scalablePoolTargets,
  poolTargetScaleLabel, resolvePoolTargetScaleCenters,
} from '../../src/finance/pools/pool-target-scale.js';
import { resolveLiquidityGraph, resolveLiquidityGraphSchedule }
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
import { McGridRunner }           from '../../src/finance/monte-carlo/mc-grid-runner.js';
import { GRID_MODES }             from '../../src/finance/monte-carlo/mc-grid.js';
import { loadScenarioSim }        from '../helpers/scenario-harness.js';

const ACCOUNTS = [
  { stateKey: 'usSavingsAccount', type: ACCOUNT_TYPE.SAVINGS },
  { stateKey: 'usStockAccount',   type: ACCOUNT_TYPE.BROKERAGE },
];

const SCALE = poolTargetScaleKey('reserve');

/** The base graph: `reserve` holds 2 years. A targeted pool claims ONE class (§12.2). */
const BASE = {
  pools: [
    { id: 'cash',    spendOrder: 10, claims: [{ key: 'usSavingsAccount' }] },
    { id: 'reserve', spendOrder: 20, claims: [{ key: 'usStockAccount', sleeves: ['BOND'] }],
      target: { mode: 'YEARS_OF_SPEND', value: 2 } },
    { id: 'growth',  spendOrder: 30, claims: [{ key: 'usStockAccount', sleeves: ['EQUITY', 'GOLD', 'CASH'] }] },
  ],
};

/** The bridge shape: the SAME pool, holding 4 years. The profile CTRL-14 defends. */
const BRIDGE = structuredClone(BASE);
BRIDGE.pools[1].target = { mode: 'YEARS_OF_SPEND', value: 4 };

const SCHEDULED = {
  liquidityGraph:         BASE,
  liquidityShapes:        { bridge: BRIDGE },
  liquidityGraphSchedule: [{ year: 2030, shape: 'bridge' }],
};

/** One pool's target value, in whichever of the two authored forms it takes. */
const targetOf = (graph, id) => {
  const t = graph.pools.find(p => p.id === id)?.target;
  return typeof t === 'number' ? t : (t?.value ?? null);
};

// ── the key ────────────────────────────────────────────────────────────────────────────

test('PTS-1 the key is in a generated namespace and decodes to NO cascade node', () => {
  assert.equal(SCALE, 'pool.reserve.targetScale');
  assert.equal(parsePoolTargetScaleKey(SCALE), 'reserve');
  assert.equal(parsePoolTargetScaleKey('pool.reserve.target'), null, 'only the one field');
  assert.equal(parsePoolTargetScaleKey('acct.x.balance'), null);
  // A pool id is any non-empty string, so a dotted id must still resolve.
  assert.equal(parsePoolTargetScaleKey('pool.au.bridge.targetScale'), 'au.bridge');

  // In the namespace list, so `set()` writes it FLAT — the trap that makes a dotted lever
  // inert in a real solve while passing every hand-written flat-bag test (design 98 W0).
  assert.ok(isGeneratedParamKey(SCALE));
  const bag = {};
  set(bag, SCALE, 1.5);
  assert.deepEqual(bag, { [SCALE]: 1.5 }, 'one flat key, no nested `pool` object');
  assert.equal(get(bag, SCALE), 1.5);

  // But NOT a record key: there is no pool record for a cascade to fan a value onto, so
  // decoding must produce nothing rather than a node pointing at a record that never exists.
  assert.equal(decodeGeneratedParamKey(SCALE), null);
});

test('PTS-2 identity is free: a factor of 1 (or none) returns the caller\'s own object', () => {
  assert.equal(poolTargetScalesFrom({}).size, 0);
  assert.equal(poolTargetScalesFrom({ [SCALE]: 1 }).size, 0, 'identity is not a scale');
  assert.equal(poolTargetScalesFrom({ [SCALE]: 'x' }).size, 0);
  assert.equal(poolTargetScalesFrom({ [SCALE]: -1 }).size, 0);
  assert.equal(poolTargetScalesFrom({ [SCALE]: 0.5 }).get('reserve'), 0.5);

  // Same OBJECT back, not an equal copy — CTRL-16's mechanism. The graph the compiler
  // normalizes is the authored one whenever nothing is swept.
  for (const bag of [{}, { [SCALE]: 1 }]) {
    assert.equal(scaleRawPoolGraph(BASE, poolTargetScalesFrom(bag)), BASE);
    assert.equal(scaleRawPoolShapes(SCHEDULED.liquidityShapes, poolTargetScalesFrom(bag)),
      SCHEDULED.liquidityShapes);
  }
  // And a factor on a pool nobody targeted changes nothing either.
  assert.equal(scaleRawPoolGraph(BASE, poolTargetScalesFrom({ [poolTargetScaleKey('growth')]: 2 })), BASE);
});

test('PTS-3 the authored param object is never written to — the overlay is a copy', () => {
  const before = JSON.stringify(BASE);
  const scaled = scaleRawPoolGraph(BASE, poolTargetScalesFrom({ [SCALE]: 3 }));
  assert.equal(JSON.stringify(BASE), before, 'the author\'s graph is untouched');
  assert.equal(targetOf(scaled, 'reserve'), 6);
  // Applied to its own output a multiplier would compound; nothing may do that, which is
  // why the seam is the resolver and not a cascade that writes the value back.
  assert.equal(targetOf(scaleRawPoolGraph(scaled, poolTargetScalesFrom({ [SCALE]: 3 })), 'reserve'), 18);
});

test('PTS-4 both authored forms scale, and float noise is trimmed', () => {
  const bare = { pools: [{ id: 'reserve', spendOrder: 1, claims: [{ key: 'usSavingsAccount' }], target: 5 }] };
  assert.equal(targetOf(scaleRawPoolGraph(bare, poolTargetScalesFrom({ [SCALE]: 1.2 })), 'reserve'), 6,
    'the bare-number sugar scales, and 5 × 1.2 is 6 rather than 6.000000000000001');
  const pct = { pools: [{ id: 'reserve', target: { mode: 'PERCENT', value: 0.3 } }] };
  assert.equal(targetOf(scaleRawPoolGraph(pct, poolTargetScalesFrom({ [SCALE]: 1.5 })), 'reserve'), 0.45);
  // The mode and everything else on the spec ride along unchanged.
  const spec = scaleRawPoolGraph(
    { pools: [{ id: 'reserve', target: { mode: 'YEARS_OF_SPEND', value: 2, spendBasis: 'TRAILING', trailingYears: 5 } }] },
    poolTargetScalesFrom({ [SCALE]: 2 })).pools[0].target;
  assert.deepEqual(spec, { mode: 'YEARS_OF_SPEND', value: 4, spendBasis: 'TRAILING', trailingYears: 5 });
});

// ── CTRL-14, the defining assertion ────────────────────────────────────────────────────

test('CTRL-14 a shape-spanning axis moves both values and leaves their ratio alone', () => {
  const swept = { ...SCHEDULED, [SCALE]: 0.5 };
  const base   = resolveLiquidityGraph(swept, ACCOUNTS);
  const bridge = resolveLiquidityGraphSchedule(swept, ACCOUNTS)
    .find(r => r.shapeId === 'bridge').graph;

  assert.equal(targetOf(base,   'reserve'), 1, 'the base graph\'s 2 years halve');
  assert.equal(targetOf(bridge, 'reserve'), 2, 'the bridge shape\'s 4 years halve');
  // The mistake this pins (§10.3): an absolute axis set to 3 would make BOTH 3 — it still
  // runs, still reports a number, and has deleted the policy the author wrote.
  assert.equal(targetOf(bridge, 'reserve') / targetOf(base, 'reserve'), 2,
    'the authored profile survives the sweep');
  // The opening entry of the schedule is the base graph, and it is scaled the same way.
  assert.equal(targetOf(resolveLiquidityGraphSchedule(swept, ACCOUNTS)
    .find(r => r.shapeId === null).graph, 'reserve'), 1);

  // A pool absent from a shape is not a special case: there is nothing to scale there.
  // (§10.3 — this is why option (c), "refuse an axis on a partial pool", does not arise.)
  const LATE = { pools: [BASE.pools[0], { ...BASE.pools[2], claims: [{ key: 'usStockAccount' }] }] };
  const partial = { ...SCHEDULED, liquidityShapes: { ...SCHEDULED.liquidityShapes, late: LATE },
                    liquidityGraphSchedule: [{ year: 2030, shape: 'bridge' }, { year: 2040, shape: 'late' }],
                    [SCALE]: 0.5 };
  const late = resolveLiquidityGraphSchedule(partial, ACCOUNTS).find(r => r.shapeId === 'late').graph;
  assert.equal(late.pools.some(p => p.id === 'reserve'), false, 'the bridge pool is gone by then');
  assert.equal(targetOf(resolveLiquidityGraph(partial, ACCOUNTS), 'reserve'), 1, 'and the rest still scaled');
});

test('CTRL-14b the master switch sits in front of the axis, as it does everything else', () => {
  assert.equal(resolveLiquidityGraph({ ...SCHEDULED, [SCALE]: 0.5, liquidityGraphEnabled: false }, ACCOUNTS), null);
  assert.equal(resolveLiquidityGraphSchedule({ ...SCHEDULED, [SCALE]: 0.5, liquidityGraphEnabled: false }, ACCOUNTS), null);
});

test('PTS-5 no second validator: a factor that pushes a spec out of range is REFUSED', () => {
  // §17.2 — the scaled value goes through `normalizeLiquidityGraph` exactly as an authored
  // one does. A PERCENT target is a fraction of the book, so 0.6 × 2 is not silently clamped.
  const pct = { liquidityGraph: { pools: [
    { id: 'reserve', spendOrder: 1, claims: [{ key: 'usStockAccount', sleeves: ['BOND'] }],
      target: { mode: 'PERCENT', value: 0.6 } }] } };
  assert.ok(resolveLiquidityGraph(pct, ACCOUNTS), 'the authored graph compiles');
  assert.throws(() => resolveLiquidityGraph({ ...pct, [SCALE]: 2 }, ACCOUNTS),
    /is a FRACTION of the book/);
});

// ── the axis surface ───────────────────────────────────────────────────────────────────

test('PTS-6 one axis per targeted pool, named by what it multiplies', () => {
  const rows = scalablePoolTargets(SCHEDULED);
  assert.deepEqual(rows.map(r => r.poolId), ['reserve'],
    'only a pool with a numeric target has a level to scale');
  // §6.4 / §10.3 — the label pays the multiplier's legibility cost and says out loud that
  // one factor moves two numbers.
  const label = poolTargetScaleLabel(rows[0]);
  assert.match(label, /base 2y/);
  assert.match(label, /bridge 4y/);
  assert.match(label, /2 shapes/);
  assert.equal(scalablePoolTargets({}).length, 0, 'a plan with no pools offers no axis');
});

test('PTS-7 the generated entry is hidden and compile-only (the BALANCE_TARGET pattern)', () => {
  const entries = ScenarioParamGenerator.generate({ parameters: SCHEDULED });
  const entry = entries.find(e => e.key === SCALE);
  assert.ok(entry, 'the pool axis is generated');
  assert.equal(entry.hidden, true, 'out of the param editor AND out of the persisted cfg.params');
  assert.equal(entry.defaultValue, 1, 'identity is the default');
  assert.equal(entry.node, undefined, 'a pool is not a record; there is nothing to cascade onto');
  assert.equal(entry.opt, 'rate');
  assert.equal(entry.mc, false, 'a reserve size is chosen, not uncertain (design 98 W2)');

  // The AUTHORED graph is what the axis list is built from, so a runner's injected value
  // cannot change which axes exist (`two-param-stores-trap`).
  const swept = { params: [{ name: 'liquidityGraph', value: BASE }],
                  parameters: { liquidityGraph: BASE, [SCALE]: 0.25 } };
  assert.ok(ScenarioParamGenerator.generate(swept).some(e => e.key === SCALE));
  assert.deepEqual(resolvePoolTargetScaleCenters(swept), { [SCALE]: 1 },
    'the plan value of a factor is 1.0 — the lever base has it from nowhere else');
});

test('CTRL-10 a renamed pool takes its axis with it, leaving no row on the old id', () => {
  const renamed = structuredClone(SCHEDULED);
  for (const g of [renamed.liquidityGraph, renamed.liquidityShapes.bridge]) {
    g.pools.find(p => p.id === 'reserve').id = 'bridgeFund';
  }
  const keys = ScenarioParamGenerator.generate({ parameters: renamed }).map(e => e.key);
  assert.ok(keys.includes(poolTargetScaleKey('bridgeFund')));
  assert.equal(keys.includes(SCALE), false, 'no axis pointing at a pool that no longer exists');
});

test('PTS-8 the axis is an optimizer variable and a grid axis on a pooled plan', () => {
  const params = { ...IntlRetirementScenario.buildDefaultConfig({}).parameters, ...SCHEDULED };
  const row = buildOptVariables(params).find(v => v.paramKey === SCALE);
  assert.ok(row, 'the optimizer is offered the reserve size — the household chooses it');
  assert.equal(row.type, OPT_PARAM_TYPES.CONTINUOUS);
  assert.deepEqual([row.min, row.max], [0.5, 2],
    'half it to double it — a harvested `rate` range of 0.98…1.02 would be three identical rollouts');
  assert.equal(row.enabled, false);
  assert.equal(row.controllable, undefined, 'the graph is resolved once; MPC could not actuate it');
  assert.ok(buildGridAxes(params).some(v => v.paramKey === SCALE), 'and it is a grid axis');

  const bare = IntlRetirementScenario.buildDefaultConfig({}).parameters;
  assert.equal(buildOptVariables(bare).some(v => String(v.paramKey).startsWith('pool.')), false,
    'a plan with no pools grows no pool axes');
});

// ── CTRL-8 / CTRL-9 / CTRL-16, on a loaded sim ─────────────────────────────────────────

const SPAN = { simStart: '2026-01-01', simEnd: '2029-01-01', stepTo: '2029-01-01', telemetry: 'off' };
const RUN = {
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
    ],
  },
};

test('CTRL-8 the axis reaches a LOADED sim: two values, two rollouts', () => {
  const plan = loadScenarioSim({ params: RUN, ...SPAN });
  const half = loadScenarioSim({ params: { ...RUN, [SCALE]: 0.5 }, ...SPAN });

  // It arrives at all — the trap `legacy-alias-levers-inert-on-loaded-plan`: a lever that
  // reads as live on the panel and is dropped on the way into the compile.
  assert.equal(half.cfg.parameters[SCALE], 0.5, 'the axis survives buildDefaultConfig');
  assert.equal(half.sim.state.liquidityGraph.pools.find(p => p.id === 'reserve').target.value, 2);
  assert.equal(plan.sim.state.liquidityGraph.pools.find(p => p.id === 'reserve').target.value, 4);

  // And it moves the run: the reserve target is what the rebalancer sizes the bond sleeve to.
  assert.ok(half.sim.state.liquidityPools.reserve.target < plan.sim.state.liquidityPools.reserve.target);
  assert.notEqual(JSON.stringify(half.sim.state), JSON.stringify(plan.sim.state),
    'an axis whose value never reaches the loaded sim is silently inert');
});

test('CTRL-9 the axis does not round-trip — cfg.params keeps the AUTHORED target', () => {
  const { cfg } = loadScenarioSim({ params: { ...RUN, [SCALE]: 0.5 }, ...SPAN });
  assert.equal(cfg.params.some(p => String(p.name).startsWith('pool.')), false,
    'a hidden generated param is never materialized into cfg.params');
  // `ScenarioSerializer` writes `cfg.params` and not `cfg.parameters`, so this IS what a
  // scenario saved mid-sweep reloads at.
  const authored = cfg.params.find(p => p.name === 'liquidityGraph').value;
  assert.equal(targetOf(authored, 'reserve'), 4, 'the author\'s four years, not the swept two');
  assert.equal(targetOf(RUN.liquidityGraph, 'reserve'), 4, 'and the fixture itself is unharmed');
});

test('CTRL-8b the payoff: a pool factor is an MC GRID axis, with a reference cell', async () => {
  // §6.1 — nothing needed inventing downstream, and this is the assertion of that claim: the
  // same key the Opt list offers is scanned by design 100's grid on a loaded plan.
  const { cfg } = loadScenarioSim({ params: RUN, ...SPAN });
  const grid = await new McGridRunner({
    simEnd: new Date(Date.UTC(2029, 0, 1)), cfgTemplate: cfg, mode: GRID_MODES.DETERMINISTIC,
    axes: [{ paramKey: SCALE, values: [0.5, 1, 1.5] }],
  }).run();

  // The plan value of a factor is 1.0 and it comes from `resolvePoolTargetScaleCenters` —
  // nothing else in the lever base carries it, so without that the grid has no plan cell.
  assert.deepEqual(grid.planValues, [1]);
  assert.ok(grid.referenceCell.exact, 'the plan cell is on the grid');
  const nw = grid.cells.map(c => c.rows[0].nw);
  assert.equal(new Set(nw).size, 3, 'three reserve sizes, three worlds');
});

test('CTRL-16 identity: a factor of 1 is byte-identical to no axis at all', () => {
  const a = loadScenarioSim({ params: RUN, ...SPAN });
  const b = loadScenarioSim({ params: { ...RUN, [SCALE]: 1 }, ...SPAN });
  assert.equal(JSON.stringify(b.sim.state), JSON.stringify(a.sim.state));
});

// ── phase 7 — study hygiene (§6.5) ─────────────────────────────────────────────────────

test('CTRL-12 hygiene reports, never repairs', () => {
  // The one assertion §9 spells out for this phase: a live glidepath beside a pool axis
  // produces a problem row AND an unmodified config. Repairing silently would be the app
  // rewriting the author's plan behind a grid — §12.2's one-authority rule broken by a
  // convenience, and a grid nobody can reproduce.
  const cfg = { parameters: { ...SCHEDULED, allocationSchedule: 'GLIDEPATH' } };
  const before = JSON.stringify(cfg);
  const problems = poolAxisProblems(cfg);

  assert.equal(JSON.stringify(cfg), before, 'the config is untouched');
  const row = problems.find(p => p.param === 'allocationSchedule');
  assert.ok(row, 'the glidepath is reported');
  assert.equal(row.kind, POOL_AXIS_PROBLEM_KIND.CONFOUNDED);
  assert.equal(row.severity, 'warn', 'a legal plan must never be blocked from rebuilding');
  assert.deepEqual([row.index, row.field, row.pool, row.shape], [null, null, null, null],
    'a hygiene problem is about the PLAN, not a cell — claiming one would point at the wrong thing');
  assert.match(row.message, /governs the residual/);
  assert.match(row.message, /MOVES as this axis is swept/);
});

test('PTS-9 no pool, no report — and a clean plan reports nothing', () => {
  assert.deepEqual(poolAxisProblems(null), []);
  assert.deepEqual(poolAxisProblems({ parameters: { allocationSchedule: 'GLIDEPATH', shocks: [{}] } }), [],
    'with no scalable pool there is no axis, so there is nothing to warn about');
  assert.deepEqual(poolAxisProblems({ parameters: {
    ...SCHEDULED, allocationSchedule: 'STATIC', shocks: [],
    behavioralStrategies: ['LIQUIDITY_POOLS', 'TARGET_ALLOCATION'],
  } }), [], 'the hygienic plan is silent');
});

test('PTS-10 an axis with no reader is reported as INERT, not as a confound', () => {
  const inertOf = (over) => poolAxisProblems({ parameters: { ...SCHEDULED, ...over } })
    .filter(p => p.kind === POOL_AXIS_PROBLEM_KIND.INERT).map(p => p.param);

  assert.deepEqual(inertOf({ liquidityGraphEnabled: false }), ['liquidityGraphEnabled']);
  // A pool `target` is realised by the rebalancer, so without it the factor is swept and
  // nothing reads it — a flat grid that reads as "the reserve size does not matter".
  assert.deepEqual(inertOf({ behavioralStrategies: ['LIQUIDITY_POOLS'] }), ['behavioralStrategies']);
  assert.deepEqual(inertOf({ behavioralStrategies: ['TARGET_ALLOCATION'] }), ['behavioralStrategies']);
  assert.equal(inertOf({ behavioralStrategies: [] }).length, 2, 'both readers missing, both named');
  // Absent is NOT "none selected" — a partial config takes the permissive reading, exactly as
  // `hasTargetAllocation` does, or every test bag would report two problems it does not have.
  assert.deepEqual(inertOf({}), []);
});

test('PTS-11 the two items pool-arms owns that are NOT already refusals', () => {
  const params = { ...SCHEDULED, behavioralStrategies: ['LIQUIDITY_POOLS', 'TARGET_ALLOCATION'] };
  // §18.4 — a DATED crash is foreseen, which biases exactly this class of timing lever.
  const shockRow = poolAxisProblems({ parameters: { ...params, shocks: [{ severity: 0.3 }] } })
    .find(p => p.param === 'shocks');
  assert.ok(shockRow);
  assert.equal(shockRow.kind, POOL_AXIS_PROBLEM_KIND.CONFOUNDED);
  assert.match(shockRow.message, /FORESEEN/);
  assert.match(shockRow.message, /^1 manufactured shock are|^1 manufactured shock is/,
    'one shock reads as one');

  // YEARS_OF_SPEND is the pool target's own PREDECESSOR, so it gets its own sentence rather
  // than the generic "the mix has a second author".
  const legacy = poolAxisProblems({ parameters: { ...params, allocationSchedule: 'YEARS_OF_SPEND' } })
    .find(p => p.param === 'allocationSchedule');
  assert.match(legacy.message, /predecessor/);
  const regime = poolAxisProblems({ parameters: { ...params, allocationSchedule: 'REGIME_CONDITIONED' } })
    .find(p => p.param === 'allocationSchedule');
  assert.match(regime.message, /REGIME_CONDITIONED/);
  assert.equal(/predecessor/.test(regime.message), false);
});

test('PTS-12 the three items pool-arms owns that ARE already refusals stay refusals', () => {
  // Restating a refusal here would be two derivations of one sentence (§23.6 / §17.2). This
  // asserts the premise that lets `poolAxisProblems` leave them out: each one still REFUSES,
  // so it can never reach a grid in the first place.
  const base = { liquidityGraph: BASE, behavioralStrategies: ['LIQUIDITY_POOLS', 'TARGET_ALLOCATION'] };
  assert.throws(() => resolveLiquidityGraph({ ...base, poolBondYears: 4 }, ACCOUNTS),
    /cannot be combined with `poolCashYears`/);
  assert.throws(() => resolveLiquidityGraph({ ...base, drawdownSequence: [{ key: 'usSavingsAccount' }] }, ACCOUNTS),
    /cannot be combined with an authored `drawdownSequence`/);
  assert.throws(() => resolveLiquidityGraph({ ...base, drawdownMode: 'PROPORTIONAL' }, ACCOUNTS),
    /cannot be combined with drawdownMode PROPORTIONAL/);
  // …and none of them is duplicated as a hygiene row.
  const params = { ...base, poolBondYears: 4, drawdownMode: 'PROPORTIONAL' };
  assert.deepEqual(poolAxisProblems({ parameters: params }), []);
});

test('PTS-13 a target of ZERO grows no axis — a factor cannot lift one off zero', () => {
  // Found by running the axis list against the author's own plan, which carries an `AMOUNT 0`
  // offset pool: `pool.offset.targetScale` read as a lever, swept as a lever, and returned
  // byte-identical rollouts at every value. The same failure `appliesTo` exists for on the
  // record templates, and the one `equity-shift-lever-was-dead` records.
  const zeroed = structuredClone(SCHEDULED);
  for (const g of [zeroed.liquidityGraph, zeroed.liquidityShapes.bridge]) {
    g.pools.find(p => p.id === 'reserve').target = { mode: 'AMOUNT', value: 0 };
  }
  assert.deepEqual(scalablePoolTargets(zeroed), [], 'no level to scale, so no axis');
  assert.deepEqual(resolvePoolTargetScaleCenters({ parameters: zeroed }), {});
  assert.equal(ScenarioParamGenerator.generate({ parameters: zeroed })
    .some(e => e.key === SCALE), false);
  // …and the overlay is a no-op, so nothing clones for nothing either.
  assert.equal(scaleRawPoolGraph(zeroed.liquidityGraph, poolTargetScalesFrom({ [SCALE]: 10 })),
    zeroed.liquidityGraph, 'the caller\'s own object back');

  // Scoped to "no shape authors a non-zero value", never "the base graph is zero". A pool the
  // base holds nothing in and a bridge shape holds years in is genuinely searchable — and is
  // the most interesting kind of pool there is (§10.3's bridge).
  const bridgeOnly = structuredClone(zeroed);
  bridgeOnly.liquidityShapes.bridge.pools.find(p => p.id === 'reserve').target =
    { mode: 'YEARS_OF_SPEND', value: 4 };
  assert.deepEqual(scalablePoolTargets(bridgeOnly).map(r => r.poolId), ['reserve']);
  const scaled = scaleRawPoolShapes(bridgeOnly.liquidityShapes, poolTargetScalesFrom({ [SCALE]: 0.5 }));
  assert.equal(targetOf(scaled.bridge, 'reserve'), 2, 'the shape that holds something scales');
});
