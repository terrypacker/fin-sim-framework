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
import { RolloutWorkerPool }            from '../../finance/optimization/parallel/rollout-worker-pool.js';

/**
 * OptimizationController — domain logic for the Optimization tab.
 *
 * No DOM references. Builds an OptimizationProblem from the panel config and
 * runs the selected solver (design 38), returning structured results. The exact
 * GRID solver is the default; pattern search / annealing / random are selected
 * via solverKey with their own option knobs.
 *
 * Owns a rollout worker pool, so no simulation runs on the main thread. Before it,
 * a CEM generation (32 rollouts back to back, ~19 s) froze the page long enough
 * for Chrome to offer "Page Unresponsive". Batch solvers (grid, CEM, LHS random, the
 * QP gradient) roll across every core; the sequential ones (pattern search,
 * annealing) still roll one at a time, but in a worker. Lazy, controller-owned and
 * reused across runs, with the same `typeof Worker` guard as the MC controller
 * (`monte-carlo-controller.js`), which keeps it out of Node tests.
 */
export class OptimizationController {
  constructor({ parallel = true } = {}) {
    this._parallel = parallel;
    this._pool     = undefined;   // lazy
  }

  /** The controller-owned pool, or null where Web Workers don't exist. */
  _workerPool() {
    if (!this._parallel || typeof Worker === 'undefined') return null;
    if (this._pool === undefined) this._pool = new RolloutWorkerPool();
    return this._pool;
  }

  /** Terminate the pool on teardown so worker threads don't leak. */
  destroy() {
    if (this._pool) { this._pool.terminate(); this._pool = undefined; }
  }

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
    let solved;
    try {
      solved = await solver.solve(problem, { onProgress, workerPool: this._workerPool() });
    } catch (err) {
      // A worker-level error poisons the pool for good; drop it so the next Run
      // respawns instead of failing instantly on the same dead workers.
      this.destroy();
      throw err;
    }
    const { candidates, best, evaluations } = solved;

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
