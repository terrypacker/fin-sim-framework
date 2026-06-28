/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { test, describe }          from 'node:test';
import assert                      from 'node:assert/strict';
import { OptimizationProblem }     from '../../src/finance/optimization/optimization-problem.js';
import { rollForwardWithControls, recordDecisionRecord } from '../../src/finance/mpc/apply-forward.js';
import { Graph }                   from '../../src/graph/graph.js';
import { EDGE_TYPES }              from '../../src/graph/edge.js';

/*
 * Design 39 Step 2 — apply-forward actuation, §9 correctness gate.
 *
 *   forward-effective control edit at "now"  ≡  from-scratch run with that
 *   control effective from "now"            AND  the realized past is untouched.
 *
 * The control is the EXPLICIT_BANDS spending strategy, whose band boundary is
 * date-keyed (an age). Putting a band boundary at the person's age in 2033 lets
 * ONE from-scratch run express "amount X before now, amount Y after now" — the
 * ground truth the apply-forward edit must reproduce.
 *
 * Primary is born 1978-04-15, so: age 48 in 2026, 52 at the 2030 snapshot, 55 in
 * 2033 (the forward band boundary).
 */

const SIM_START = new Date(Date.UTC(2026, 0, 1));
const NOW       = new Date(Date.UTC(2030, 0, 1));   // age 52 — inside band 48, before band 55
const SIM_END   = new Date(Date.UTC(2038, 0, 1));   // age 60 — well past band 55 (2033)

const BASE = { spendingStrategy: ['EXPLICIT_BANDS'] };
// First segment only (active ≤ now): one band.
const FIRST_ONLY = [{ startAge: 48, monthlyAmount: 4000 }];
// The date-keyed control: a second, materially different band kicks in at age 55.
const FULL       = [{ startAge: 48, monthlyAmount: 4000 }, { startAge: 55, monthlyAmount: 9000 }];

const METRIC_KEYS = [
  'finalNetWorthUsd', 'finalNetLiquidity', 'rothFinalBalance',
  'cumulativeTaxesPaid', 'cumulativeDeficit', 'deficitMonths', 'scenarioFailed',
];
const pick = r => Object.fromEntries(METRIC_KEYS.map(k => [k, r[k]]));

/** Compile + step a fresh from-scratch run; return { problem, sim }. */
function runFromScratch(params, stopAt = SIM_END) {
  const problem = new OptimizationProblem({ variables: [], baseParams: params, simStart: SIM_START, simEnd: SIM_END });
  const sim = problem._compile({ ...params, endDate: SIM_END });
  sim.silent = true;
  sim.journal.enabled = false;
  sim.stepTo(stopAt);
  return { problem, sim };
}

