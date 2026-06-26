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
 * mpc-sampling-vs-qp.test.mjs — design 39 §9 / Step 6.
 *
 * The QP local-polish second stage: on a smooth sub-problem it improves on the
 * sampling elite; on a non-smooth one it degrades gracefully (no chatter / no
 * divergence — never worse than the elite, never out of bounds). Tested on the
 * shared analytic toy used by the other solver tests.
 */

import { test, describe } from 'node:test';
import assert             from 'node:assert/strict';

import { qpPolish, QpPolishSolver }       from '../../src/finance/optimization/solvers/qp-polish.js';
import { SOLVER_REGISTRY, createSolver }  from '../../src/finance/optimization/solvers/solver-registry.js';
import { OptimizationProblem }            from '../../src/finance/optimization/optimization-problem.js';
import { OPT_PARAM_TYPES }                from '../../src/finance/optimization/optimization-objectives.js';

// Smooth concave peak at (x=2, y=-3) — the shared toy.
function analyticProblem(variables) {
  const p = new OptimizationProblem({ variables });
  p.evaluate = (c) => {
    const score = -((c.x - 2) ** 2 + (c.y + 3) ** 2);
    return { result: { ...c, score }, score };
  };
  return p;
}

// Non-smooth staircase: flat plateaus with jumps at the half-integers — finite
// differences over a plateau give a zero gradient, so a gradient method cannot
// make progress (and must not chatter or diverge).
function staircaseProblem(variables) {
  const p = new OptimizationProblem({ variables });
  p.evaluate = (c) => {
    const score = -(Math.abs(Math.round(c.x) - 2) + Math.abs(Math.round(c.y) + 3));
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

describe('qpPolish — local refinement of an elite', () => {
  test('improves a coarse elite on a smooth concave objective (reaches the optimum)', async () => {
    const p = analyticProblem(CONT_VARS);
    const start = { x: 0, y: 0 };                       // a deliberately off-peak "elite"
    const startScore = p.evaluate(start).score;
    const { best } = await qpPolish(p, start, { budget: 150 });

    assert.ok(best.score > startScore, `polished ${best.score} > start ${startScore}`);
    assert.ok(Math.abs(best.candidate.x - 2) < 0.1, `x=${best.candidate.x}`);
    assert.ok(Math.abs(best.candidate.y + 3) < 0.1, `y=${best.candidate.y}`);
  });

  test('degrades gracefully on a non-smooth objective (never worse, stays in bounds)', async () => {
    const p = staircaseProblem(CONT_VARS);
    const start = { x: 0.3, y: 0.4 };
    const startScore = p.evaluate(start).score;
    const { best } = await qpPolish(p, start, { budget: 150 });

    assert.ok(best.score >= startScore, `never worse than the elite (${best.score} >= ${startScore})`);
    assert.ok(best.candidate.x >= -5 && best.candidate.x <= 5, 'x stayed in bounds (no divergence)');
    assert.ok(best.candidate.y >= -5 && best.candidate.y <= 5, 'y stayed in bounds (no divergence)');
  });

  test('leaves a purely integer problem untouched (QP governs continuous knobs only)', async () => {
    const p = analyticProblem(INT_VARS);
    const start = { x: 1, y: -2 };
    const startScore = p.evaluate(start).score;
    const { best, evaluations } = await qpPolish(p, start, { budget: 50 });

    assert.deepStrictEqual(best.candidate, { x: 1, y: -2 }, 'no continuous coords → start unchanged');
    assert.equal(best.score, startScore);
    assert.equal(evaluations, 1, 'only the incumbent is evaluated');
  });

  test('respects the evaluation budget', async () => {
    const { evaluations } = await qpPolish(analyticProblem(CONT_VARS), { x: 0, y: 0 }, { budget: 20 });
    assert.ok(evaluations <= 20, `evaluations ${evaluations} within budget`);
  });
});

describe('QpPolishSolver (QP_POLISH composite)', () => {
  test('registered in SOLVER_REGISTRY with a factory + optionSchema', () => {
    const entry = SOLVER_REGISTRY.QP_POLISH;
    assert.equal(entry.label, QpPolishSolver.label);
    assert.ok(entry.optionSchema.some(o => o.key === 'base'));
    assert.ok(entry.optionSchema.some(o => o.key === 'polishBudget'));
    assert.ok(createSolver('QP_POLISH', { budget: 50 }) instanceof QpPolishSolver);
  });

  test('never regresses below the base sampler, and a coarse base reaches the optimum after polish', async () => {
    const opts = { budget: 24, seed: 5, population: 12 };          // deliberately coarse base
    const cem = await createSolver('CEM', opts).solve(analyticProblem(CONT_VARS));
    const qp  = await createSolver('QP_POLISH', { ...opts, polishBudget: 200 }).solve(analyticProblem(CONT_VARS));

    assert.ok(qp.best.score >= cem.best.score, `composite ${qp.best.score} >= base ${cem.best.score}`);
    const err = Math.hypot(qp.best.candidate.x - 2, qp.best.candidate.y + 3);
    assert.ok(err < 0.1, `polished within 0.1 of the optimum (err ${err})`);
    assert.equal(qp.solver, 'QP_POLISH');
  });

  test('base = QP_POLISH is forced to a sampler (no self-recursion)', () => {
    assert.ok(createSolver('QP_POLISH', { base: 'QP_POLISH', budget: 20 }) instanceof QpPolishSolver);
  });
});
