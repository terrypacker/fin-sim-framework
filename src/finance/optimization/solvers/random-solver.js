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
 * Map a stratified u ∈ [0,1) to a legal value for one variable.
 */
function valueFromUnit(v, u) {
  if (v.type === OPT_PARAM_TYPES.ENUM) {
    const opts = v.values ?? [];
    return opts[Math.min(opts.length - 1, Math.floor(u * opts.length))] ?? opts[0];
  }
  if (v.type === OPT_PARAM_TYPES.INTEGER) {
    return Math.round(v.min + u * (v.max - v.min));
  }
  return v.min + u * (v.max - v.min); // CONTINUOUS
}

/**
 * Latin-hypercube design: one stratified, shuffled u per variable per sample,
 * so each variable's range is evenly covered without the clustering plain
 * uniform sampling suffers at low budgets.
 */
function latinHypercube(variables, n, rng) {
  const cols = variables.map(() => {
    const u = Array.from({ length: n }, (_, i) => (i + rng()) / n);
    for (let i = n - 1; i > 0; i--) {          // Fisher–Yates with the seeded rng
      const j = Math.floor(rng() * (i + 1));
      [u[i], u[j]] = [u[j], u[i]];
    }
    return u;
  });
  return Array.from({ length: n }, (_, row) => {
    const candidate = {};
    variables.forEach((v, k) => { candidate[v.paramKey] = valueFromUnit(v, cols[k][row]); });
    return candidate;
  });
}

/**
 * RandomSolver — seeded uniform / Latin-hypercube sampling within bounds
 * (design/38 §4). A cheap baseline and a seeding tool for the smarter solvers:
 * exploration with no model of the landscape, fully reproducible from its seed.
 */
export class RandomSolver {
  static key   = 'RANDOM';
  static label = 'Random / Latin Hypercube';

  constructor({ budget = 64, seed = 1, sampling = 'lhs' } = {}) {
    this.budget   = budget;
    this.seed     = seed;
    this.sampling = sampling; // 'lhs' | 'uniform'
  }

  async solve(problem, { onProgress, signal, budget = this.budget, seed = this.seed, sampling = this.sampling } = {}) {
    const rng = makeSeededRng(seed);

    // Never request more samples than the grid holds (∞-safe: null → use budget).
    const cc        = problem.candidateCount();
    const effBudget = cc == null ? budget : Math.min(budget, cc);
    const ledger    = new EvalLedger(problem, { onProgress, budget: effBudget, signal });

    if (problem.variables.length === 0) {
      await ledger.evaluate({});
      return ledger.result(RandomSolver.key);
    }

    if (sampling === 'lhs') {
      for (const candidate of latinHypercube(problem.variables, effBudget, rng)) {
        if (ledger.exhausted) break;
        await ledger.evaluate(candidate);
      }
    } else {
      // Uniform: guard against an infinite loop when the unique space is small.
      const maxAttempts = effBudget * 8 + 16;
      for (let a = 0; a < maxAttempts && !ledger.exhausted; a++) {
        await ledger.evaluate(problem.randomCandidate(rng));
      }
    }
    return ledger.result(RandomSolver.key);
  }
}
