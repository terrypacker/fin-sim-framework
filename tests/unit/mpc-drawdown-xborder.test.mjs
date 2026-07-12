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
 * mpc-drawdown-xborder.test.mjs
 *
 * Design 58 §11.3 Phase 1-MPC — Lever A online (DRAWDOWN_XBORDER cockpit control).
 *
 *   1. The control spec: categorical variable, describe, forward-effective actuate.
 *   2. The projection shim: a committed crossBorderDrawdown candidate BITES under a
 *      snapshot-seeded rollout (the MPC path), not just the one-shot compile path.
 *      This is the headless twin of scripts/verify-mpc-lever.mjs — it guards the
 *      _seededSim re-stamp so the §11.1 gap (injection clobbering the control)
 *      cannot silently return.
 *
 * Run with: node --test tests/unit/mpc-drawdown-xborder.test.mjs
 */

import { test }   from 'node:test';
import assert     from 'node:assert/strict';

import { COCKPIT_CONTROLS } from '../../src/finance/mpc/cockpit-controller.js';
import { makeInitialSnapshot } from '../../src/finance/mpc/mpc-controller.js';
import { OptimizationProblem } from '../../src/finance/optimization/optimization-problem.js';
import { OPT_PARAM_TYPES, OPTIMIZATION_OBJECTIVES } from '../../src/finance/optimization/optimization-objectives.js';
import { DRAWDOWN_WEIGHT_ROLES, drawdownWeightKey } from '../../src/scenarios/intl-retirement-scenario.js';
import { ACCOUNT_ROLES } from '../../src/finance/state/account-roles.js';

const XB = COCKPIT_CONTROLS.DRAWDOWN_XBORDER;

// Silence the sim's per-run console chatter around a heavy rollout call.
function quiet(fn) {
  const l = console.log, w = console.warn;
  console.log = () => {}; console.warn = () => {};
  try { return fn(); } finally { console.log = l; console.warn = w; }
}

// ─── Control spec ─────────────────────────────────────────────────────────────

test('DRAWDOWN_XBORDER: categorical variable over the crossBorderDrawdown field', () => {
  assert.strictEqual(XB.numeric, false);
  assert.strictEqual(XB.appliesTo(), true);
  const vars = XB.buildVariables({});
  assert.strictEqual(vars.length, 1);
  assert.strictEqual(vars[0].paramKey, 'crossBorderDrawdown');
  assert.strictEqual(vars[0].type, OPT_PARAM_TYPES.ENUM);
  assert.deepStrictEqual(vars[0].values, ['LOCAL_FIRST', 'GLOBAL']);
});

test('DRAWDOWN_XBORDER: describe labels each mode', () => {
  const vars = XB.buildVariables({});
  assert.match(XB.describe({ crossBorderDrawdown: 'GLOBAL' }, vars), /global/i);
  assert.match(XB.describe({ crossBorderDrawdown: 'LOCAL_FIRST' }, vars), /residence country first/i);
});

test('DRAWDOWN_XBORDER: actuate re-stamps the live sim state + persists the param', () => {
  const vars = XB.buildVariables({});
  const sim = { state: { crossBorderDrawdown: 'LOCAL_FIRST', foo: 1 } };
  const services = { simulationRegistry: { getPrimary: () => sim } };
  const scenario = { params: [{ name: 'crossBorderDrawdown', value: 'LOCAL_FIRST' }] };

  const ok = XB.actuate({ services, scenario, candidate: { crossBorderDrawdown: 'GLOBAL' }, vars });
  assert.strictEqual(ok, true);
  assert.strictEqual(sim.state.crossBorderDrawdown, 'GLOBAL');   // forward-effective re-stamp
  assert.strictEqual(sim.state.foo, 1);                          // rest of state preserved
  assert.strictEqual(scenario.params[0].value, 'GLOBAL');        // persisted for Advise/Rebuild
});

test('DRAWDOWN_XBORDER: actuate rejects a bogus mode', () => {
  const vars = XB.buildVariables({});
  const sim = { state: { crossBorderDrawdown: 'LOCAL_FIRST' } };
  const services = { simulationRegistry: { getPrimary: () => sim } };
  const ok = XB.actuate({ services, scenario: { params: [] }, candidate: { crossBorderDrawdown: 'NOPE' }, vars });
  assert.strictEqual(ok, false);
  assert.strictEqual(sim.state.crossBorderDrawdown, 'LOCAL_FIRST');   // untouched
});

// ─── Projection shim: the control bites under MPC (snapshot-seeded rollout) ────

// Post-move (2031), just-after-retirement "now" + moderate spend + CUSTOM authored
// order, so the forward window drains investments across the border and the mode
// controls which accounts are preserved into the bequest (see verify-mpc-lever.mjs).
const SIM_START = new Date(Date.UTC(2026, 0, 1));
const SIM_END   = new Date(Date.UTC(2050, 0, 1));
const NOW       = new Date(Date.UTC(2041, 0, 1));
const BASE      = { monthlyExpenses: 12_000, drawdownStrategy: 'CUSTOM' };

