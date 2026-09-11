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
import { IntlRetirementMcConfig }     from '../../finance/monte-carlo/intl-retirement-mc-config.js';
import { ServiceRegistry }             from '../../services/service-registry.js';
import { McWorkerPool }                from '../../finance/monte-carlo/parallel/mc-worker-pool.js';

/**
 * MonteCarloController — domain logic for the MC tab.
 *
 * No DOM references.  Accepts configuration, delegates to
 * IntlRetirementMcRunner, and returns structured results.
 *
 * Owns the MC worker pool (design 89 §21.7). Before it, the tab ran every iteration
 * on the main thread — the loop yields BETWEEN iterations only, so at ~530 ms an
 * iteration the UI froze in half-second hitches, and the opt-in `spending` telemetry
 * (7.5x, §20.2) was simply unusable in the browser. On the pool the sims leave the
 * main thread entirely and run one-per-core.
 *
 * The pool is lazy, controller-owned and reused across runs — starting a worker means
 * parsing the whole scenario module graph in it, which should be paid once per session
 * and not once per Run click. Same shape as the MPC cockpit's pool
 * (`mpc-cockpit-plugin.js`), including the `typeof Worker` guard that keeps it out of
 * Node tests and SSR.
 */
export class MonteCarloController {
  constructor({ parallel = true } = {}) {
    this._parallel = parallel;
    this._pool     = undefined;   // lazy; `null` once we know there are no workers
  }

  /** The controller-owned pool, or null where Web Workers don't exist. */
  _workerPool() {
    if (!this._parallel || typeof Worker === 'undefined') return null;
    if (this._pool === undefined) this._pool = new McWorkerPool();
    return this._pool;
  }

  /** Terminate the pool on teardown so worker threads don't leak. */
  destroy() {
    if (this._pool) { this._pool.terminate(); this._pool = undefined; }
  }
  /**
   * Execute a Monte Carlo batch asynchronously.
   *
   * @param {object}                 opts
   * @param {Date}                   opts.simStart       - Simulation start date.
   * @param {Date}                   opts.simEnd         - Simulation end date.
   * @param {number}                 [opts.n=100]        - Iteration count.
   * @param {IntlRetirementMcConfig} [opts.mcConfig]     - Config that builds the variable list.
   * @param {object}                 [opts.baseParams={}]- Scenario params that override defaults.
   * @param {boolean}                [opts.mix=false]    - Record the per-year asset mix (design 82 §8).
   * @param {boolean}                [opts.spending=false] - Record classified spending (design 89 §20).
   * @param {Function}               [opts.onProgress]   - Called with (completed, total) after each run.
   * @returns {Promise<{ runs: Array, summary: object }>}
   */
  async runMonteCarlo({
    simStart, simEnd, n = 100, mcConfig = new IntlRetirementMcConfig(), baseParams = {},
    mix = false, spending = false, onProgress,
  }) {
    // Design 15 §2.3: snapshot the active scenario cfg as the per-iteration template
    // so non-param edits (planned sale year, life expectancy, etc.) are honored.
    const cfgTemplate = ServiceRegistry.getInstance().scenarioService?.getActive() ?? null;
    const runner = new IntlRetirementMcRunner({
      n, mcConfig, simStart, simEnd, cfgTemplate, mix, spending, workerPool: this._workerPool(),
    });
    return runner.run(baseParams, onProgress);
  }
}
