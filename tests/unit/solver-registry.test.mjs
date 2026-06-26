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
import assert from 'node:assert/strict';

import { SOLVER_REGISTRY, createSolver } from '../../src/finance/optimization/solvers/solver-registry.js';
import { GridSearchSolver }   from '../../src/finance/optimization/solvers/grid-search-solver.js';
import { PatternSearchSolver } from '../../src/finance/optimization/solvers/pattern-search-solver.js';
import { RandomSolver }        from '../../src/finance/optimization/solvers/random-solver.js';
import { SimulatedAnnealingSolver } from '../../src/finance/optimization/solvers/simulated-annealing-solver.js';
import { OptimizationProblem } from '../../src/finance/optimization/optimization-problem.js';
import { OPT_PARAM_TYPES } from '../../src/finance/optimization/optimization-objectives.js';

/**
 * Cheap analytic toy problem (design/38 §9). Duck-types the OptimizationProblem
 * surface a solver actually touches — `variables` + `evaluate(candidate)` — so
 * we test the search policy without running a simulation.
 *
 * Concave quadratic with a unique maximum at (x=2, y=-3), score 0.
 */
function toyQuadratic() {
  return {
    variables: [
      { paramKey: 'x', type: OPT_PARAM_TYPES.INTEGER, min: -5, max: 5, step: 1 },
      { paramKey: 'y', type: OPT_PARAM_TYPES.INTEGER, min: -5, max: 5, step: 1 },
    ],
    evaluate(c) {
      const score = -((c.x - 2) ** 2 + (c.y + 3) ** 2);
      return { result: { x: c.x, y: c.y, score }, score };
    },
  };
}

/**
 * Real OptimizationProblem (for its encode/decode/randomCandidate/candidateCount
 * codec) with `evaluate` swapped for a cheap analytic concave function peaking at
 * (x=2, y=-3). Lets the vector-oriented solvers run without a simulation.
 */
function analyticProblem(variables) {
  const p = new OptimizationProblem({ variables });
  p.evaluate = (c) => {
    const score = -((c.x - 2) ** 2 + (c.y + 3) ** 2);
    return { result: { ...c, score }, score };
  };
  return p;
}

const INT_VARS = [
  { paramKey: 'x', type: OPT_PARAM_TYPES.INTEGER, min: -5, max: 5, step: 1 },
  { paramKey: 'y', type: OPT_PARAM_TYPES.INTEGER, min: -5, max: 5, step: 1 },
];
const CONT_VARS = [
  { paramKey: 'x', type: OPT_PARAM_TYPES.CONTINUOUS, min: -5, max: 5, step: 0.01 },
  { paramKey: 'y', type: OPT_PARAM_TYPES.CONTINUOUS, min: -5, max: 5, step: 0.01 },
];

// ─── registry lookup ──────────────────────────────────────────────────────────

describe('SOLVER_REGISTRY', () => {
  test('GRID entry exposes label, factory, optionSchema', () => {
    const entry = SOLVER_REGISTRY.GRID;
    assert.strictEqual(entry.label, 'Grid Search (exact)');
    assert.ok(entry.factory() instanceof GridSearchSolver);
    assert.deepStrictEqual(entry.optionSchema, []);
  });

  test('PATTERN_SEARCH, RANDOM, SIMULATED_ANNEALING entries are registered with option schemas', () => {
    assert.ok(SOLVER_REGISTRY.PATTERN_SEARCH.factory() instanceof PatternSearchSolver);
    assert.ok(SOLVER_REGISTRY.RANDOM.factory() instanceof RandomSolver);
    assert.ok(SOLVER_REGISTRY.SIMULATED_ANNEALING.factory() instanceof SimulatedAnnealingSolver);
    assert.ok(SOLVER_REGISTRY.PATTERN_SEARCH.optionSchema.some(o => o.key === 'budget'));
    assert.ok(SOLVER_REGISTRY.RANDOM.optionSchema.some(o => o.key === 'sampling'));
    assert.ok(SOLVER_REGISTRY.SIMULATED_ANNEALING.optionSchema.some(o => o.key === 'cooling'));
  });

  test('factory options thread through to the solver instance', () => {
    const s = SOLVER_REGISTRY.RANDOM.factory({ budget: 99, seed: 7, sampling: 'uniform' });
    assert.strictEqual(s.budget, 99);
    assert.strictEqual(s.seed, 7);
    assert.strictEqual(s.sampling, 'uniform');
  });

  test('createSolver returns the requested solver, defaulting to GRID', () => {
    assert.ok(createSolver('GRID') instanceof GridSearchSolver);
    assert.ok(createSolver('PATTERN_SEARCH') instanceof PatternSearchSolver);
    assert.ok(createSolver('RANDOM') instanceof RandomSolver);
    assert.ok(createSolver('NONEXISTENT') instanceof GridSearchSolver);
  });
});

