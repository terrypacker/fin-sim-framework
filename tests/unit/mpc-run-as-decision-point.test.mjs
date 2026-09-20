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
 * mpc-run-as-decision-point.test.mjs
 *
 * DESIGN 81 phase 8 — **the §4.2 gate**, and the one design 81 §13 singles out:
 *
 *   *"If this passes, the whole analysis surface reaches MPC runs with no further work;
 *    if it is missing, the indirection's main justification is unproven."*
 *
 * The indirection under test is §4.1's: a bag of runs plus a SCALAR selector, rather than one
 * flat `mpcDecisionSchedule` array. The scalar is the whole argument — `DecisionPoint.options`
 * are `{value, label}` pairs and `makeLeafEntry` writes `p.value = leafParams[p.name]`, so a
 * run id is a perfect option value and a four-hundred-row array is not.
 *
 * MDP-1  The bag IS the candidate set — `mpcRunOptions`, labelled from `source`
 * MDP-2  A `DecisionPoint` over `mpcActiveRun` expands to one leaf per run, plus the control
 * MDP-3  `makeLeafEntry` writes the selection into each leaf's params, untouched machinery
 * MDP-4  **The gate**: the leaves produce DIFFERENT results — the axis is live, not decorative
 * MDP-5  The optimizer's ENUM over the bag (§9), and why the schema flag stays `opt: false`
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import { mpcRunOptions }      from '../../src/finance/mpc/run-schedule.js';
import { DecisionGraphRunner } from '../../src/finance/decision-graph/decision-graph-runner.js';
import { DecisionPoint }      from '../../src/finance/decision-graph/decision-graph-models.js';
import { makeLeafEntry }      from '../../src/finance/decision-graph/leaf-entry.js';
import { buildOptVariables }  from '../../src/finance/optimization/intl-retirement-opt-config.js';
import { IntlRetirementScenario } from '../../src/scenarios/intl-retirement-scenario.js';
import { loadScenarioSim }    from '../helpers/scenario-harness.js';

const SIM_START = new Date(Date.UTC(2026, 0, 1));
const SIM_END   = new Date(Date.UTC(2040, 0, 1));

/** Primary is born 1978-04-15, so a band starting at 55 opens in 2033. */
const BASE_BANDS = [{ startAge: 48, monthlyAmount: 4000 }];

const runEntry = (amount, levers = ['SPENDING']) => ({
  source: { recordedAt: '2026-09-20T00:00:00.000Z', levers, epochs: 1, solver: 'CEM/128' },
  decisions: [{ date: '2033-04-15T00:00:00.000Z', lever: 'SPENDING', key: 'band@55', value: amount }],
});

const BAG = () => ({ 'run:thrifty': runEntry(5000), 'run:lavish': runEntry(14000) });

const PARAMS = {
  spendingStrategy: ['EXPLICIT_BANDS'], spendingExpenseBands: BASE_BANDS,
  mpcRuns: BAG(),
};

// ─── MDP-1 ───────────────────────────────────────────────────────────────────

test('MDP-1: the bag IS the candidate set, labelled from `source`', () => {
  const options = mpcRunOptions(PARAMS);
  assert.deepEqual(options.map(o => o.value), [null, 'run:thrifty', 'run:lavish']);
  // A raw run id is not a choice anyone can make (§8).
  assert.match(options[1].label, /run:thrifty — 1 lever · CEM\/128 · 2026-09-20 · 1 epoch/);
  // The control rides the SAME param as the arms — a null selection — so it differs from each
  // of them in exactly one value, which is what a decision point gives for free.
  assert.equal(options[0].value, null);
});

test('MDP-1: a plan with no runs offers nothing, rather than a blank option', () => {
  assert.deepEqual(mpcRunOptions({}), []);
  assert.deepEqual(mpcRunOptions({ mpcRuns: {} }), []);
  // With `includeNone: false` the control is dropped — for a caller that supplies its own.
  assert.deepEqual(mpcRunOptions(PARAMS, { includeNone: false }).map(o => o.value),
    ['run:thrifty', 'run:lavish']);
});

// ─── MDP-2 / MDP-3 ───────────────────────────────────────────────────────────

test('MDP-2: a DecisionPoint over `mpcActiveRun` expands to one leaf per option', () => {
  const dp = new DecisionPoint({
    id: 'mpcActiveRun', label: 'Recorded MPC run', paramKey: 'mpcActiveRun',
    options: mpcRunOptions(PARAMS).map(o => ({ value: o.value, label: o.label })),
  });
  // `_expandLeaves` is the runner's own cartesian product — exercised directly because the
  // claim is about the EXPANSION, and running three Monte Carlo fans to prove it would test
  // something else and take minutes.
  const leaves = new DecisionGraphRunner({ scenarioRegistry: null })._expandLeaves([dp]);
  assert.equal(leaves.length, 3);
  assert.deepEqual(leaves.map(l => l.params.mpcActiveRun), [null, 'run:thrifty', 'run:lavish']);
  assert.match(leaves[1].label, /Recorded MPC run=run:thrifty/);
});

