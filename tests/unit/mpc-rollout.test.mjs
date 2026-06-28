/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { test, describe }     from 'node:test';
import assert                 from 'node:assert/strict';
import { OptimizationProblem } from '../../src/finance/optimization/optimization-problem.js';

/*
 * Design 39 Step 1 — snapshot-seeded rollout primitive (the prototype, §10 Q4).
 *
 * The risk this file proves: a rollout seeded from a now-snapshot, COMPILED IN A
 * FRESH ServiceRegistry, reproduces the tail of a full-horizon run from t0 — even
 * when material *runtime/compile one-off* events fire AFTER the snapshot date:
 *   - the US→AU residency move (Jul 1 of moveYear), and
 *   - a planned house sale.
 * Both are scheduled into the event queue and must survive the snapshot →
 * fresh-registry hop intact. If the queued events were flattened lossily, the
 * post-snapshot trajectory would diverge and these assertions would fail.
 */

const RICH_PARAMS = {
  moveYear:        2031,   // US→AU residency change on Jul 1 2031 (post-snapshot)
  usHouseSaleYear: 2033,   // planned property sale (post-snapshot, post-move)
};

// Metrics that span many independent state dimensions — a lost or mis-fired
// event after the snapshot would perturb at least one of them.
const METRIC_KEYS = [
  'finalNetWorthUsd',
  'finalNetLiquidity',
  'rothFinalBalance',
  'cumulativeTaxesPaid',
  'cumulativeDeficit',
  'deficitMonths',
  'scenarioFailed',
];

function pickMetrics(result) {
  const out = {};
  for (const k of METRIC_KEYS) out[k] = result[k];
  return out;
}

describe('MPC Step 1 — snapshot-seeded rollout reproduces the full-horizon tail', () => {
  test('move + house sale straddling the snapshot survive the cross-registry hop', () => {
    const simStart = new Date(Date.UTC(2026, 0, 1));
    const midDate  = new Date(Date.UTC(2029, 0, 1));   // before move (2031) and sale (2033)
    const simEnd   = new Date(Date.UTC(2035, 0, 1));

    // ── Reference: one continuous compile run from t0 with the rich params. ──
    const ref = new OptimizationProblem({ variables: [], baseParams: RICH_PARAMS, simStart, simEnd });
    const refSim = ref._compile({ ...RICH_PARAMS, endDate: simEnd });
    refSim.silent = true;
    refSim.journal.enabled = false;
    refSim.stepTo(midDate);

    // Snapshot at "now" in the SimulationHistory.takeSnapshot() shape.
    const snapshot = {
      date:     new Date(refSim.currentDate),
      state:    structuredClone(refSim.state),
      rngState: refSim.rngState,
      queue:    refSim.cloneQueue(),
    };

    refSim.stepTo(simEnd);
    const referenceMetrics = pickMetrics(ref._readResult(refSim.state, simEnd, RICH_PARAMS));

    // Sanity: the reference actually exercised the events we care about.
    assert.ok(Number.isFinite(referenceMetrics.finalNetWorthUsd), 'reference produced a finite net worth');

    // ── Snapshot path: fresh registry, inject the now-snapshot, roll forward. ──
    const snapProblem = new OptimizationProblem({
      variables: [],
      baseParams: RICH_PARAMS,
      simStart,
      simEnd,
      initialState: { kind: 'snapshot', snapshot, cfgTemplate: null },
    });
    const { result } = snapProblem.evaluate({});
    const snapMetrics = pickMetrics(result);

    // Faithful re-hydration ⇒ the tail matches metric-for-metric (byte-identical:
    // same deterministic math, same event order, no lost events).
    assert.deepStrictEqual(snapMetrics, referenceMetrics,
      'snapshot-seeded rollout must reproduce the full-horizon tail exactly');
  });

  test('snapshot rngState is carried into the rollout', () => {
    // The snapshot primitive must restore rngState so stochastic rollouts (later
    // stochastic MPC, §10 Q5) seed from "now" rather than from a fresh compile.
    const simStart = new Date(Date.UTC(2026, 0, 1));
    const midDate  = new Date(Date.UTC(2029, 0, 1));
    const simEnd   = new Date(Date.UTC(2032, 0, 1));

    const ref = new OptimizationProblem({ variables: [], simStart, simEnd });
    const refSim = ref._compile({ endDate: simEnd });
    refSim.silent = true;
    refSim.journal.enabled = false;
    refSim.stepTo(midDate);

    const SENTINEL_RNG = 1234567;
    const snapshot = {
      date:     new Date(refSim.currentDate),
      state:    structuredClone(refSim.state),
      rngState: SENTINEL_RNG,
      queue:    refSim.cloneQueue(),
    };

    // Patch stepTo so the rollout records the rngState it actually starts from
    // (i.e. AFTER the snapshot injection in _rollout, BEFORE any stepping). This
    // exercises the real public evaluate() path, not a hand-built injection.
    const snapProblem = new OptimizationProblem({
      variables: [],
      simStart,
      simEnd,
      initialState: { kind: 'snapshot', snapshot, cfgTemplate: null },
    });

    let seenRngAtRolloutStart;
    const origCompile = snapProblem._compile.bind(snapProblem);
    snapProblem._compile = (params) => {
      const sim = origCompile(params);
      const origStepTo = sim.stepTo.bind(sim);
      sim.stepTo = (d) => { seenRngAtRolloutStart ??= sim.rngState; return origStepTo(d); };
      return sim;
    };

    const { result } = snapProblem.evaluate({});
    assert.equal(seenRngAtRolloutStart, SENTINEL_RNG,
      'rollout must begin from the snapshot rngState, not the fresh compile seed');
    assert.ok(Number.isFinite(result.finalNetWorthUsd));
  });
});
