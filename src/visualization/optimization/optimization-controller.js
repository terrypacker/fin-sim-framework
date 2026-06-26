/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { DEFAULT_OPTIMIZATION_CONFIGS } from '../../finance/optimization/intl-retirement-opt-config.js';
import { OPTIMIZATION_OBJECTIVES }      from '../../finance/optimization/optimization-objectives.js';
import { OptimizationProblem }          from '../../finance/optimization/optimization-problem.js';
import { createSolver }                 from '../../finance/optimization/solvers/solver-registry.js';
import { ServiceRegistry }              from '../../services/service-registry.js';

/**
 * OptimizationController — domain logic for the Optimization tab.
 *
 * No DOM references. Builds an OptimizationProblem from the panel config and
 * runs the selected solver (design 38), returning structured results. The exact
 * GRID solver is the default; pattern search / annealing / random are selected
 * via solverKey with their own option knobs.
 */
export class OptimizationController {
  /**
   * Execute an optimization asynchronously with the selected solver.
   *
   * @param {object}   opts
   * @param {Array}    [opts.optimizationConfigs] - Search-space configs. Defaults to DEFAULT_OPTIMIZATION_CONFIGS.
   * @param {object}   [opts.objective]           - Named objective from OPTIMIZATION_OBJECTIVES.
   * @param {string}   [opts.objectiveKey]        - Key of the objective (e.g. 'MAX_NET_WORTH').
   * @param {string}   [opts.solverKey='GRID']    - Key from SOLVER_REGISTRY.
   * @param {object}   [opts.solverOptions={}]    - Solver knobs (budget, seed, …).
   * @param {object}   [opts.baseParams={}]       - Scenario params applied to every candidate.
   * @param {Date}     opts.simStart              - Simulation start date.
   * @param {Date}     opts.simEnd                - Simulation end date.
   * @param {Function} [opts.onProgress]          - Called with (completed, total) after each run.
   * @returns {Promise<{ candidates, best, totalRuns, objective, objectiveKey, solverKey }>}
   */
  async runOptimization({
    optimizationConfigs = DEFAULT_OPTIMIZATION_CONFIGS,
    objective           = OPTIMIZATION_OBJECTIVES.MAX_NET_WORTH,
    objectiveKey        = 'MAX_NET_WORTH',
    solverKey           = 'GRID',
    solverOptions       = {},
    baseParams          = {},
    simStart,
    simEnd,
    onProgress,
  }) {
    // Design 15 §2.3: snapshot the active scenario cfg as the per-iteration template.
    const cfgTemplate = ServiceRegistry.getInstance().scenarioService?.getActive() ?? null;

    const problem = new OptimizationProblem({
      variables:    optimizationConfigs.filter(c => c.enabled),
      baseParams,
      objective,
      simStart,
      simEnd,
      initialState: { kind: 'compile', cfgTemplate },
    });

    const solver = createSolver(solverKey, solverOptions);
    const { candidates, best, evaluations } = await solver.solve(problem, { onProgress });

    return {
      candidates,
      best,
      totalRuns: evaluations,
      objective: objective.label,
      objectiveKey,
      solverKey,
    };
  }
}
