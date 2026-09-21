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
 * mpc-rollout-inforce-decisions.test.mjs
 *
 * DESIGN 39 §14.10 — a rollout on a scenario PLAYING a recorded run must price the policy the
 * run has put in force, not the authored one.
 *
 * The derivation manifest keeps drawdown-policy state from the rollout's compile, and the
 * compile reads params. With a run active those params are the AUTHORED values while the run's
 * past rows are the policy the snapshot carries, and the rollout's decision reducer inherits
 * the snapshot's `throughMs`, so it never re-stamps. Before `foldInForceDecisions` every
 * non-decided drawdown field reverted to its authored value for the rest of the rollout.
 *
 * IFD-1  the fold: the latest row per key strictly before now, `rowsAreParams` levers only
 * IFD-2  a rollout keeps the run's in-force policy, and the no-op is exact against the snapshot
 * IFD-3  the candidate still wins for the lever being decided; the others keep the run's value
 * IFD-4  per-account drawdownPriority from a recorded DRAWDOWN_WEIGHTS row survives too
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import { OptimizationProblem }     from '../../src/finance/optimization/optimization-problem.js';
import { OPTIMIZATION_OBJECTIVES } from '../../src/finance/optimization/optimization-objectives.js';
import { CockpitController, COCKPIT_CONTROLS } from '../../src/finance/mpc/cockpit-controller.js';
import { foldInForceDecisions }    from '../../src/finance/mpc/lever-schedule.js';
import { yearKey }                 from '../../src/finance/mpc/lever-schedule.js';
import { DRAWDOWN_WEIGHT_ROLES, drawdownWeightKey, DRAWDOWN_WEIGHT_MODE }
  from '../../src/scenarios/params/lever-weights.js';

const SIM_START = new Date(Date.UTC(2026, 0, 1));
const SIM_END   = new Date(Date.UTC(2060, 0, 1));
const DECIDED   = new Date(Date.UTC(2040, 0, 1)).toISOString();
const AS_OF     = new Date(Date.UTC(2045, 0, 1));
const OBJECTIVE = OPTIMIZATION_OBJECTIVES.MAX_NET_WORTH;

const run = (decisions) => ({ r: { decisions } });

/** Not pooled, so the drawdown levers are live. The run changes two policies in 2040. */
const BASE = {
  spendingStrategy:     ['EXPLICIT_BANDS'],
  spendingExpenseBands: [{ startAge: 45, monthlyAmount: 9000 }],
  crossBorderDrawdown: 'LOCAL_FIRST',
  withinTierDraw:      'SEQUENTIAL',
  mpcRuns: run([
    { date: DECIDED, lever: 'DRAWDOWN_XBORDER',    key: 'crossBorderDrawdown', value: 'GLOBAL' },
    { date: DECIDED, lever: 'DRAWDOWN_WITHINTIER', key: 'withinTierDraw',      value: 'PROPORTIONAL' },
  ]),
  mpcActiveRun: 'r',
};

const quiet = (fn) => {
  const l = console.log, w = console.warn;
  console.log = () => {}; console.warn = () => {};
  try { return fn(); } finally { console.log = l; console.warn = w; }
};

const problem = (params, initialState) => new OptimizationProblem({
  variables: [], baseParams: params, objective: OBJECTIVE,
  simStart: SIM_START, simEnd: SIM_END, initialState,
});

/** A snapshot of the scenario PLAYING its run, taken at AS_OF. */
const snapshotOf = (params) => quiet(() =>
  problem(params, { kind: 'compile', cfgTemplate: null }).rollToSnapshot({}, AS_OF));

/** The sim a cockpit rollout starts from, with `candidate` laid over the controller's params. */
function rolloutStart(params, snap, candidate = {}) {
  return quiet(() => {
    const c = new CockpitController({ simStart: SIM_START, simEnd: SIM_END, baseParams: params,
      objective: OBJECTIVE, control: COCKPIT_CONTROLS.DRAWDOWN_XBORDER });
    c.setSnapshot(snap);
    const p = problem(c._rolloutParams(), { kind: 'snapshot', snapshot: snap, cfgTemplate: null });
    return p._seededSim({ ...p._resolveBase(), endDate: SIM_END, ...candidate });
  });
}

// ─── IFD-1 ───────────────────────────────────────────────────────────────────