// ─── GridSearchSolver ─────────────────────────────────────────────────────────

describe('GridSearchSolver', () => {
  test('recovers the known optimum of the toy problem', async () => {
    const { candidates, best, evaluations, solver } =
      await new GridSearchSolver().solve(toyQuadratic());

    assert.strictEqual(solver, 'GRID');
    assert.strictEqual(evaluations, 11 * 11);        // exhaustive 11×11 grid
    assert.strictEqual(candidates.length, 11 * 11);
    assert.deepStrictEqual(best.candidate, { x: 2, y: -3 });
    assert.ok(best.score === 0); // === so -0 (from -(0+0)) counts as the optimum
    // Ranked best-first.
    assert.ok(candidates[0].score >= candidates[candidates.length - 1].score);
  });

  test('is deterministic across runs', async () => {
    const a = await new GridSearchSolver().solve(toyQuadratic());
    const b = await new GridSearchSolver().solve(toyQuadratic());
    assert.deepStrictEqual(a.best.candidate, b.best.candidate);
    assert.strictEqual(a.best.score, b.best.score);
  });

  test('reports progress and honours an evaluation budget', async () => {
    const seen = [];
    const { evaluations } = await new GridSearchSolver().solve(toyQuadratic(), {
      budget: 10,
      onProgress: (done, total) => seen.push([done, total]),
    });
    assert.strictEqual(evaluations, 10);
    assert.deepStrictEqual(seen[seen.length - 1], [10, 10]);
  });

  test('no variables → a single base-params evaluation', async () => {
    const problem = {
      variables: [],
      evaluate: (c) => { assert.deepStrictEqual(c, {}); return { result: {}, score: 42 }; },
    };
    const { candidates, best, evaluations } = await new GridSearchSolver().solve(problem);
    assert.strictEqual(evaluations, 1);
    assert.deepStrictEqual(candidates[0].candidate, {});
    assert.strictEqual(best.score, 42);
  });
});

// ─── RandomSolver ─────────────────────────────────────────────────────────────

describe('RandomSolver', () => {
  test('samples within the budget and only legal values', async () => {
    const { candidates, evaluations, solver } =
      await new RandomSolver({ budget: 40, seed: 3 }).solve(analyticProblem(INT_VARS));
    assert.strictEqual(solver, 'RANDOM');
    assert.ok(evaluations <= 40);
    for (const { candidate } of candidates) {
      assert.ok(candidate.x >= -5 && candidate.x <= 5 && Number.isInteger(candidate.x));
      assert.ok(candidate.y >= -5 && candidate.y <= 5 && Number.isInteger(candidate.y));
    }
  });

  test('is deterministic for a given seed', async () => {
    const a = await new RandomSolver({ budget: 30, seed: 11 }).solve(analyticProblem(CONT_VARS));
    const b = await new RandomSolver({ budget: 30, seed: 11 }).solve(analyticProblem(CONT_VARS));
    assert.deepStrictEqual(a.best.candidate, b.best.candidate);
    assert.strictEqual(a.best.score, b.best.score);
  });

  test('never exceeds the unique grid size (∞-safe budget)', async () => {
    // 11×11 = 121 unique integer points; ask for far more.
    const { evaluations } = await new RandomSolver({ budget: 10_000, seed: 1, sampling: 'uniform' })
      .solve(analyticProblem(INT_VARS));
    assert.ok(evaluations <= 121, `expected ≤121 unique evals, got ${evaluations}`);
  });

  test('LHS covers the space well enough to land near the optimum', async () => {
    const { best } = await new RandomSolver({ budget: 120, seed: 5, sampling: 'lhs' })
      .solve(analyticProblem(CONT_VARS));
    assert.ok(Math.abs(best.candidate.x - 2) < 1.5);
    assert.ok(Math.abs(best.candidate.y + 3) < 1.5);
  });
});

