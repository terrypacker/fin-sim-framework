/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { IntlRetirementMcRunner }     from '../../finance/monte-carlo/intl-retirement-mc-runner.js';
import { DEFAULT_MC_VARIABLE_CONFIGS } from '../../finance/monte-carlo/intl-retirement-mc-config.js';
import { ServiceRegistry }             from '../../services/service-registry.js';

/**
 * MonteCarloController — domain logic for the MC tab.
 *
 * No DOM references.  Accepts configuration, delegates to
 * IntlRetirementMcRunner, and returns structured results.
 */
export class MonteCarloController {
  /**
   * Execute a Monte Carlo batch asynchronously.
   *
   * @param {object}   opts
   * @param {Date}     opts.simStart          - Simulation start date.
   * @param {Date}     opts.simEnd            - Simulation end date.
   * @param {number}   [opts.n=100]           - Iteration count.
   * @param {Array}    [opts.variableConfigs] - Distribution configs (defaults to DEFAULT_MC_VARIABLE_CONFIGS).
   * @param {object}   [opts.baseParams={}]   - Scenario params that override defaults.
   * @param {Function} [opts.onProgress]      - Called with (completed, total) after each run.
   * @returns {Promise<{ runs: Array, summary: object }>}
   */
  async runMonteCarlo({ simStart, simEnd, n = 100, variableConfigs = DEFAULT_MC_VARIABLE_CONFIGS, baseParams = {}, onProgress }) {
    // Design 15 §2.3: snapshot the active scenario cfg as the per-iteration template
    // so non-param edits (planned sale year, life expectancy, etc.) are honored.
    const cfgTemplate = ServiceRegistry.getInstance().scenarioService?.getActive() ?? null;
    const runner = new IntlRetirementMcRunner({ n, variableConfigs, simStart, simEnd, cfgTemplate });
    return runner.run(baseParams, onProgress);
  }
}
