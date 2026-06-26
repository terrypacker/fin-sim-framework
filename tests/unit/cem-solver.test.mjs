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
import { CemSolver }           from '../../src/finance/optimization/solvers/cem-solver.js';
import { SOLVER_REGISTRY, createSolver } from '../../src/finance/optimization/solvers/solver-registry.js';
import { OptimizationProblem } from '../../src/finance/optimization/optimization-problem.js';
import { OPT_PARAM_TYPES }     from '../../src/finance/optimization/optimization-objectives.js';

/*
 * Design 39 Step 4 — CEM sampling-MPC backbone, as a design-38 solver.
 * Tested on the shared analytic toy (concave peak at x=2, y=-3) like the other
 * solvers, plus the categorical/ordinal handling and warm-start that make it the
 * MPC backbone.
 */

function analyticProblem(variables) {
  const p = new OptimizationProblem({ variables });
  p.evaluate = (c) => {
    const score = -((c.x - 2) ** 2 + (c.y + 3) ** 2);
    return { result: { ...c, score }, score };
  };
  return p;
}

const CONT_VARS = [
  { paramKey: 'x', type: OPT_PARAM_TYPES.CONTINUOUS, min: -5, max: 5, step: 0.01 },
  { paramKey: 'y', type: OPT_PARAM_TYPES.CONTINUOUS, min: -5, max: 5, step: 0.01 },
];
const INT_VARS = [
  { paramKey: 'x', type: OPT_PARAM_TYPES.INTEGER, min: -5, max: 5, step: 1 },
  { paramKey: 'y', type: OPT_PARAM_TYPES.INTEGER, min: -5, max: 5, step: 1 },
];

describe('CemSolver', () => {
  test('registered in SOLVER_REGISTRY with a factory + optionSchema', () => {
    const entry = SOLVER_REGISTRY.CEM;
    assert.equal(entry.label, CemSolver.label);
    assert.ok(entry.optionSchema.some(o => o.key === 'population'));
    assert.ok(createSolver('CEM', { budget: 50 }) instanceof CemSolver);
  });

  test('recovers the continuous optimum', async () => {
    const { best } = await new CemSolver({ budget: 600, seed: 3, population: 40 })
      .solve(analyticProblem(CONT_VARS));
    assert.ok(Math.abs(best.candidate.x - 2) < 0.2, `x=${best.candidate.x}`);
    assert.ok(Math.abs(best.candidate.y + 3) < 0.2, `y=${best.candidate.y}`);
  });

  test('snaps integer coordinates to the exact lattice optimum', async () => {
    const { best } = await new CemSolver({ budget: 600, seed: 7, population: 40 })
      .solve(analyticProblem(INT_VARS));
    assert.deepStrictEqual(best.candidate, { x: 2, y: -3 });
  });

  test('deterministic for a given seed', async () => {
    const a = await new CemSolver({ budget: 300, seed: 9 }).solve(analyticProblem(CONT_VARS));
    const b = await new CemSolver({ budget: 300, seed: 9 }).solve(analyticProblem(CONT_VARS));
    assert.deepStrictEqual(a.best.candidate, b.best.candidate);
  });

  test('respects the evaluation budget', async () => {
    const { evaluations } = await new CemSolver({ budget: 80, seed: 1, population: 20 })
      .solve(analyticProblem(CONT_VARS));
    assert.ok(evaluations <= 80, `evaluations ${evaluations} within budget`);
  });

  test('warm start seeds the initial mean and converges fast', async () => {
    // Starting at the optimum, a small budget still lands on it.
    const { best } = await new CemSolver({ budget: 120, seed: 2, population: 20, start: { x: 2, y: -3 } })
      .solve(analyticProblem(CONT_VARS));
    assert.ok(Math.abs(best.candidate.x - 2) < 0.2);
    assert.ok(Math.abs(best.candidate.y + 3) < 0.2);
  });

  test('stays within bounds', async () => {
    const { candidates } = await new CemSolver({ budget: 120, seed: 4 })
      .solve(analyticProblem(CONT_VARS));
    for (const c of candidates) {
      assert.ok(c.candidate.x >= -5 && c.candidate.x <= 5);
      assert.ok(c.candidate.y >= -5 && c.candidate.y <= 5);
    }
  });
});
