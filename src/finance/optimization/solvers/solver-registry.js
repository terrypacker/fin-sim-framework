/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { GridSearchSolver } from './grid-search-solver.js';

/**
 * SOLVER_REGISTRY — named-things registry of search strategies (design/38 §3.2),
 * exactly like OPTIMIZATION_OBJECTIVES and SPENDING_STRATEGY_REGISTRY.
 *
 * Each entry exposes:
 *   label        — human-readable name for the Solver <select> on the OPT panel.
 *   factory      — (options) => solver instance with `solve(problem, runOpts)`.
 *   optionSchema — typed param list (same shape spending strategies use) so the
 *                  UI can render solver-specific knobs generically (budget, seed,
 *                  population size, temperature schedule, …).
 *
 * GRID is exhaustive and exact — the default, with no knobs. Pattern search,
 * simulated annealing, and random/LHS land in later steps of design/38.
 */
export const SOLVER_REGISTRY = {
  GRID: {
    label:        GridSearchSolver.label,
    factory:      (_options = {}) => new GridSearchSolver(),
    optionSchema: [],
  },
  // PATTERN_SEARCH, SIMULATED_ANNEALING, RANDOM — design/38 Steps 3–4.
};

/** Look up a solver factory by key, defaulting to GRID. */
export function createSolver(key, options = {}) {
  const entry = SOLVER_REGISTRY[key] ?? SOLVER_REGISTRY.GRID;
  return entry.factory(options);
}