// ─── PatternSearchSolver ──────────────────────────────────────────────────────

describe('PatternSearchSolver', () => {
  test('converges near the continuous optimum at a fraction of the grid', async () => {
    const { best, evaluations, solver } =
      await new PatternSearchSolver({ budget: 400, seed: 2 }).solve(analyticProblem(CONT_VARS));
    assert.strictEqual(solver, 'PATTERN_SEARCH');
    assert.ok(best.score > -0.01, `score ${best.score} should be near 0`);
    assert.ok(Math.abs(best.candidate.x - 2) < 0.05);
    assert.ok(Math.abs(best.candidate.y + 3) < 0.05);
    // A full 0.01-step grid over 2 vars would be ~10⁶ evals; pattern search is tiny.
    assert.ok(evaluations <= 400);
  });

  test('finds the exact integer optimum', async () => {
    const { best } = await new PatternSearchSolver({ budget: 300, seed: 4 })
      .solve(analyticProblem(INT_VARS));
    assert.deepStrictEqual(best.candidate, { x: 2, y: -3 });
    assert.ok(best.score === 0);
  });

  test('is deterministic for a given seed', async () => {
    const a = await new PatternSearchSolver({ budget: 200, seed: 9 }).solve(analyticProblem(CONT_VARS));
    const b = await new PatternSearchSolver({ budget: 200, seed: 9 }).solve(analyticProblem(CONT_VARS));
    assert.deepStrictEqual(a.best.candidate, b.best.candidate);
  });

  test('honours a warm-start point', async () => {
    // Starting already at the optimum, the first exploration should fail to
    // improve and the solver should stay put.
    const { best } = await new PatternSearchSolver({ budget: 100, seed: 1, start: { x: 2, y: -3 } })
      .solve(analyticProblem(CONT_VARS));
    assert.ok(Math.abs(best.candidate.x - 2) < 0.05);
    assert.ok(Math.abs(best.candidate.y + 3) < 0.05);
  });
});

// ─── SimulatedAnnealingSolver ─────────────────────────────────────────────────

describe('SimulatedAnnealingSolver', () => {
  test('converges toward the continuous optimum within budget', async () => {
    const { best, evaluations, solver } =
      await new SimulatedAnnealingSolver({ budget: 500, seed: 1 }).solve(analyticProblem(CONT_VARS));
    assert.strictEqual(solver, 'SIMULATED_ANNEALING');
    assert.ok(evaluations <= 500);
    assert.ok(best.score > -0.5, `score ${best.score} should be near 0`);
    assert.ok(Math.abs(best.candidate.x - 2) < 0.7);
    assert.ok(Math.abs(best.candidate.y + 3) < 0.7);
  });

  test('auto-calibrates temperature to the objective scale (large net-worth-like values)', async () => {
    // Same shape scaled up by 1e6 — proves T0 calibration is scale-free.
    const p = new OptimizationProblem({ variables: CONT_VARS });
    p.evaluate = (c) => {
      const score = -1e6 * ((c.x - 2) ** 2 + (c.y + 3) ** 2);
      return { result: { ...c, score }, score };
    };
    const { best } = await new SimulatedAnnealingSolver({ budget: 500, seed: 1 }).solve(p);
    assert.ok(Math.abs(best.candidate.x - 2) < 0.7);
    assert.ok(Math.abs(best.candidate.y + 3) < 0.7);
  });

  test('is deterministic for a given seed', async () => {
    const a = await new SimulatedAnnealingSolver({ budget: 300, seed: 8 }).solve(analyticProblem(CONT_VARS));
    const b = await new SimulatedAnnealingSolver({ budget: 300, seed: 8 }).solve(analyticProblem(CONT_VARS));
    assert.deepStrictEqual(a.best.candidate, b.best.candidate);
    assert.strictEqual(a.best.score, b.best.score);
  });

  test('respects an explicit initial temperature (skips burn-in calibration)', async () => {
    const { best, evaluations } =
      await new SimulatedAnnealingSolver({ budget: 500, seed: 3, initialTemp: 5, cooling: 0.97 })
        .solve(analyticProblem(CONT_VARS));
    assert.ok(evaluations <= 500);
    assert.ok(best.candidate.x >= -5 && best.candidate.x <= 5);
    assert.ok(best.score > -1.0); // settles in the optimum's neighbourhood
  });
});