function snapshotNW(snapshot, mode) {
  const problem = new OptimizationProblem({
    variables: [], baseParams: BASE, objective: OPTIMIZATION_OBJECTIVES.MAX_NET_WORTH,
    simStart: SIM_START, simEnd: SIM_END, initialState: { kind: 'snapshot', snapshot },
  });
  return problem.evaluate({ crossBorderDrawdown: mode }).result.finalNetWorthUsd;
}

test('DRAWDOWN_XBORDER: a committed mode bites under a snapshot-seeded rollout (§11.1 shim)', () => {
  quiet(() => {
    const snapshot = makeInitialSnapshot({ simStart: SIM_START, simEnd: SIM_END, asOfDate: NOW, baseParams: BASE });
    const local  = snapshotNW(snapshot, 'LOCAL_FIRST');
    const global = snapshotNW(snapshot, 'GLOBAL');
    // Without the _seededSim re-stamp these are byte-identical (injection clobbers
    // the control). The shim makes the committed candidate actually change the
    // MPC rollout — the whole point of design 58 §11.
    assert.ok(Math.abs(local - global) > 1,
      `crossBorderDrawdown is inert under MPC: LOCAL_FIRST ${Math.round(local)} === GLOBAL ${Math.round(global)}`);
  });
});

// ─── Phase 2-MPC — Lever C online (DRAWDOWN_WITHINTIER) ───────────────────────

const WT = COCKPIT_CONTROLS.DRAWDOWN_WITHINTIER;

test('DRAWDOWN_WITHINTIER: categorical variable over the withinTierDraw field', () => {
  assert.strictEqual(WT.numeric, false);
  assert.strictEqual(WT.appliesTo(), true);
  const vars = WT.buildVariables({});
  assert.strictEqual(vars[0].paramKey, 'withinTierDraw');
  assert.strictEqual(vars[0].type, OPT_PARAM_TYPES.ENUM);
  assert.deepStrictEqual(vars[0].values, ['SEQUENTIAL', 'EQUAL', 'PROPORTIONAL']);
});

test('DRAWDOWN_WITHINTIER: describe labels each policy', () => {
  const vars = WT.buildVariables({});
  assert.match(WT.describe({ withinTierDraw: 'EQUAL' }, vars), /evenly/i);
  assert.match(WT.describe({ withinTierDraw: 'PROPORTIONAL' }, vars), /by account balance/i);
  assert.match(WT.describe({ withinTierDraw: 'SEQUENTIAL' }, vars), /one account per tier/i);
});

test('DRAWDOWN_WITHINTIER: actuate re-stamps the live sim state + persists the param', () => {
  const vars = WT.buildVariables({});
  const sim = { state: { withinTierDraw: 'SEQUENTIAL', foo: 1 } };
  const services = { simulationRegistry: { getPrimary: () => sim } };
  const scenario = { params: [{ name: 'withinTierDraw', value: 'SEQUENTIAL' }] };
  const ok = WT.actuate({ services, scenario, candidate: { withinTierDraw: 'PROPORTIONAL' }, vars });
  assert.strictEqual(ok, true);
  assert.strictEqual(sim.state.withinTierDraw, 'PROPORTIONAL');
  assert.strictEqual(sim.state.foo, 1);
  assert.strictEqual(scenario.params[0].value, 'PROPORTIONAL');
});

test('DRAWDOWN_WITHINTIER: actuate rejects a bogus policy', () => {
  const vars = WT.buildVariables({});
  const sim = { state: { withinTierDraw: 'SEQUENTIAL' } };
  const services = { simulationRegistry: { getPrimary: () => sim } };
  const ok = WT.actuate({ services, scenario: { params: [] }, candidate: { withinTierDraw: 'NOPE' }, vars });
  assert.strictEqual(ok, false);
  assert.strictEqual(sim.state.withinTierDraw, 'SEQUENTIAL');
});

test('DRAWDOWN_WITHINTIER: a committed policy bites under a snapshot-seeded rollout (§11.1 shim)', () => {
  quiet(() => {
    const snapshot = makeInitialSnapshot({ simStart: SIM_START, simEnd: SIM_END, asOfDate: NOW, baseParams: BASE });
    const mk = (mode) => {
      const problem = new OptimizationProblem({
        variables: [], baseParams: BASE, objective: OPTIMIZATION_OBJECTIVES.MAX_NET_WORTH,
        simStart: SIM_START, simEnd: SIM_END, initialState: { kind: 'snapshot', snapshot },
      });
      return problem.evaluate({ withinTierDraw: mode }).result.finalNetWorthUsd;
    };
    // Guards the withinTierDraw entry in FORWARD_DRAWDOWN_STATE_FIELDS: without the
    // re-stamp the injected snapshot's SEQUENTIAL clobbers the committed policy.
    assert.ok(Math.abs(mk('SEQUENTIAL') - mk('PROPORTIONAL')) > 1,
      'withinTierDraw is inert under MPC (shim missing)');
  });
});

// ─── Phase 3-MPC — Lever B online (DRAWDOWN_WEIGHTS, the flagship) ─────────────

const DW = COCKPIT_CONTROLS.DRAWDOWN_WEIGHTS;

