/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { GridSearchSolver }         from './grid-search-solver.js';
import { PatternSearchSolver }       from './pattern-search-solver.js';
import { RandomSolver }              from './random-solver.js';
import { SimulatedAnnealingSolver }  from './simulated-annealing-solver.js';
import { CemSolver }                 from './cem-solver.js';
import { QpPolishSolver }             from './qp-polish.js';

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

  PATTERN_SEARCH: {
    label:   PatternSearchSolver.label,
    factory: (options = {}) => new PatternSearchSolver(options),
    optionSchema: [
      { key: 'budget', label: 'Max Evaluations', type: 'Number', defaultValue: 200,
        description: 'Hard cap on simulations to run.' },
      { key: 'seed', label: 'Seed', type: 'Number', defaultValue: 1,
        description: 'Seed for the random start point (reproducible).' },
      { key: 'noImproveLimit', label: 'Convergence Patience', type: 'Number', defaultValue: 60,
        description: 'Stop after this many consecutive evaluations without a new best (0 = off).' },
    ],
  },

  RANDOM: {
    label:   RandomSolver.label,
    factory: (options = {}) => new RandomSolver(options),
    optionSchema: [
      { key: 'budget', label: 'Samples', type: 'Number', defaultValue: 64,
        description: 'Number of points to sample.' },
      { key: 'seed', label: 'Seed', type: 'Number', defaultValue: 1,
        description: 'Seed for sampling (reproducible).' },
      { key: 'sampling', label: 'Sampling', type: 'Enum', options: ['lhs', 'uniform'],
        defaultValue: 'lhs',
        description: 'Latin-hypercube (even coverage) or plain uniform sampling.' },
    ],
  },

  SIMULATED_ANNEALING: {
    label:   SimulatedAnnealingSolver.label,
    factory: (options = {}) => new SimulatedAnnealingSolver(options),
    optionSchema: [
      { key: 'budget', label: 'Max Evaluations', type: 'Number', defaultValue: 300,
        description: 'Hard cap on simulations to run.' },
      { key: 'seed', label: 'Seed', type: 'Number', defaultValue: 1,
        description: 'Seed for proposals and acceptance (reproducible).' },
      { key: 'cooling', label: 'Cooling Rate', type: 'Number', defaultValue: 0.95,
        description: 'Geometric temperature decay per iteration (0–1; lower cools faster).' },
      { key: 'initialTemp', label: 'Initial Temperature', type: 'Number', defaultValue: 0,
        description: 'Starting temperature in objective units (0 = auto-calibrate from a burn-in).' },
    ],
  },

  CEM: {
    label:   CemSolver.label,
    factory: (options = {}) => new CemSolver(options),
    optionSchema: [
      { key: 'budget', label: 'Max Evaluations', type: 'Number', defaultValue: 256,
        description: 'Hard cap on simulations to run.' },
      { key: 'seed', label: 'Seed', type: 'Number', defaultValue: 1,
        description: 'Seed for sampling (reproducible).' },
      { key: 'population', label: 'Population', type: 'Number', defaultValue: 32,
        description: 'Candidate control vectors sampled per generation.' },
      { key: 'eliteFrac', label: 'Elite Fraction', type: 'Number', defaultValue: 0.25,
        description: 'Top fraction of each generation refit into the next sampling distribution.' },
      { key: 'sigma0', label: 'Initial Spread', type: 'Number', defaultValue: 0.5,
        description: 'Initial std as a fraction of each variable’s range (higher = broader first generation).' },
    ],
  },

  QP_POLISH: {
    label:   QpPolishSolver.label,
    // Opt-in second stage (design 39 §4 / Step 6): a sampling backbone refined by
    // a local QP on the continuous sub-vector. The base solver is wired here (in
    // the same module as createSolver) to avoid a registry import cycle in
    // qp-polish.js; `base` !== 'QP_POLISH' is forced to dodge self-recursion.
    factory: (options = {}) => {
      const base = options.base && options.base !== 'QP_POLISH' ? options.base : 'CEM';
      return new QpPolishSolver({ ...options, baseSolver: createSolver(base, options) });
    },
    optionSchema: [
      { key: 'base', label: 'Base Solver', type: 'Enum', options: ['CEM', 'RANDOM', 'SIMULATED_ANNEALING', 'PATTERN_SEARCH'],
        defaultValue: 'CEM',
        description: 'Sampling solver whose elite is polished.' },
      { key: 'budget', label: 'Base Max Evaluations', type: 'Number', defaultValue: 256,
        description: 'Evaluation cap for the base sampling stage.' },
      { key: 'polishBudget', label: 'Polish Max Evaluations', type: 'Number', defaultValue: 80,
        description: 'Evaluation cap for the local QP-polish stage.' },
      { key: 'seed', label: 'Seed', type: 'Number', defaultValue: 1,
        description: 'Seed for the base sampling stage (reproducible).' },
    ],
  },
};

/** Look up a solver factory by key, defaulting to GRID. */
export function createSolver(key, options = {}) {
  const entry = SOLVER_REGISTRY[key] ?? SOLVER_REGISTRY.GRID;
  return entry.factory(options);
}
