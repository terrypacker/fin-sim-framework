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
 * gate-clause-axis.test.mjs — design 110 leg C, phase 8 (§2.1, §6.3 option A).
 *
 * §20.15 keyed a gate clause by flow id and a branch NUMBER, and the number is a POSITION —
 * `renumberBranches` densely renumbers on every edit. So a threshold had no address and could
 * not be an axis. An optional authored `id` gives one clause one.
 *
 *   CTRL-11  a clause with no id generates NO axis, and one with an id generates exactly one
 *            that survives a branch renumber above it (§2.1). This is the whole content of
 *            option A: an axis that cannot be addressed fails to exist rather than addressing
 *            the wrong clause.
 *   CTRL-8   the axis reaches a LOADED sim — two values, two rollouts
 *   CTRL-9   it does not round-trip
 *   CTRL-16  identity — an unswept plan is byte-identical
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import {
  gateAxisKey, parseGateAxisKey, gateOverridesFrom, applyGateOverridesToGraph,
  applyGateOverridesToShapes, gateClauseAxes, gateAxisLabel, resolveGateAxisCenters,
  GATE_AXIS_FIELD, GATE_THRESHOLD_RANGES, GATE_DWELL_RANGE,
} from '../../src/finance/pools/pool-gate-axis.js';
import { resolveLiquidityGraph, resolveLiquidityGraphSchedule, normalizeLiquidityGraph }
                                  from '../../src/finance/pools/liquidity-graph.js';
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

const THRESH = gateAxisKey('harvest', GATE_AXIS_FIELD.THRESHOLD);
const DWELL  = gateAxisKey('harvest', GATE_AXIS_FIELD.DWELL);

const POOLS = [
  { id: 'cash',    spendOrder: 10, claims: [{ key: 'usSavingsAccount' }],
    target: { mode: 'YEARS_OF_SPEND', value: 1 } },
  { id: 'reserve', spendOrder: 20, claims: [{ key: 'usStockAccount', sleeves: ['BOND'] }],
    target: { mode: 'YEARS_OF_SPEND', value: 4 } },
  { id: 'growth',  spendOrder: 30, claims: [{ key: 'usStockAccount', sleeves: ['EQUITY', 'GOLD', 'CASH'] }] },
];

/** One gate whose single harvest clause carries the address §6.3 adds. */
const IDD = {
  pools: POOLS,
  flows: [{ id: 'g2r', from: 'growth', to: 'reserve',
            gate: { id: 'harvest', sourceDrawdownUnder: 0.05, drawdownBasis: 'INDEX' } }],
};

/** The same graph with no id — what every graph authored before §6.3 means. */
const ANON = { pools: POOLS, flows: [{ id: 'g2r', from: 'growth', to: 'reserve',
                                       gate: { sourceDrawdownUnder: 0.05, drawdownBasis: 'INDEX' } }] };

const gateOf = (graph, flowId) => graph.flows.find(f => f.id === flowId).gate;

// ── the key ────────────────────────────────────────────────────────────────────────────

test('GCA-1 the key parses, is generated, and decodes to NO cascade node', () => {
  assert.equal(THRESH, 'gate.harvest.threshold');
  assert.deepEqual(parseGateAxisKey(THRESH), { clauseId: 'harvest', field: 'threshold' });
  assert.deepEqual(parseGateAxisKey(DWELL),  { clauseId: 'harvest', field: 'dwell' });
  assert.equal(parseGateAxisKey('gate.harvest.value'), null, 'only the two fields');
  assert.equal(parseGateAxisKey('gate.har.vest.dwell'), null,
    'a clause id is dot-free, so the address is unambiguous');
  assert.equal(parseGateAxisKey('pool.reserve.targetScale'), null);

  // In the namespace list, so `set()` writes it FLAT (design 98 W0 /
  // `optimizer-param-key-dot-collision`): outside it the lever is inert in a real solve.
  assert.ok(isGeneratedParamKey(THRESH));
  const bag = {};
  set(bag, THRESH, 0.1);
  assert.deepEqual(bag, { [THRESH]: 0.1 }, 'one flat key, no nested `gate` object');
  assert.equal(get(bag, THRESH), 0.1);
  // A gate clause is not a record, so there is nothing for the loader cascade to fan onto.
  assert.equal(decodeGeneratedParamKey(THRESH), null);
});

