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
import { EvalLedger }          from '../../src/finance/optimization/solvers/solver-support.js';
import { OptimizationProblem } from '../../src/finance/optimization/optimization-problem.js';
import { OPT_PARAM_TYPES }     from '../../src/finance/optimization/optimization-objectives.js';

/*
 * Design 46 Phase 0.5 (P-a) — EvalLedger.evaluateBatch must be BIT-IDENTICAL to
 * calling evaluate() on each candidate in order (the property that lets the worker
 * pool parallelize a generation without changing CEM's result). These tests pin
 * that equivalence over the cases that stress it: duplicates (intra-batch cache
 * hits), budget truncation mid-batch, and a pre-warmed cache (cross-generation
 * hits). An analytic problem (no real sim) keeps them fast and deterministic.
 */

/** Analytic toy: deterministic score, concave peak at x = 7. No simulation. */
function toyProblem() {
  const p = new OptimizationProblem({
    variables: [{ paramKey: 'x', type: OPT_PARAM_TYPES.INTEGER, min: 0, max: 100, step: 1 }],
  });
  p.evaluate = (c) => {
    const score = -((c.x - 7) ** 2);
    return { result: { x: c.x, score }, score };
  };
  return p;
}

/** The observable ledger state after a run, for deep-equality comparison. */
function ledgerState(l) {
  return {
    n:         l.evaluations.length,
    best:      l.best?.candidate ?? null,
    bestScore: l.best?.score ?? null,
    evals:     l.evaluations.map(e => [e.candidate.x, e.score]),
  };
}
const entryPairs = (entries) => entries.map(e => [e.candidate.x, e.score]);

/** The sequential reference: exactly CEM's per-candidate loop (break on exhausted). */
async function sequential(problem, candidates, opts, prewarm = []) {
  const l = new EvalLedger(problem, opts);
  for (const c of prewarm) await l.evaluate(c);
  const out = [];
  for (const c of candidates) {
    if (l.exhausted) break;
    out.push(await l.evaluate(c));
  }
  return { l, out };
}

async function batched(problem, candidates, opts, prewarm = []) {
  const l = new EvalLedger(problem, opts);
  for (const c of prewarm) await l.evaluate(c);
  const out = await l.evaluateBatch(candidates);
  return { l, out };
}

async function assertEquivalent(candidates, opts = {}, prewarm = []) {
  const p = toyProblem();
  const s = await sequential(p, candidates, opts, prewarm);
  const b = await batched(p, candidates, opts, prewarm);
  assert.deepStrictEqual(ledgerState(b.l), ledgerState(s.l), 'ledger state diverged');
  assert.deepStrictEqual(entryPairs(b.out), entryPairs(s.out), 'returned entries diverged');
}

const C = (...xs) => xs.map(x => ({ x }));

describe('EvalLedger.evaluateBatch === sequential evaluate (design 46 Phase 0.5)', () => {
  test('distinct candidates', async () => {
    await assertEquivalent(C(3, 1, 7, 9, 5));
  });

  test('intra-batch duplicates become cache hits (dedup, order preserved)', async () => {
    await assertEquivalent(C(2, 5, 5, 7, 2, 8));
  });

  test('budget truncates mid-batch at the same point', async () => {
    await assertEquivalent(C(0, 1, 2, 3, 4, 5, 6), { budget: 3 });
  });

  test('budget with duplicates: hits do not consume budget', async () => {
    await assertEquivalent(C(4, 4, 1, 1, 2, 3, 9), { budget: 3 });
  });

  test('already-exhausted ledger returns nothing', async () => {
    await assertEquivalent(C(1, 2, 3), { budget: 2 }, /*prewarm*/ C(10, 11));
  });

  test('pre-warmed cache: cross-generation hits fold identically', async () => {
    await assertEquivalent(C(7, 3, 5, 7, 1), {}, /*prewarm*/ C(3, 7));
  });

  test('onProgress fires once per novel eval, same totals', async () => {
    const seqCalls = [];
    const batCalls = [];
    const cands = C(1, 2, 2, 3, 4);
    await sequential(toyProblem(), cands, { onProgress: (n, t) => seqCalls.push([n, t]) });
    await batched(toyProblem(),  cands, { onProgress: (n, t) => batCalls.push([n, t]) });
    assert.deepStrictEqual(batCalls, seqCalls);
  });
});