describe('MPC Step 2 — apply-forward actuation (§9 gate)', () => {
  test('forward-effective edit ≡ from-scratch date-keyed run, past untouched', () => {
    // ── Ground truth: one from-scratch run with the full date-keyed control. ──
    const refParams = { ...BASE, spendingExpenseBands: FULL };
    const { problem: refP, sim: refSim } = runFromScratch(refParams);
    const refMetrics = pick(refP._readResult(refSim.state, SIM_END, refParams));

    // The reference's realized state AT now (the "past" the edit must not disturb).
    const { sim: refAtNow } = runFromScratch(refParams, NOW);
    const refStateAtNow = structuredClone(refAtNow.state);

    // ── Apply-forward, phase 1: live the past under the OLD control, snapshot. ──
    const fwdBase = { ...BASE, spendingExpenseBands: FIRST_ONLY };
    const { sim: pastSim } = runFromScratch(fwdBase, NOW);
    const snapshot = {
      date:     new Date(pastSim.currentDate),
      state:    structuredClone(pastSim.state),
      rngState: pastSim.rngState,
      queue:    pastSim.cloneQueue(),
    };

    // Past untouched: before the 2033 boundary FULL ≡ FIRST_ONLY, so the realized
    // state at now is byte-identical to the reference's.
    assert.deepStrictEqual(snapshot.state, refStateAtNow,
      'realized past (snapshot at now) must equal the reference state at now');

    // ── Apply-forward, phase 2: the forward-effective edit adds the 55+ band. ──
    const { result } = rollForwardWithControls({
      snapshot,
      controlParams: { spendingExpenseBands: FULL },
      baseParams:    fwdBase,
      simStart:      SIM_START,
      simEnd:        SIM_END,
    });

    assert.deepStrictEqual(pick(result), refMetrics,
      'forward-effective edit must reproduce the from-scratch date-keyed tail exactly');

    // ── Guard: the edit actually took effect (a no-edit roll diverges). ──
    const { result: noEdit } = rollForwardWithControls({
      snapshot,
      controlParams: {},               // keep the OLD single band forward
      baseParams:    fwdBase,
      simStart:      SIM_START,
      simEnd:        SIM_END,
    });
    assert.notDeepStrictEqual(pick(noEdit), refMetrics,
      'a no-edit forward roll must differ — proving the control edit is what changed the tail');
  });

  test('forward edit re-pins the CURRENT period immediately — no annual lag (Step 5b)', () => {
    // Snapshot at NOW (age 52, inside the 48-band pinned to $4000). Editing the
    // band ACTIVE at "now" must bite immediately, not wait for the next annual
    // period advance (2031) — otherwise the year you're standing in keeps the old
    // spend (the re-pin-lag bug).
    const fwdBase = { ...BASE, spendingExpenseBands: FIRST_ONLY };
    const { sim: pastSim } = runFromScratch(fwdBase, NOW);
    assert.equal(pastSim.state.explicitBandSpending.appliedAmount, 4000, 'snapshot pinned to the old amount');
    const snapshot = {
      date:  new Date(pastSim.currentDate), state: structuredClone(pastSim.state),
      rngState: pastSim.rngState, queue: pastSim.cloneQueue(),
    };

    const problem = new OptimizationProblem({
      variables: [], baseParams: fwdBase, simStart: SIM_START, simEnd: SIM_END,
      initialState: { kind: 'snapshot', snapshot },
    });

    // Roll to "now" exactly: the only thing that can change the spend is the
    // injection-time re-pin (no period advance occurs at the same instant).
    const unedited = problem.rollToSnapshot({}, NOW);
    const edited   = problem.rollToSnapshot({ 'spendingExpenseBands[0].monthlyAmount': 9000 }, NOW);

    assert.ok(Math.abs(unedited.state.monthlyExpenses - snapshot.state.monthlyExpenses) < 1e-6,
      'no edit → current-period spend is unchanged at "now"');
    // $4000 → $9000 is a 2.25× jump, effective AT "now" (same price level), not 2031.
    const ratio = edited.state.monthlyExpenses / unedited.state.monthlyExpenses;
    assert.ok(Math.abs(ratio - 9000 / 4000) < 1e-6,
      `current-period spend re-pinned immediately (got ${edited.state.monthlyExpenses} vs ${unedited.state.monthlyExpenses}, ratio ${ratio})`);
  });

  test('recordDecisionRecord lays a DERIVES_FROM trail in the decision layer (design 17 / 39 Step 5c)', () => {
    const graph = new Graph();
    graph.addNode({ id: 'p:base', layer: 'scenario', name: 'Base' });

    const node = recordDecisionRecord({
      graph,
      parentId:      'p:base',
      id:            'mpc:epoch-2030',
      name:          'Recommended move @ 2030',
      controlParams: { spendingExpenseBands: FULL },
      asOfDate:      NOW,
      simStart:      SIM_START,
      simEnd:        SIM_END,
      result:        { finalNetWorthUsd: 1234 },
    });

    assert.equal(node.derived, true);
    assert.equal(node.layer, 'decision', 'a decision record is NOT in the scenario layer');
    assert.equal(node.asOfDate, NOW.toISOString());

    // The whole point of Step 5c: it stays out of byLayer('scenario'), so no
    // scenario-layer reader (picker / getUserScenarios / persistence) can scoop it.
    assert.equal(graph.byLayer('scenario').some(n => n.id === 'mpc:epoch-2030'), false);
    assert.equal(graph.byLayer('decision').length, 1);

    const edges = graph.getOutgoing('mpc:epoch-2030', EDGE_TYPES.DERIVES_FROM);
    assert.equal(edges.length, 1, 'one DERIVES_FROM edge to the parent');
    assert.equal(edges[0].to, 'p:base', 'edge points child → parent');
  });
});