// ── CTRL-11, the defining assertion of option A ─────────────────────────────────────────

test('CTRL-11 no id, no axis — and an id survives a branch renumber above it', () => {
  // Half of §6.3's argument: an axis that cannot be addressed FAILS TO EXIST rather than
  // addressing the wrong clause. An anonymous clause is exactly as searchable as it was.
  assert.deepEqual(gateClauseAxes({ liquidityGraph: ANON }), []);
  const keys = ScenarioParamGenerator.generate({ parameters: { liquidityGraph: ANON } })
    .map(e => e.key).filter(k => k.startsWith('gate.'));
  assert.deepEqual(keys, []);

  // The other half. §2.1's defect: the branch number is a POSITION, so inserting a clause
  // ABOVE the id'd one renumbers it — and an axis keyed on (flow, branch, ordinal) would from
  // then on address a different clause, silently.
  const before = { pools: POOLS, flows: [{ id: 'g2r', from: 'growth', to: 'reserve',
    gate: { anyOf: [{ id: 'harvest', sourceDrawdownUnder: 0.05 }] } }] };
  const after = { pools: POOLS, flows: [{ id: 'g2r', from: 'growth', to: 'reserve',
    gate: { anyOf: [
      { sourceReturnOver: 0 },                              // a new FIRST branch
      { id: 'harvest', sourceDrawdownUnder: 0.05 },         // renumbered 1 → 2
    ] } }] };

  for (const graph of [before, after]) {
    const rows = gateClauseAxes({ liquidityGraph: graph });
    assert.deepEqual(rows.map(r => r.clauseId), ['harvest'], 'exactly one axis, before and after');
    // And the override still lands on the clause the author named, not on the one that moved
    // into its old position.
    const moved = applyGateOverridesToGraph(graph, gateOverridesFrom({ [THRESH]: 0.2 }));
    const branches = gateOf(moved, 'g2r').anyOf;
    const idd = branches.find(b => b.id === 'harvest');
    assert.equal(idd.sourceDrawdownUnder, 0.2, 'the named clause moved');
    for (const b of branches.filter(b => b.id !== 'harvest')) {
      assert.equal(b.sourceReturnOver, 0, 'and the anonymous one did not');
    }
  }
});

test('GCA-2 a duplicate id is REFUSED — an address that names two clauses is not one', () => {
  const dup = { pools: POOLS, flows: [
    { id: 'g2r', from: 'growth', to: 'reserve', gate: { id: 'harvest', sourceDrawdownUnder: 0.05 } },
    { id: 'r2c', from: 'reserve', to: 'cash',   gate: { id: 'harvest', sourceReturnOver: 0 } },
  ] };
  assert.throws(() => normalizeLiquidityGraph(dup, ACCOUNTS),
    /gate clause id 'harvest' is used twice — by flow 'g2r' and flow 'r2c'/);

  // Same id twice inside ONE gate is caught too — the walk is over the whole tree.
  const inner = { pools: POOLS, flows: [{ id: 'g2r', from: 'growth', to: 'reserve',
    gate: { anyOf: [{ id: 'h', sourceDrawdownUnder: 0.05 }, { id: 'h', sourceReturnOver: 0 }] } }] };
  assert.throws(() => normalizeLiquidityGraph(inner, ACCOUNTS), /used twice/);
});

