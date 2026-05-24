/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { IntlRetirementOptimizer }     from '../../finance/optimization/intl-retirement-optimizer.js';
import { DEFAULT_OPTIMIZATION_CONFIGS } from '../../finance/optimization/intl-retirement-opt-config.js';
import { OPTIMIZATION_OBJECTIVES }      from '../../finance/optimization/optimization-objectives.js';
import { ServiceRegistry }              from '../../services/service-registry.js';

/**
 * OptimizationController — domain logic for the Optimization tab.
 *
 * No DOM references. Accepts configuration, delegates to
 * IntlRetirementOptimizer, and returns structured results.
 */
export class OptimizationController {
  /**
   * Execute a grid-search optimization asynchronously.
   *
   * @param {object}   opts
   * @param {Array}    [opts.optimizationConfigs] - Search-space configs. Defaults to DEFAULT_OPTIMIZATION_CONFIGS.
   * @param {object}   [opts.objective]           - Named objective from OPTIMIZATION_OBJECTIVES.
   * @param {string}   [opts.objectiveKey]        - Key of the objective (e.g. 'MAX_NET_WORTH').
   * @param {object}   [opts.baseParams={}]       - Scenario params applied to every candidate.
   * @param {Date}     opts.simStart              - Simulation start date.
   * @param {Date}     opts.simEnd                - Simulation end date.
   * @param {Function} [opts.onProgress]          - Called with (completed, total) after each run.
   * @returns {Promise<{ candidates, best, totalRuns, objective, objectiveKey }>}
   */
  async runOptimization({
    optimizationConfigs = DEFAULT_OPTIMIZATION_CONFIGS,
    objective           = OPTIMIZATION_OBJECTIVES.MAX_NET_WORTH,
    objectiveKey        = 'MAX_NET_WORTH',
    baseParams          = {},
    simStart,
    simEnd,
    onProgress,
  }) {
    // Design 15 §2.3: snapshot the active scenario cfg as the per-iteration template.
    const cfgTemplate = ServiceRegistry.getInstance().scenarioService?.getActive() ?? null;
    const optimizer = new IntlRetirementOptimizer({
      optimizationConfigs,
      objective,
      simStart,
      simEnd,
      cfgTemplate,
    });
    const result = await optimizer.run(baseParams, onProgress);
    return { ...result, objectiveKey };
  }
}
