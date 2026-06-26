/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { OPT_PARAM_TYPES } from '../optimization-objectives.js';
import { EvalLedger }      from './solver-support.js';

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

/**
 * qpPolish — the opt-in **local QP polish** stage (design 39 §4 / Step 6).
 *
 * It is the *second* stage of MPC's two-stage control: the sampling backbone
 * (CEM / random shooting) eats the plant's non-smoothness and the categorical /
 * ordinal controls and hands over an elite; this routine refines that elite on
 * the **continuous control sub-vector only** (ENUM/INTEGER coordinates are left
 * frozen — a QP can't reach them), in the locally-smooth region around the
 * nominal point.
 *
 * Mechanism (the "QP", hand-rolled — no solver library, per project policy):
 *   1. Finite-difference the **sensitivities** of J — central-difference gradient
 *      `g` and a diagonal Hessian `H` — over the continuous coordinates.
 *   2. Form the local quadratic model and take a **projected (diagonal-)Newton**
 *      step: for a concave coordinate (H<0, the well-posed CRRA-utility regime)
 *      the step is `-g/H` (uphill for maximization); otherwise plain gradient
 *      ascent. The box bounds `[min,max]` are the QP's linear constraints, handled
 *      by projection (the active-set on the bounds).
 *   3. **Backtracking line search** accepts a step only on strict improvement, so
 *      the iterate is monotone: on a smooth region it climbs; on a non-smooth /
 *      noisy point the search fails and it **stops at the incumbent** — never
 *      chattering or diverging (the §9 graceful-degradation property). Because the
 *      incumbent is the sampling elite, the polished result is never worse than
 *      what it started from.
 *
 * @param {OptimizationProblem} problem
 * @param {object} start - the elite candidate to refine (paramKey → value).
 * @param {object} [opts]
 * @returns {Promise<{ candidates, best, evaluations, solver }>} shared solver shape.
 */
export async function qpPolish(problem, start, {
  budget      = 80,
  maxIters    = 10,
  relStep     = 0.02,     // FD step as a fraction of each continuous dim's range
  minStepFrac = 1e-4,     // stop when the trial move shrinks below this fraction of range
  backtracks  = 8,
  onProgress, signal,
} = {}) {
  const vars   = problem.variables ?? [];
  const ledger = new EvalLedger(problem, { onProgress, budget, signal });

  // Evaluate the incumbent first so `ledger.best` can never fall below it.
  let x = problem.encode(start ?? {});
  let curScore = (await ledger.evaluate(problem.decode(x))).score;

  // Continuous coordinates only (design 39 §4 — QP governs smooth knobs).
  const cont = [];
  vars.forEach((v, k) => { if (v.type === OPT_PARAM_TYPES.CONTINUOUS) cont.push(k); });
  if (cont.length === 0) return ledger.result('QP_POLISH');   // categorical → nothing to polish

  const bounds = cont.map(k => [vars[k].min, vars[k].max]);
  const range  = bounds.map(([lo, hi]) => (hi - lo) || 1);

  const evalAt = async (vec) => (await ledger.evaluate(problem.decode(vec))).score;

  for (let iter = 0; iter < maxIters && !ledger.exhausted; iter++) {
    const f0 = curScore;

    // 1) Finite-difference gradient + diagonal Hessian over the continuous coords.
    const g = new Array(cont.length).fill(0);
    const H = new Array(cont.length).fill(0);
    for (let i = 0; i < cont.length && !ledger.exhausted; i++) {
      const k = cont[i];
      const h = Math.max(relStep * range[i], 1e-9);
      const xp = x.slice(); xp[k] = clamp(x[k] + h, bounds[i][0], bounds[i][1]);
      const xm = x.slice(); xm[k] = clamp(x[k] - h, bounds[i][0], bounds[i][1]);
      const fp = await evalAt(xp);
      const fm = await evalAt(xm);
      g[i] = (fp - fm) / (2 * h);
      H[i] = (fp - 2 * f0 + fm) / (h * h);
    }

    // 2) Diagonal projected-Newton (concave) / gradient-ascent (otherwise) step.
    const dir = g.map((gi, i) => (H[i] < -1e-12 ? -gi / H[i] : gi * range[i]));

    // 3) Backtracking line search; accept strict improvement only (monotone).
    let t = 1, accepted = null;
    for (let b = 0; b < backtracks && !ledger.exhausted; b++) {
      const trial = x.slice();
      let moved = 0;
      for (let i = 0; i < cont.length; i++) {
        const k  = cont[i];
        const nv = clamp(x[k] + t * dir[i], bounds[i][0], bounds[i][1]);
        moved += Math.abs(nv - x[k]) / range[i];
        trial[k] = nv;
      }
      if (moved < minStepFrac) break;          // step collapsed → converged
      const s = await evalAt(trial);
      if (s > f0) { accepted = { vec: trial, score: s }; break; }
      t *= 0.5;
    }

    if (!accepted) break;                        // no improving step → stop (graceful)
    x = accepted.vec;
    curScore = accepted.score;
  }

  return ledger.result('QP_POLISH');
}

/**
 * QpPolishSolver — composite design-38 solver wiring the sampling backbone to the
 * QP polish: run the base sampler, then refine its elite with {@link qpPolish}.
 * The merged result keeps the global best across both stages, so it is
 * **never worse** than the base solver alone (graceful degradation, §9).
 *
 * The base solver is *injected* (the registry factory wires it via `createSolver`)
 * to avoid a registry import cycle here.
 */
export class QpPolishSolver {
  static key   = 'QP_POLISH';
  static label = 'QP Local Polish (on a sampling elite)';

  constructor({ baseSolver = null, polishBudget = 80, ...polishOpts } = {}) {
    this.baseSolver   = baseSolver;
    this.polishBudget = polishBudget;
    this.polishOpts   = polishOpts;
  }

  async solve(problem, runOpts = {}) {
    if (!this.baseSolver) throw new Error('QpPolishSolver: a base solver must be injected');

    const baseResult = await this.baseSolver.solve(problem, runOpts);
    const startC = baseResult.best?.candidate;
    if (!startC) return baseResult;

    const polish = await qpPolish(problem, startC, {
      ...this.polishOpts,
      budget:     runOpts.polishBudget ?? this.polishBudget,
      onProgress: runOpts.onProgress,
      signal:     runOpts.signal,
    });

    // Merge both stages; the global best ⊇ base.best (polish starts from it and is
    // monotone), so the composite never regresses below the sampling elite.
    const candidates = [...(baseResult.candidates ?? []), ...(polish.candidates ?? [])]
      .sort((a, b) => b.score - a.score);
    return {
      candidates,
      best:        candidates[0] ?? baseResult.best,
      evaluations: (baseResult.evaluations ?? 0) + (polish.evaluations ?? 0),
      solver:      QpPolishSolver.key,
    };
  }
}