test('GCA-3 a malformed id, and an id on a node with nothing to sweep, are refused', () => {
  const withGate = (gate) => ({ pools: POOLS, flows: [{ id: 'g2r', from: 'growth', to: 'reserve', gate }] });
  assert.throws(() => normalizeLiquidityGraph(withGate({ id: 'a.b', sourceReturnOver: 0 }), ACCOUNTS),
    /must be letters, digits/);
  assert.throws(() => normalizeLiquidityGraph(withGate({ id: 'has space', sourceReturnOver: 0 }), ACCOUNTS),
    /must be letters, digits/);
  assert.throws(() => normalizeLiquidityGraph(withGate({ id: 7, sourceReturnOver: 0 }), ACCOUNTS),
    /must be letters, digits/);
  // An id on a node that says nothing would generate an axis that writes onto a node with no
  // condition — every cell identical. Refused, like an empty `anyOf` branch.
  assert.throws(() => normalizeLiquidityGraph(withGate({ id: 'x' }), ACCOUNTS),
    /names a node with no condition/);
});

test('GCA-4 the id reaches the compiled graph, and an anonymous gate is untouched', () => {
  assert.equal(normalizeLiquidityGraph(IDD, ACCOUNTS).flows[0].gate.id, 'harvest');
  // The property that keeps every graph ever authored byte-identical: absent means absent.
  assert.equal('id' in normalizeLiquidityGraph(ANON, ACCOUNTS).flows[0].gate, false);
});

// ── the overlay ────────────────────────────────────────────────────────────────────────

test('GCA-5 identity is free: no override returns the caller\'s own object', () => {
  assert.equal(gateOverridesFrom({}).size, 0);
  assert.equal(gateOverridesFrom({ [DWELL]: 0 }).size, 0, 'a dwell under one year is not a dwell');
  assert.equal(gateOverridesFrom({ [DWELL]: 2.5 }).size, 0, 'nor a fractional one');
  assert.equal(gateOverridesFrom({ [THRESH]: 'x' }).size, 0);
  for (const bag of [{}, { [THRESH]: 'x' }]) {
    assert.equal(applyGateOverridesToGraph(IDD, gateOverridesFrom(bag)), IDD);
  }
  // A write whose value already matches changes nothing, one layer down.
  assert.equal(applyGateOverridesToGraph(IDD, gateOverridesFrom({ [THRESH]: 0.05 })), IDD);
  // An override naming a clause this graph does not have is simply not applied.
  assert.equal(applyGateOverridesToGraph(IDD,
    gateOverridesFrom({ [gateAxisKey('nope', 'threshold')]: 0.2 })), IDD);
});

test('GCA-6 the authored param is never written to — the overlay is a copy', () => {
  const before = JSON.stringify(IDD);
  const out = applyGateOverridesToGraph(IDD, gateOverridesFrom({ [THRESH]: 0.2, [DWELL]: 3 }));
  assert.equal(JSON.stringify(IDD), before, 'the author\'s graph is untouched');
  assert.deepEqual(gateOf(out, 'g2r'),
    { id: 'harvest', sourceDrawdownUnder: 0.2, drawdownBasis: 'INDEX', sustainedYears: 3 });
});

test('GCA-7 a negated row: the dwell rides the `not`, the threshold rides the clause', () => {
  // The two places a dwell can sit under a `not` say different things — "the clause has not
  // held for n years" versus "its negation has held for n years". The id names the second, so
  // it sits on the `not`, and the threshold is resolved one level through it.
  const neg = { pools: POOLS, flows: [{ id: 'g2r', from: 'growth', to: 'reserve',
    gate: { id: 'pause', sustainedYears: 2, not: { sourceDrawdownUnder: 0.05, drawdownBasis: 'INDEX' } } }] };
  const out = applyGateOverridesToGraph(neg, gateOverridesFrom({
    [gateAxisKey('pause', 'threshold')]: 0.15, [gateAxisKey('pause', 'dwell')]: 4 }));
  assert.deepEqual(gateOf(out, 'g2r'), { id: 'pause', sustainedYears: 4,
    not: { sourceDrawdownUnder: 0.15, drawdownBasis: 'INDEX' } });
  assert.equal(gateOf(neg, 'g2r').sustainedYears, 2, 'the authored tree is untouched');

  const row = gateClauseAxes({ liquidityGraph: neg })[0];
  assert.deepEqual([row.kind, row.threshold, row.dwell, row.negated],
    ['sourceDrawdownUnder', 0.05, 2, true]);
  assert.match(gateAxisLabel(row, 'threshold'), /NOT source within 0\.05/);
});