test('DRAWDOWN_WEIGHTS: one continuous variable per investment role, gated on WEIGHTED', () => {
  assert.strictEqual(DW.numeric, true);
  assert.strictEqual(DW.appliesTo({ drawdownStrategy: 'WEIGHTED' }), true);
  assert.strictEqual(DW.appliesTo({ drawdownStrategy: 'CUSTOM' }), false);
  const vars = DW.buildVariables({ range: { min: 0, max: 1, step: 0.05 } });
  assert.strictEqual(vars.length, DRAWDOWN_WEIGHT_ROLES.length);
  for (const v of vars) {
    assert.strictEqual(v.type, OPT_PARAM_TYPES.CONTINUOUS);
    assert.ok(v.paramKey.startsWith('drawdownWeight::'));   // :: separator, set()-safe
    assert.strictEqual(v.min, 0);
    assert.strictEqual(v.max, 1);
  }
});

test('DRAWDOWN_WEIGHTS: describe renders the resulting draw order (ascending by weight)', () => {
  const vars = DW.buildVariables({});
  // Roth lowest weight → drawn first; fixed-income highest → last.
  const candidate = {};
  DRAWDOWN_WEIGHT_ROLES.forEach((role, i) => { candidate[drawdownWeightKey(role)] = 0.5; });
  candidate[drawdownWeightKey(ACCOUNT_ROLES.ROTH)]         = 0.01;
  candidate[drawdownWeightKey(ACCOUNT_ROLES.FIXED_INCOME)] = 0.99;
  const label = DW.describe(candidate, vars);
  assert.match(label, /^Draw order: Roth IRA →/);        // Roth first
  assert.match(label, /US Fixed Income$/);               // fixed-income last
});

test('DRAWDOWN_WEIGHTS: actuate re-stamps live account priorities from the weights', () => {
  const vars = DW.buildVariables({});
  const candidate = {};
  DRAWDOWN_WEIGHT_ROLES.forEach(role => { candidate[drawdownWeightKey(role)] = 0.5; });
  candidate[drawdownWeightKey(ACCOUNT_ROLES.ROTH)]         = 0.01;   // draw Roth first
  candidate[drawdownWeightKey(ACCOUNT_ROLES.FIXED_INCOME)] = 0.99;   // fixed-income last

  const sim = { state: {
    rothAccount: { role: ACCOUNT_ROLES.ROTH,         ownerId: 'primary', drawdownPriority: 99, balance: 1 },
    fiAccount:   { role: ACCOUNT_ROLES.FIXED_INCOME, ownerId: 'primary', drawdownPriority: 99, balance: 1 },
    spouseRoth:  { role: ACCOUNT_ROLES.ROTH,         ownerId: 'spouse',  drawdownPriority: 99, balance: 1 },
  } };
  const services = { simulationRegistry: { getPrimary: () => sim } };
  const scenario = { params: [{ name: drawdownWeightKey(ACCOUNT_ROLES.ROTH), value: 0.8 },
                              { name: 'drawdownOwnerOrdering', value: 'PRIMARY_FIRST' }] };

  const ok = DW.actuate({ services, scenario, candidate, vars });
  assert.strictEqual(ok, true);
  // Roth (weight 0.01) now ranks ahead of fixed-income (weight 0.99).
  assert.ok(sim.state.rothAccount.drawdownPriority < sim.state.fiAccount.drawdownPriority);
  // Owner banding preserved: the spouse's same-role Roth sits a stride (100) above.
  assert.strictEqual(sim.state.spouseRoth.drawdownPriority, sim.state.rothAccount.drawdownPriority + 100);
  // The committed weight was persisted to its scenario param.
  assert.strictEqual(scenario.params[0].value, 0.01);
});

test('DRAWDOWN_WEIGHTS: a committed weight order bites under a snapshot-seeded rollout (§11.3 shim)', () => {
  quiet(() => {
    const base = { ...BASE, drawdownStrategy: 'WEIGHTED', crossBorderDrawdown: 'GLOBAL' };
    const snapshot = makeInitialSnapshot({ simStart: SIM_START, simEnd: SIM_END, asOfDate: NOW, baseParams: base });
    const mk = (cand) => {
      const problem = new OptimizationProblem({
        variables: [], baseParams: base, objective: OPTIMIZATION_OBJECTIVES.MAX_NET_WORTH,
        simStart: SIM_START, simEnd: SIM_END, initialState: { kind: 'snapshot', snapshot },
      });
      return problem.evaluate(cand).result.finalNetWorthUsd;
    };
    const rothFirst = {
      [drawdownWeightKey(ACCOUNT_ROLES.ROTH)]:         0.01,
      [drawdownWeightKey(ACCOUNT_ROLES.FIXED_INCOME)]: 0.99,
      [drawdownWeightKey(ACCOUNT_ROLES.US_STOCK)]:     0.95,
    };
    // Guards the per-account drawdownPriority re-stamp in _seededSim: without it the
    // injected snapshot's baked-in order clobbers the committed weight order.
    assert.ok(Math.abs(mk({}) - mk(rothFirst)) > 1,
      'Lever B weight order is inert under MPC (per-account re-stamp missing)');
  });
});
