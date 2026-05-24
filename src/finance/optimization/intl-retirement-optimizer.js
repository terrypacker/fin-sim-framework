/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { ServiceRegistry }          from '../../services/service-registry.js';
import { IntlRetirementScenario }   from '../../scenarios/intl-retirement-scenario.js';
import { computeNetWorthUsd }       from '../monte-carlo/intl-retirement-mc-runner.js';
import { DEFAULT_OPTIMIZATION_CONFIGS } from './intl-retirement-opt-config.js';
import { OPTIMIZATION_OBJECTIVES, OPT_PARAM_TYPES } from './optimization-objectives.js';

/**
 * Expand a single optimization config into the concrete values it covers.
 */
export function valuesForConfig(cfg) {
  if (cfg.type === OPT_PARAM_TYPES.ENUM) return cfg.values.slice();
  const vals = [];
  for (let v = cfg.min; v <= cfg.max + 1e-9; v += cfg.step) {
    vals.push(cfg.type === OPT_PARAM_TYPES.INTEGER ? Math.round(v) : v);
  }
  return vals;
}

function cartesianProduct(arrays) {
  if (arrays.length === 0) return [[]];
  return arrays.reduce(
    (acc, arr) => acc.flatMap(a => arr.map(b => [...a, b])),
    [[]]
  );
}

/**
 * Grid-search optimizer for the IntlRetirementScenario.
 *
 * Enumerates the Cartesian product of all enabled optimization config ranges,
 * runs a deterministic simulation for each candidate, and returns results
 * sorted by objective score (best first).
 *
 * Each run result:
 *   candidate          — the param overrides that were applied
 *   result             — { finalNetWorthUsd, scenarioFailed, cumulativeDeficit,
 *                          deficitMonths, rothFinalBalance }
 *   score              — raw objective value (unsigned; direction already applied internally)
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
   */
  constructor({
    optimizationConfigs = DEFAULT_OPTIMIZATION_CONFIGS,
    objective           = OPTIMIZATION_OBJECTIVES.MAX_NET_WORTH,
    simStart            = new Date(Date.UTC(2026, 0, 1)),
    simEnd              = new Date(Date.UTC(2041, 0, 1)),
  } = {}) {
    this.optimizationConfigs = optimizationConfigs;
    this.objective           = objective;
    this.simStart            = simStart;
    this.simEnd              = simEnd;
  }

  /**
   * Total number of simulation runs that will be executed.
   * Useful for displaying progress before the run starts.
   */
  candidateCount() {
    const enabled = this.optimizationConfigs.filter(c => c.enabled);
    if (enabled.length === 0) return 1;
    return enabled.reduce((n, cfg) => n * valuesForConfig(cfg).length, 1);
  }

  /**
   * Run the grid search asynchronously, yielding between iterations for UI responsiveness.
   *
   * @param {object}   [baseParams={}]  - Scenario params applied to every candidate.
   * @param {Function} [onProgress]     - Called with (completed, total) after each run.
   * @returns {Promise<{ candidates, best, totalRuns, objective }>}
   */
  async run(baseParams = {}, onProgress) {
    const candidates   = this._generateCandidates();
    const totalRuns    = candidates.length;
    const results      = [];
    const { evaluate, direction } = this.objective;
    const sign         = direction === 'minimize' ? -1 : 1;

    for (let i = 0; i < totalRuns; i++) {
      const params = { ...baseParams, endDate: this.simEnd, ...candidates[i] };
      const result = this._runOne(params);
      const score  = sign * evaluate(result);
      results.push({ candidate: candidates[i], result, score });
      if (onProgress) onProgress(i + 1, totalRuns);
      await new Promise(resolve => setTimeout(resolve, 0));
    }

    results.sort((a, b) => b.score - a.score);
    return {
      candidates:  results,
      best:        results[0] ?? null,
      totalRuns,
      objective:   this.objective.label,
    };
  }

  _runOne(params) {
    ServiceRegistry.reset();
    const scenario = new IntlRetirementScenario({
      context:  ServiceRegistry.getInstance().simulationContext,
      params,
      simStart: this.simStart,
      simEnd:   this.simEnd,
    });
    scenario.buildSim();
    scenario.loadDefaults();
    scenario.sim.silent = true;
    scenario.sim.stepTo(params.endDate);
    const state = scenario.sim.state;
    return {
      finalNetWorthUsd:  computeNetWorthUsd(state),
      scenarioFailed:    state.scenarioFailed    ?? false,
      cumulativeDeficit: state.cumulativeDeficit ?? 0,
      deficitMonths:     state.deficitMonths     ?? 0,
      rothFinalBalance:  (state.rothAccount?.balance ?? 0) + (state.spouseRothAccount?.balance ?? 0),
    };
  }

  _generateCandidates() {
    const enabled   = this.optimizationConfigs.filter(c => c.enabled);
    if (enabled.length === 0) return [{}];

    const paramKeys = enabled.map(c => c.paramKey);
    const valueSets = enabled.map(c => valuesForConfig(c));
    const combos    = cartesianProduct(valueSets);

    return combos.map(combo => {
      const candidate = {};
      paramKeys.forEach((k, i) => { candidate[k] = combo[i]; });
      return candidate;
    });
  }
}