test('GCA-8 a node with two numeric clauses gets a dwell axis and NO threshold axis', () => {
  // Two numeric clauses on one node have no unique threshold, and inventing a winner would make
  // the axis mean something the author never wrote — the rule a multi-class pool target follows.
  const two = { pools: POOLS, flows: [{ id: 'g2r', from: 'growth', to: 'reserve',
    gate: { id: 'both', sourceDrawdownUnder: 0.05, sourceReturnOver: 0 } }] };
  const row = gateClauseAxes({ liquidityGraph: two })[0];
  assert.equal(row.kind, null);
  assert.equal(row.threshold, null);

  const keys = ScenarioParamGenerator.generate({ parameters: { liquidityGraph: two } })
    .map(e => e.key).filter(k => k.startsWith('gate.'));
  assert.deepEqual(keys, [gateAxisKey('both', 'dwell')], 'the dwell is still addressable');
  // …and a threshold override on it is a no-op rather than a guess.
  assert.equal(applyGateOverridesToGraph(two,
    gateOverridesFrom({ [gateAxisKey('both', 'threshold')]: 0.2 })), two);
});

test('GCA-9 the overlay works on a gate the EDITOR cannot draw', () => {
  // The seam is the raw tree, not the DNF subset the clause table renders, so an id'd clause
  // inside an OR-under-an-AND (a `rawGate` case) is still addressable. That is a property of
  // applying the overlay in front of the normalizer rather than in the editor's row model.
  const nested = { pools: POOLS, flows: [{ id: 'g2r', from: 'growth', to: 'reserve',
    gate: { allOf: [
      { sourceReturnOver: 0 },
      { anyOf: [{ id: 'deep', sourceDrawdownUnder: 0.05 }, { targetDrawdownOver: 0.3 }] },
    ] } }] };
  assert.deepEqual(gateClauseAxes({ liquidityGraph: nested }).map(r => r.clauseId), ['deep']);
  const out = applyGateOverridesToGraph(nested,
    gateOverridesFrom({ [gateAxisKey('deep', 'threshold')]: 0.02 }));
  assert.equal(gateOf(out, 'g2r').allOf[1].anyOf[0].sourceDrawdownUnder, 0.02);
  assert.equal(gateOf(out, 'g2r').allOf[0].sourceReturnOver, 0, 'siblings untouched');
  assert.ok(normalizeLiquidityGraph(gateOf(out, 'g2r') && out, ACCOUNTS), 'and it still compiles');
});

test('GCA-10 one id moves the clause in every shape that contains it', () => {
  // §6.4's rule, applied to a clause: a pool id spans shapes deliberately (design 109 §9) and a
  // clause id follows the same rule, which is why uniqueness is WITHIN a graph.
  const bridge = structuredClone(IDD);
  bridge.flows[0].gate.sourceDrawdownUnder = 0.10;
  const params = { liquidityGraph: IDD, liquidityShapes: { bridge },
                   liquidityGraphSchedule: [{ year: 2030, shape: 'bridge' }], [THRESH]: 0.02 };

  assert.equal(resolveLiquidityGraph(params, ACCOUNTS).flows[0].gate.sourceDrawdownUnder, 0.02);
  const rows = resolveLiquidityGraphSchedule(params, ACCOUNTS);
  assert.equal(rows.find(r => r.shapeId === 'bridge').graph.flows[0].gate.sourceDrawdownUnder, 0.02);
  assert.equal(rows.find(r => r.shapeId === null).graph.flows[0].gate.sourceDrawdownUnder, 0.02);

  // The label has to say so — the reader should not have to infer that one key moves two gates.
  const row = gateClauseAxes(params).find(r => r.clauseId === 'harvest');
  assert.match(gateAxisLabel(row, 'threshold'), /one key, 2 shapes/);

  const shaped = applyGateOverridesToShapes({ bridge }, gateOverridesFrom({ [THRESH]: 0.02 }));
  assert.equal(shaped.bridge.flows[0].gate.sourceDrawdownUnder, 0.02);
  assert.equal(bridge.flows[0].gate.sourceDrawdownUnder, 0.10, 'the shape map is copied, not edited');
});