test('IFD-1: the fold takes the latest row per key before now, rowsAreParams levers only', () => {
  const later = new Date(Date.UTC(2050, 0, 1)).toISOString();
  const params = { ...BASE, mpcRuns: run([
    ...BASE.mpcRuns.r.decisions,
    { date: later,   lever: 'DRAWDOWN_XBORDER', key: 'crossBorderDrawdown', value: 'LOCAL_FIRST' },
    { date: DECIDED, lever: 'ROTH',             key: yearKey(2041),          value: 50_000 },
  ]) };
  const out = foldInForceDecisions(params, AS_OF);
  assert.equal(out.crossBorderDrawdown, 'GLOBAL', 'the 2050 row is after now');
  assert.equal(out.withinTierDraw, 'PROPORTIONAL');
  assert.equal(out[yearKey(2041)], undefined, 'ROTH folds at compile, never as a param');
  assert.equal(params.crossBorderDrawdown, 'LOCAL_FIRST', 'the caller\'s bag is not mutated');

  const noRun = { ...BASE, mpcActiveRun: null };
  assert.equal(foldInForceDecisions(noRun, AS_OF), noRun, 'no active run, no copy');
  const before = foldInForceDecisions(BASE, new Date(Date.UTC(2039, 0, 1)));
  assert.equal(before, BASE, 'nothing in force yet, no copy');
});

// ─── IFD-2 ───────────────────────────────────────────────────────────────────

test('IFD-2: a rollout keeps the run\'s in-force policy, and the no-op is exact', () => {
  const snap = snapshotOf(BASE);
  assert.equal(snap.state.crossBorderDrawdown, 'GLOBAL', 'fixture: the run must have applied by AS_OF');
  assert.equal(snap.state.withinTierDraw, 'PROPORTIONAL');

  const st = rolloutStart(BASE, snap).state;
  assert.equal(st.crossBorderDrawdown, 'GLOBAL', 'reverted to the authored LOCAL_FIRST');
  assert.equal(st.withinTierDraw, 'PROPORTIONAL', 'reverted to the authored SEQUENTIAL');
  assert.equal(JSON.stringify(st), JSON.stringify(snap.state),
    'a rollout of the unchanged plan starts from exactly the snapshot');
});

// ─── IFD-3 ───────────────────────────────────────────────────────────────────

test('IFD-3: the candidate still wins for the lever being decided', () => {
  const snap = snapshotOf(BASE);
  const st = rolloutStart(BASE, snap, { crossBorderDrawdown: 'LOCAL_FIRST' }).state;
  assert.equal(st.crossBorderDrawdown, 'LOCAL_FIRST', 'the decision at now beats the run\'s past');
  assert.equal(st.withinTierDraw, 'PROPORTIONAL', 'and the undecided lever keeps the run\'s value');
});

// ─── IFD-4 ───────────────────────────────────────────────────────────────────

test('IFD-4: per-account drawdownPriority from a recorded DRAWDOWN_WEIGHTS row survives', () => {
  // The per-account case: `*.drawdownPriority` is a manifest t₀ pick compiled from the weight
  // params, so it reverted to the AUTHORED weights' order exactly like the scalar fields.
  const role = DRAWDOWN_WEIGHT_ROLES[DRAWDOWN_WEIGHT_ROLES.length - 1];
  const weighted = { ...BASE, drawdownStrategy: DRAWDOWN_WEIGHT_MODE,
    mpcRuns: run([{ date: DECIDED, lever: 'DRAWDOWN_WEIGHTS', key: drawdownWeightKey(role), value: 1000 }]) };
  const priorities = (st) => Object.fromEntries(Object.entries(st)
    .filter(([, v]) => v && typeof v === 'object' && !Array.isArray(v) && 'drawdownPriority' in v)
    .map(([k, v]) => [k, v.drawdownPriority]));

  const snap = snapshotOf(weighted);
  const authored = quiet(() => {
    const p = problem({ ...weighted, mpcActiveRun: null }, { kind: 'compile', cfgTemplate: null });
    return p._seededSim({ ...p._resolveBase(), endDate: SIM_END }).state;
  });
  assert.notDeepEqual(priorities(snap.state), priorities(authored),
    'fixture: the recorded weight must change the order, or this case tests nothing');
  assert.deepEqual(priorities(rolloutStart(weighted, snap).state), priorities(snap.state));
});
