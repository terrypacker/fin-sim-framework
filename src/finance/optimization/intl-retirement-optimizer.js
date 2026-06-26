/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { DEFAULT_OPTIMIZATION_CONFIGS } from './intl-retirement-opt-config.js';
import { OPTIMIZATION_OBJECTIVES }      from './optimization-objectives.js';
import { valuesForConfig }              from './opt-values.js';
import { OptimizationProblem }          from './optimization-problem.js';
import { GridSearchSolver }             from './solvers/grid-search-solver.js';

/**
 * Grid-search optimizer for the IntlRetirementScenario.
 *
 * Now a thin shim over the design/38 seams: it constructs an
 * `OptimizationProblem` from its current args (the enabled configs become the
 * problem's search-space variables) and runs a `GridSearchSolver`. All the
 * isolated-registry simulation work lives in `OptimizationProblem.evaluate`; the
 * Cartesian enumeration lives in `GridSearchSolver`. Behaviour and return shape
 * are unchanged so existing callers (OptimizationController, the OPT panel) and
 * tests keep working with the default solver.
 *
 * Each run result:
 *   candidate          — the param overrides that were applied
 *   result             — { finalNetWorthUsd, finalNetLiquidity, scenarioFailed,
 *                          cumulativeDeficit, deficitMonths, rothFinalBalance }
 *   score              — objective value (sign already applied; higher is better)
 *
 * The aggregate return value:
 *   { candidates, best, totalRuns, objective }
 */
export class IntlRetirementOptimizer {
  /**
   * @param {object}   [opts]
   * @param {Array}    [opts.optimizationConfigs]  - Search-space config per param.
   *                                                 Defaults to DEFAULT_OPTIMIZATION_CONFIGS.
   * @param {object}   [opts.objective]            - Named objective from OPTIMIZATION_OBJECTIVES.
   *                                                 Defaults to MAX_NET_WORTH.
   * @param {Date}     [opts.simStart]             - Simulation start date.
   * @param {Date}     [opts.simEnd]               - Simulation end date.
   * @param {object}   [opts.cfgTemplate]          - Active scenario cfg to clone per run.
   */
  constructor({
    optimizationConfigs = DEFAULT_OPTIMIZATION_CONFIGS,
    objective           = OPTIMIZATION_OBJECTIVES.MAX_NET_WORTH,
    simStart            = new Date(Date.UTC(2026, 0, 1)),
    simEnd              = new Date(Date.UTC(2041, 0, 1)),
    cfgTemplate         = null,
  } = {}) {
    this.optimizationConfigs = optimizationConfigs;
    this.objective           = objective;
    this.simStart            = simStart;
    this.simEnd              = simEnd;
    this.cfgTemplate         = cfgTemplate;
  }

  /** Enabled configs only — these are the problem's search-space variables. */
  _enabledVariables() {
    return this.optimizationConfigs.filter(c => c.enabled);
  }

  /**
   * Total number of simulation runs that will be executed (exhaustive grid).
   * Useful for displaying progress before the run starts.
   */
  candidateCount() {
    const enabled = this._enabledVariables();
    if (enabled.length === 0) return 1;
    return enabled.reduce((n, cfg) => n * valuesForConfig(cfg).length, 1);
  }

  /**
   * Run the grid search asynchronously, yielding between iterations for UI
   * responsiveness.
   *
   * @param {object}   [baseParams={}]  - Scenario params applied to every candidate.
   * @param {Function} [onProgress]     - Called with (completed, total) after each run.
   * @returns {Promise<{ candidates, best, totalRuns, objective }>}
   */
  async run(baseParams = {}, onProgress) {
    const problem = new OptimizationProblem({
      variables:    this._enabledVariables(),
      baseParams,
      objective:    this.objective,
      simStart:     this.simStart,
      simEnd:       this.simEnd,
      initialState: { kind: 'compile', cfgTemplate: this.cfgTemplate },
    });

    const solver = new GridSearchSolver();
    const { candidates, best, evaluations } = await solver.solve(problem, { onProgress });

    return {
      candidates,
      best,
      totalRuns: evaluations,
      objective: this.objective.label,
    };
  }

  /**
   * Candidate list for the enabled configs (Cartesian product). Retained for
   * callers/tests that inspect enumeration directly; `run()` enumerates via the
   * GridSearchSolver over the same variables.
   */
  _generateCandidates() {
    return GridSearchSolver.enumerate(this._enabledVariables());
  }
}