test('GCA-11 the master switch sits in front of the axis', () => {
  assert.equal(resolveLiquidityGraph({ liquidityGraph: IDD, [THRESH]: 0.2,
                                       liquidityGraphEnabled: false }, ACCOUNTS), null);
});

// ── the axis surface ───────────────────────────────────────────────────────────────────

test('GCA-12 the generated entries are hidden, compile-only, and centred on the CLAUSE', () => {
  const entries = ScenarioParamGenerator.generate({ parameters: { liquidityGraph: IDD } });
  const th = entries.find(e => e.key === THRESH);
  const dw = entries.find(e => e.key === DWELL);
  for (const e of [th, dw]) {
    assert.ok(e);
    assert.equal(e.hidden, true, 'out of the editor AND out of the persisted cfg.params');
    assert.equal(e.node, undefined, 'a gate clause is not a record');
    assert.equal(e.mc, false, 'a harvest rule is chosen, not uncertain (design 98 W2)');
  }
  // Unlike the pool factor's fixed 1.0, a threshold has no natural identity: its plan value is
  // whatever the clause says, re-seeded from the graph on every Rebuild.
  assert.equal(th.defaultValue, 0.05);
  assert.equal(dw.defaultValue, 1, 'the dwell default is one year, which normalizeGate drops');
  assert.equal(dw.type, 'Integer', 'years, never periods (§20.15)');

  assert.deepEqual(resolveGateAxisCenters(null, { liquidityGraph: IDD }),
    { [THRESH]: 0.05, [DWELL]: 1 });
});

test('GCA-13 both axes are optimizer variables and grid axes, with per-kind ranges', () => {
  const params = { ...IntlRetirementScenario.buildDefaultConfig({}).parameters, liquidityGraph: IDD };
  const th = buildOptVariables(params).find(v => v.paramKey === THRESH);
  const dw = buildOptVariables(params).find(v => v.paramKey === DWELL);
  assert.ok(th && dw);
  assert.equal(th.type, OPT_PARAM_TYPES.CONTINUOUS);
  // ABSOLUTE and per kind: §20.13 swept 1%, 5% and 10% — a factor of ten — which a ±0.02 band
  // around the authored value would not reach at either end.
  assert.deepEqual([th.min, th.max], [GATE_THRESHOLD_RANGES.sourceDrawdownUnder.min,
                                      GATE_THRESHOLD_RANGES.sourceDrawdownUnder.max]);
  assert.equal(dw.type, OPT_PARAM_TYPES.INTEGER);
  assert.deepEqual([dw.min, dw.max], [GATE_DWELL_RANGE.min, GATE_DWELL_RANGE.max]);
  assert.equal(th.enabled, false);
  assert.ok(buildGridAxes(params).some(v => v.paramKey === THRESH));

  const bare = IntlRetirementScenario.buildDefaultConfig({}).parameters;
  assert.equal(buildOptVariables(bare).some(v => String(v.paramKey).startsWith('gate.')), false,
    'a plan with no id\'d clause grows no gate axes');
});

// ── CTRL-8 / CTRL-9 / CTRL-16, on a loaded sim ─────────────────────────────────────────

const SPAN = { simStart: '2026-01-01', simEnd: '2030-01-01', stepTo: '2030-01-01', telemetry: 'off' };
const RUN = {
  behavioralStrategies: ['LIQUIDITY_POOLS', 'TARGET_ALLOCATION'],
  liquidityGraph: {
    pools: POOLS,
    flows: [
      { id: 'r2c', from: 'reserve', to: 'cash',    trigger: { belowTargetFraction: 0.5 } },
      { id: 'g2r', from: 'growth',  to: 'reserve',
        gate: { id: 'harvest', sourceDrawdownUnder: 0.05, drawdownBasis: 'INDEX' } },
    ],
  },
};

