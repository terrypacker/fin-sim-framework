/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { valuesForConfig, cartesianProduct } from '../opt-values.js';

/**
 * GridSearchSolver — exhaustive Cartesian enumeration (design/38 §4).
 *
 * The default solver and the exact one: it enumerates the full product of every
 * variable's value set, evaluates each candidate through the shared
 * `problem.evaluate`, and ranks by score (higher is better). This is today's
 * IntlRetirementOptimizer enumeration re-expressed on top of the
 * OptimizationProblem seam — 100% accurate, ideal for low-dimensional, small
 * ranges, and the backward-compatibility baseline every other solver is
 * compared against.
 */
export class GridSearchSolver {
  static key   = 'GRID';
  static label = 'Grid Search (exact)';

  /** Build the full candidate list from a problem's variables. */
  static enumerate(variables) {
    if (variables.length === 0) return [{}];
    const paramKeys = variables.map(v => v.paramKey);
    const valueSets = variables.map(v => valuesForConfig(v));
    return cartesianProduct(valueSets).map(combo => {
      const candidate = {};
      paramKeys.forEach((k, i) => { candidate[k] = combo[i]; });
      return candidate;
    });
  }

  /**
   * @param {OptimizationProblem} problem
   * @param {object}   [opts]
   * @param {Function} [opts.onProgress] - (completed, total) after each evaluation.
   * @param {number}   [opts.budget]     - Cap on evaluations (exhaustive by default).
   * @param {AbortSignal} [opts.signal]  - Cooperative early-stop.
   * @returns {Promise<{ candidates, best, evaluations, solver }>}
   */
  async solve(problem, { onProgress, budget = Infinity, signal } = {}) {
    const all   = GridSearchSolver.enumerate(problem.variables);
    const total = Math.min(all.length, budget);
    const results = [];

    for (let i = 0; i < total; i++) {
      if (signal?.aborted) break;
      const { result, score } = problem.evaluate(all[i]);
      results.push({ candidate: all[i], result, score });
      if (onProgress) onProgress(i + 1, total);
      // Yield so the UI stays responsive during long sweeps.
      await new Promise(resolve => setTimeout(resolve, 0));
    }

    results.sort((a, b) => b.score - a.score);
    return {
      candidates:  results,
      best:        results[0] ?? null,
      evaluations: results.length,
      solver:      GridSearchSolver.key,
    };
  }
}
