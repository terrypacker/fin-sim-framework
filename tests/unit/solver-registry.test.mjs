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
import { GridSearchSolver } from '../../src/finance/optimization/solvers/grid-search-solver.js';
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

// ─── registry lookup ──────────────────────────────────────────────────────────

describe('SOLVER_REGISTRY', () => {
  test('GRID entry exposes label, factory, optionSchema', () => {
    const entry = SOLVER_REGISTRY.GRID;
    assert.strictEqual(entry.label, 'Grid Search (exact)');
    assert.ok(entry.factory() instanceof GridSearchSolver);
    assert.deepStrictEqual(entry.optionSchema, []);
  });

  test('createSolver returns the requested solver, defaulting to GRID', () => {
    assert.ok(createSolver('GRID') instanceof GridSearchSolver);
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