test('CTRL-8 the gate axis reaches a LOADED sim: two thresholds, two rollouts', () => {
  const plan  = loadScenarioSim({ params: RUN, ...SPAN });
  const tight = loadScenarioSim({ params: { ...RUN, [THRESH]: 0.01 }, ...SPAN });

  // It arrives at all — the trap `legacy-alias-levers-inert-on-loaded-plan` /
  // `pool-axis-dropped-by-toolset-forwarding`, asserted separately from the effect because
  // those are two different failures and only this one names the cause.
  assert.equal(tight.cfg.parameters[THRESH], 0.01, 'the axis survives buildDefaultConfig');
  const gateIn = (s) => s.liquidityGraph.flows.find(f => f.id === 'g2r').gate;
  assert.equal(gateIn(tight.sim.state).sourceDrawdownUnder, 0.01);
  assert.equal(gateIn(plan.sim.state).sourceDrawdownUnder, 0.05);
  assert.notEqual(JSON.stringify(tight.sim.state), JSON.stringify(plan.sim.state),
    'a tighter harvest gate must not end on the same state');
});

test('CTRL-8b the DWELL axis reaches the loaded sim too — §20.13\'s lever', () => {
  const plan = loadScenarioSim({ params: RUN, ...SPAN });
  const held = loadScenarioSim({ params: { ...RUN, [DWELL]: 3 }, ...SPAN });
  const gateIn = (s) => s.liquidityGraph.flows.find(f => f.id === 'g2r').gate;
  assert.equal(gateIn(held.sim.state).sustainedYears, 3);
  assert.equal(gateIn(plan.sim.state).sustainedYears, undefined, 'a dwell of 1 is dropped');
  assert.notEqual(JSON.stringify(held.sim.state), JSON.stringify(plan.sim.state));
});

test('CTRL-9 the gate axis does not round-trip — cfg.params keeps the AUTHORED threshold', () => {
  const { cfg } = loadScenarioSim({ params: { ...RUN, [THRESH]: 0.01 }, ...SPAN });
  assert.equal(cfg.params.some(p => String(p.name).startsWith('gate.')), false,
    'a hidden generated param is never materialized into cfg.params');
  // `ScenarioSerializer` writes `cfg.params`, not `cfg.parameters`, so this IS what a scenario
  // saved mid-sweep reloads at.
  const authored = cfg.params.find(p => p.name === 'liquidityGraph').value;
  assert.equal(authored.flows.find(f => f.id === 'g2r').gate.sourceDrawdownUnder, 0.05);
  assert.equal(RUN.liquidityGraph.flows[1].gate.sourceDrawdownUnder, 0.05, 'the fixture is unharmed');
});

test('CTRL-16 identity: an id costs nothing, and an unswept plan is byte-identical', () => {
  const idd  = loadScenarioSim({ params: RUN, ...SPAN });
  const same = loadScenarioSim({ params: { ...RUN, [THRESH]: 0.05, [DWELL]: 1 }, ...SPAN });
  assert.equal(JSON.stringify(same.sim.state), JSON.stringify(idd.sim.state),
    'writing a clause its own values back is identity');

  // And an id'd clause runs exactly as the same clause without one: the id is an address, never
  // a condition, so adding one to search a gate must not change what the gate does.
  const anon = structuredClone(RUN);
  delete anon.liquidityGraph.flows[1].gate.id;
  const a = loadScenarioSim({ params: anon, ...SPAN });
  // Identical modulo the one id token, which `normalizeGate` carries onto the compiled gate so
  // the state says which clause an axis addresses. Compared as text rather than by cloning one
  // side: `deepStrictEqual` compares prototypes, and `structuredClone` would strip the account
  // classes off whichever state was cloned.
  const strip = (s) => JSON.stringify(s)
    .replaceAll('"id":"harvest",', '').replaceAll(',"id":"harvest"', '');
  assert.equal(strip(idd.sim.state), strip(a.sim.state));
});
