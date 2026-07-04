/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { test, describe } from 'node:test';
import assert             from 'node:assert/strict';
import { OptimizationProblem } from '../../src/finance/optimization/optimization-problem.js';
import { OPT_PARAM_TYPES, OPTIMIZATION_OBJECTIVES }
  from '../../src/finance/optimization/optimization-objectives.js';
import { RolloutWorkerPool, rolloutContext }
  from '../../src/finance/optimization/parallel/rollout-worker-pool.js';
import { CemSolver }        from '../../src/finance/optimization/solvers/cem-solver.js';
import { nodeRolloutSpawn } from './helpers/node-rollout-spawn.mjs';

/*
 * Design 46 Phase 0.5 (P-b) — the actual Web Worker parallelism, exercised here via
 * Node worker_threads (the same structured-clone serialization the browser uses).
 * Two properties matter and are both real cross-thread runs:
 *   1. worker-safety + serialization — a rollout run in a worker equals the
 *      main-thread `_rolloutResult` for the same candidate (the sim import graph is
 *      worker-safe; the context round-trips faithfully);
 *   2. bit-identical CEM — pool ON === pool OFF (the whole justification for P-a's
 *      order-preserving fold + RNG-free rollouts).
 * A short 2-year compile-kind horizon keeps the real sim fast enough for CI.
 */

/** A real (short-horizon) compile-kind problem whose result moves with the lever. */
function realProblem(overrides = {}) {
  return new OptimizationProblem({
    variables: [{ paramKey: 'inflationRate', type: OPT_PARAM_TYPES.CONTINUOUS, min: 0.01, max: 0.05, step: 0.01 }],
    objective: OPTIMIZATION_OBJECTIVES.MAX_NET_WORTH,
    simStart:  new Date(Date.UTC(2026, 0, 1)),
    simEnd:    new Date(Date.UTC(2028, 0, 1)),
    ...overrides,
  });
}

describe('RolloutWorkerPool (design 46 Phase 0.5 P-b)', () => {
  test('worker rollout equals main-thread _rolloutResult (safety + serialization)', async () => {
    const problem   = realProblem();
    const candidate = { inflationRate: 0.03 };
    const expected  = problem._rolloutResult(candidate);

    const pool = new RolloutWorkerPool({ size: 2, spawn: nodeRolloutSpawn() });
    try {
      pool.setContext(rolloutContext(problem));
      const [got] = await pool.map([candidate]);
      assert.deepStrictEqual(got, expected);
    } finally {
      pool.terminate();
    }
  });

  test('map returns results in input order regardless of completion order', async () => {
    const problem  = realProblem();
    const cands    = [0.05, 0.01, 0.04, 0.02, 0.03].map(inflationRate => ({ inflationRate }));
    const expected = cands.map(c => problem._rolloutResult(c));

    const pool = new RolloutWorkerPool({ size: 3, spawn: nodeRolloutSpawn() });
    try {
      pool.setContext(rolloutContext(problem));
      const got = await pool.map(cands);
      assert.deepStrictEqual(got, expected);
    } finally {
      pool.terminate();
    }
  });

  test('mapSeries (fan) in a worker equals main-thread rolloutSeries', async () => {
    const problem  = realProblem();
    const cands    = [0.02, 0.03, 0.04].map(inflationRate => ({ inflationRate }));
    const expected = cands.map(c => problem.rolloutSeries(c, { points: 8 }));

    const pool = new RolloutWorkerPool({ size: 2, spawn: nodeRolloutSpawn() });
    try {
      pool.setProblem(problem);
      const got = await pool.mapSeries(cands, { points: 8 });
      assert.deepStrictEqual(got, expected);
    } finally {
      pool.terminate();
    }
  });

  test('CEM with the pool is bit-identical to CEM without it', async () => {
    const seq = await new CemSolver({ budget: 48, seed: 5, population: 12 }).solve(realProblem());

    const pool = new RolloutWorkerPool({ size: 4, spawn: nodeRolloutSpawn() });
    let par;
    try {
      par = await new CemSolver({ budget: 48, seed: 5, population: 12 })
        .solve(realProblem(), { workerPool: pool });
    } finally {
      pool.terminate();
    }

    assert.deepStrictEqual(par.best.candidate, seq.best.candidate);
    assert.equal(par.best.score, seq.best.score);
    assert.equal(par.evaluations, seq.evaluations);
    assert.deepStrictEqual(
      par.candidates.map(c => [c.candidate.inflationRate, c.score]),
      seq.candidates.map(c => [c.candidate.inflationRate, c.score]),
    );
  });
});