test('MDP-3: `makeLeafEntry` writes the selection into each leaf — untouched machinery', () => {
  const baseEntry = {
    id: 'base', name: 'Base', layer: 'scenario',
    params: [{ name: 'mpcActiveRun', type: 'MpcRunSelect', value: null },
             { name: 'inflationRate', type: 'Number', value: 0.03 }],
  };
  const leaf = { label: 'run:lavish', params: { mpcActiveRun: 'run:lavish' } };
  const entry = makeLeafEntry(baseEntry, leaf, 'dg-leaf:1');

  assert.equal(entry.params.find(p => p.name === 'mpcActiveRun').value, 'run:lavish');
  assert.equal(entry.params.find(p => p.name === 'inflationRate').value, 0.03, 'nothing else moves');
  // The base is not corrupted — leaves are built from it repeatedly.
  assert.equal(baseEntry.params.find(p => p.name === 'mpcActiveRun').value, null);
});

// ─── MDP-4 — the gate ────────────────────────────────────────────────────────

test('MDP-4: THE GATE — the three leaves produce three different results', () => {
  // If this fails, the bag/selector indirection is decorative: the analysis surface would
  // "support" recorded runs while every arm ran the same plan. Deliberately NOT asserting an
  // amount — the claim is that the axis MOVES the simulation, which is what makes every
  // consumer in §9 (decision graph, MC, optimizer, compare, variant.mjs) work for free.
  const worthOf = (mpcActiveRun) => loadScenarioSim({
    params: { ...PARAMS, mpcActiveRun },
    simStart: SIM_START, simEnd: SIM_END, stepTo: SIM_END, telemetry: 'off',
  }).sim.state.metrics?.netWorth;

  const base    = worthOf(null);
  const thrifty = worthOf('run:thrifty');
  const lavish  = worthOf('run:lavish');

  assert.ok(Number.isFinite(base) && Number.isFinite(thrifty) && Number.isFinite(lavish));
  assert.equal(new Set([base, thrifty, lavish]).size, 3,
    `each arm must be its own plan — base=${base} thrifty=${thrifty} lavish=${lavish}`);
  // And in the direction the decisions say: spending less leaves more.
  assert.ok(thrifty > lavish, `thrifty=${thrifty} should out-terminal lavish=${lavish}`);
  assert.ok(base > lavish, 'the base band is 4000/mo, below both recorded decisions at 55');
});

// ─── MDP-5 ───────────────────────────────────────────────────────────────────

test('MDP-5: the optimizer gets an ENUM over the bag (§9), labelled, and off by default', () => {
  const [v] = buildOptVariables(PARAMS).filter(x => x.paramKey === 'mpcActiveRun');
  assert.ok(v, 'the contributor must offer the axis when the plan carries runs');
  assert.equal(v.type, 'enum');
  assert.deepEqual(v.values, [null, 'run:thrifty', 'run:lavish']);
  assert.match(v.labels[1], /run:thrifty/);
  assert.equal(v.enabled, false, 'offered, not switched on — it costs a full search dimension');
});

test('MDP-5: no runs ⇒ no axis, because a zero-value ENUM is the dead-lever failure', () => {
  assert.equal(buildOptVariables({}).filter(x => x.paramKey === 'mpcActiveRun').length, 0);
  // One run and no control would also be a flat dimension; the control is what makes two.
  assert.equal(
    buildOptVariables({ mpcRuns: { only: runEntry(5000) } })
      .filter(x => x.paramKey === 'mpcActiveRun')[0]?.values.length, 2);
});

test('MDP-5: the SCHEMA entry stays `opt: false`, and that is the honest answer', () => {
  // This param's sweepability is a property of the SCENARIO, not of the schema: it is
  // searchable on a plan carrying runs and on no other. The schema is plan-independent, so
  // `opt: true` would be a promise no panel can keep on an empty bag — which is exactly what
  // SWEEP-18 refuses. The curated row above is `synthetic` in that gate's sense: it is not
  // DERIVED from the schema entry, because its values are scenario data.
  const entry = IntlRetirementScenario.buildFullParamSchema().find(e => e.key === 'mpcActiveRun');
  assert.equal(entry.type, 'MpcRunSelect');
  assert.equal(entry.opt, false);
  assert.equal(entry.mc, false, 'a recorded run is not a distribution — "MC this plan" is a selection');
});
