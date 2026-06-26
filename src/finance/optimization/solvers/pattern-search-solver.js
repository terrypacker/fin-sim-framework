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
import { makeSeededRng, EvalLedger } from './solver-support.js';

/**
 * Per-coordinate initial + minimum step sizes, in the units `encode` uses:
 * ENUM coordinates are indices (step 1, no subdivision); INTEGER/CONTINUOUS
 * coordinates are values (start at a quarter of the range, shrink to the
 * variable's own resolution).
 */
function stepProfile(variables) {
  const step = [];
  const min  = [];
  for (const v of variables) {
    if (v.type === OPT_PARAM_TYPES.ENUM) {
      step.push(1); min.push(1);
    } else if (v.type === OPT_PARAM_TYPES.INTEGER) {
      const m = Math.max(1, v.step ?? 1);
      step.push(Math.max(m, Math.round((v.max - v.min) / 4))); min.push(m);
    } else { // CONTINUOUS
      const m = v.step ?? (v.max - v.min) / 100;
      step.push((v.max - v.min) / 4); min.push(m);
    }
  }
  return { step, min };
}

/**
 * PatternSearchSolver — Hooke–Jeeves coordinate descent with pattern moves
 * (design/38 §4), operating on the encoded vector and decoding (snapping) each
 * trial before evaluation.
 *
 * One coordinate is line-searched at a time (the exploratory move); on success
 * the solver extrapolates along the accumulated direction (the pattern move);
 * on a stalled exploration it halves the step sizes. Best for the expense-band
 * problem, where adjacent bands are weakly coupled so coordinate moves are cheap
 * and near-optimal. Deterministic given a seed (only the start point is random,
 * and can be warm-started via `start` for design 39 replans).
 */
export class PatternSearchSolver {
  static key   = 'PATTERN_SEARCH';
  static label = 'Pattern Search';

  constructor({ budget = 200, seed = 1, noImproveLimit = Infinity, start = null } = {}) {
    this.budget         = budget;
    this.seed           = seed;
    this.noImproveLimit = noImproveLimit;
    this.start          = start;
  }

  async solve(problem, {
    onProgress, signal,
    budget         = this.budget,
    seed           = this.seed,
    noImproveLimit = this.noImproveLimit,
    start          = this.start,
  } = {}) {
    const rng    = makeSeededRng(seed);
    // A non-positive patience means "no convergence early-out".
    const patience = noImproveLimit > 0 ? noImproveLimit : Infinity;
    const ledger = new EvalLedger(problem, { onProgress, budget, noImproveLimit: patience, signal });
    const n      = problem.variables.length;

    const evalVec = (vec) => ledger.evaluate(problem.decode(vec));

    // Warm-start point if provided, else a seeded random start.
    const startVec = problem.encode(start ?? problem.randomCandidate(rng));

    let baseEntry = await evalVec(startVec);
    let base      = startVec.slice();
    let baseScore = baseEntry.score;

    if (n === 0) return ledger.result(PatternSearchSolver.key);

    const { step, min } = stepProfile(problem.variables);

    // Effective probe step: ENUM/INTEGER coordinates step in whole units (a
    // fractional step + decode-rounding would skip legal values, e.g. ±1.5 from
    // 1 probes 3 and 0 but never 2). CONTINUOUS coordinates step by the raw size.
    const effStep = (k) => {
      const t = problem.variables[k].type;
      if (t === OPT_PARAM_TYPES.ENUM || t === OPT_PARAM_TYPES.INTEGER) return Math.floor(step[k]);
      return step[k];
    };

    // Greedy coordinate sweep: probe each active coordinate ±step, keep the
    // first improvement and continue from there.
    const exploratory = async (point, pointScore) => {
      let bestVec   = point.slice();
      let bestScore = pointScore;
      for (let k = 0; k < n && !ledger.exhausted; k++) {
        const s = effStep(k);
        if (s < min[k]) continue;
        for (const dir of [1, -1]) {
          const trial = bestVec.slice();
          trial[k] += dir * s;
          const e = await evalVec(trial);
          if (e.score > bestScore) { bestScore = e.score; bestVec = trial; break; }
          if (ledger.exhausted) break;
        }
      }
      return { vec: bestVec, score: bestScore };
    };

    const active = () => problem.variables.some((_, k) => effStep(k) >= min[k]);

    while (!ledger.exhausted && active()) {
      const ex = await exploratory(base, baseScore);
      if (ex.score > baseScore) {
        // Pattern moves: extrapolate along the successful direction, re-explore,
        // and keep advancing while it pays off.
        let curBase = base, curScore = baseScore, curEx = ex;
        while (!ledger.exhausted && curEx.score > curScore) {
          const pattern = curEx.vec.map((val, k) => val + (curEx.vec[k] - curBase[k]));
          curBase  = curEx.vec;
          curScore = curEx.score;
          const seed = await evalVec(pattern);
          curEx = await exploratory(pattern, seed.score);
        }
        base = curBase; baseScore = curScore;
      } else {
        for (let k = 0; k < n; k++) step[k] *= 0.5;
      }
    }

    return ledger.result(PatternSearchSolver.key);
  }
}
