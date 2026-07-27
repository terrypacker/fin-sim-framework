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
 * MPC-DRAWDOWN-SLEEVE (design 65 Phase 4): the DRAWDOWN_SLEEVE cockpit control and
 * its MPC forwarding.
 *
 *   1. The control spec: continuous per-class weight variables, describe (sell order),
 *      forward-effective actuate (rewrites the live state selection fields).
 *   2. The forwarding: a committed sleeve policy survives snapshot injection under the
 *      MPC rollout — the design-65 fields ride FORWARD_DRAWDOWN_STATE_FIELDS, so the
 *      seeded sim honors the candidate instead of the snapshot's stale default. Unlike
 *      the design-58 role-weight order (a per-account drawdownPriority re-stamp), the
 *      sleeve policy is a state-resident config read fresh each draw ⇒ NO _seededSim
 *      per-account shim is needed.
 *
 * Run with: node --test tests/unit/mpc-drawdown-sleeve.test.mjs
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import { COCKPIT_CONTROLS }   from '../../src/finance/mpc/cockpit-controller.js';
import { makeInitialSnapshot } from '../../src/finance/mpc/mpc-controller.js';
import { OptimizationProblem } from '../../src/finance/optimization/optimization-problem.js';
import { OPT_PARAM_TYPES, OPTIMIZATION_OBJECTIVES } from '../../src/finance/optimization/optimization-objectives.js';
import { DRAWDOWN_SLEEVE_CLASSES, sleeveWeightKey } from '../../src/finance/holdings/holdings-selection.js';

const DS = COCKPIT_CONTROLS.DRAWDOWN_SLEEVE;

function quiet(fn) {
  const l = console.log, w = console.warn;
  console.log = () => {}; console.warn = () => {};
  try { return fn(); } finally { console.log = l; console.warn = w; }
}

// ─── Control spec ─────────────────────────────────────────────────────────────

test('DRAWDOWN_SLEEVE: one continuous weight variable per sleeve class', () => {
  assert.strictEqual(DS.numeric, true);
  const vars = DS.buildVariables({ range: DS.defaultRange });
  assert.strictEqual(vars.length, DRAWDOWN_SLEEVE_CLASSES.length);
  assert.deepStrictEqual(vars.map(v => v.paramKey), DRAWDOWN_SLEEVE_CLASSES.map(sleeveWeightKey));
  for (const v of vars) assert.strictEqual(v.type, OPT_PARAM_TYPES.CONTINUOUS);
});

test('DRAWDOWN_SLEEVE: appliesTo gates on the WEIGHTED sleeve order', () => {
  assert.strictEqual(DS.appliesTo({ drawdownSleeveOrder: 'WEIGHTED' }), true);
  assert.strictEqual(DS.appliesTo({ drawdownSleeveOrder: 'TAX_COST' }), false);
  assert.strictEqual(DS.appliesTo({}), false);
  assert.match(DS.requirement, /WEIGHTED/);
});

test('DRAWDOWN_SLEEVE: describe renders the sell order (ascending weight = sold first)', () => {
  const vars = DS.buildVariables({ range: DS.defaultRange });
  const candidate = {
    [sleeveWeightKey('CASH')]: 0.1, [sleeveWeightKey('BOND')]: 0.3,
    [sleeveWeightKey('EQUITY')]: 0.6, [sleeveWeightKey('GOLD')]: 0.9,
  };
  const desc = DS.describe(candidate, vars);
  assert.match(desc, /Sell order:/);
  // CASH (0.1) sold before GOLD (0.9).
  assert.ok(desc.indexOf('CASH') < desc.indexOf('GOLD'), desc);
});

test('DRAWDOWN_SLEEVE: actuate re-wires the live state selection + persists params', () => {
  const vars = DS.buildVariables({ range: DS.defaultRange });
  const sim = { state: { drawdownSleeveOrder: 'FIFO', drawdownSleeveWeights: null, foo: 1 } };
  const services = { simulationRegistry: { getPrimary: () => sim } };
  const scenario = { params: DRAWDOWN_SLEEVE_CLASSES.map(c => ({ name: sleeveWeightKey(c), value: 0 })) };
  const candidate = {
    [sleeveWeightKey('CASH')]: 0.9, [sleeveWeightKey('BOND')]: 0.7,
    [sleeveWeightKey('EQUITY')]: 0.1, [sleeveWeightKey('GOLD')]: 0.2,
  };

  const ok = DS.actuate({ services, scenario, candidate, vars });
  assert.strictEqual(ok, true);
  assert.strictEqual(sim.state.drawdownSleeveOrder, 'WEIGHTED');          // forced into WEIGHTED so weights bite
  assert.strictEqual(sim.state.drawdownSleeveWeights.EQUITY, 0.1);        // committed weight stamped
  assert.strictEqual(sim.state.drawdownSleeveWeights.CASH, 0.9);
  assert.strictEqual(sim.state.foo, 1);                                   // rest of state preserved
  const eqParam = scenario.params.find(p => p.name === sleeveWeightKey('EQUITY'));
  assert.strictEqual(eqParam.value, 0.1);                                 // persisted for Advise/Rebuild
});

test('DRAWDOWN_SLEEVE: actuate is a no-op without a live sim', () => {
  const vars = DS.buildVariables({ range: DS.defaultRange });
  const services = { simulationRegistry: { getPrimary: () => null } };
  const ok = DS.actuate({ services, scenario: { params: [] }, candidate: {}, vars });
  assert.strictEqual(ok, false);
});

// ─── MPC forwarding: the policy survives snapshot injection ────────────────────

const SIM_START = new Date(Date.UTC(2026, 0, 1));
const SIM_END   = new Date(Date.UTC(2050, 0, 1));
const NOW       = new Date(Date.UTC(2041, 0, 1));
const BASE      = { monthlyExpenses: 12_000, drawdownStrategy: 'CUSTOM' };

test('DRAWDOWN_SLEEVE: a committed sleeve policy is forwarded onto the snapshot-seeded sim', () => {
  quiet(() => {
    const snapshot = makeInitialSnapshot({ simStart: SIM_START, simEnd: SIM_END, asOfDate: NOW, baseParams: BASE });
    const problem  = new OptimizationProblem({
      variables: [], baseParams: BASE, objective: OPTIMIZATION_OBJECTIVES.MAX_NET_WORTH,
      simStart: SIM_START, simEnd: SIM_END, initialState: { kind: 'snapshot', snapshot },
    });
    // The snapshot was taken with the default FIFO policy; the candidate commits WEIGHTED.
    const candidate = {
      drawdownSleeveOrder: 'WEIGHTED',
      [sleeveWeightKey('CASH')]: 0.9, [sleeveWeightKey('BOND')]: 0.7,
      [sleeveWeightKey('EQUITY')]: 0.1, [sleeveWeightKey('GOLD')]: 0.2,
    };
    const params = problem._applyCandidate({ ...BASE, endDate: SIM_END }, candidate);
    const sim = problem._seededSim(params);

    // Without FORWARD_DRAWDOWN_STATE_FIELDS carrying these, snapshot injection would leave
    // the seeded state at the snapshot's FIFO default. Forwarding makes the committed
    // WEIGHTED policy + weights present, so the disposal primitive honors them from "now".
    assert.strictEqual(sim.state.drawdownSleeveOrder, 'WEIGHTED');
    assert.ok(sim.state.drawdownSleeveWeights, 'sleeve weights forwarded');
    assert.strictEqual(sim.state.drawdownSleeveWeights.EQUITY, 0.1);
    assert.strictEqual(sim.state.drawdownSleeveWeights.CASH, 0.9);
  });
});
