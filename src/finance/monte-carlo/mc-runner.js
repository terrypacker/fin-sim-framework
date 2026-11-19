/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { CENTER_SOURCES, refineCenterSource } from './mc-config.js';
import { buildIterationRunner, perturbParams, DEFAULT_MC_SCENARIO_KIND } from './parallel/mc-worker-core.js';
import { McWorkerPool } from './parallel/mc-worker-pool.js';

/**
 * The scenario-agnostic Monte Carlo batch (design 134 §4): run n index-seeded paths, serially
 * or on a worker pool, and split the paths that threw from the ones that ran.
 *
 * A scenario's runner subclasses it and supplies:
 *
 *   static scenarioKind — the worker-side descriptor its paths run under (`MC_SCENARIOS`);
 *   _prepare(base)      — the world every path runs in: `{ ctx, provenance }`, resolved once
 *                         on the main thread (template, base params, variables);
 *   run(base, onProgress) — the batch and its aggregation, which is the scenario's own:
 *                         a retirement batch reports a success rate, a farm one a loss
 *                         probability.
 *
 * Everything here was `IntlRetirementMcRunner`'s, unchanged, until the farm became the
 * second scenario to need it.
 */
export class McRunner {
  /** The worker-side scenario descriptor this runner's paths are built from. */
  static scenarioKind = DEFAULT_MC_SCENARIO_KIND;

  /**
   * @param {object}  opts
   * @param {number}  [opts.n=100]          number of paths
   * @param {object}  [opts.mcConfig]       the variable catalog (a `McConfig`)
   * @param {Date}    [opts.simStart]
   * @param {Date}    [opts.simEnd]
   * @param {object}  [opts.cfgTemplate]    the scenario every path loads
   * @param {boolean} [opts.parallel=false] run on a worker pool where `Worker` exists
   * @param {import('./parallel/mc-worker-pool.js').McWorkerPool} [opts.workerPool]
   *        a pool to reuse; caller-owned, never terminated here
   */
  constructor({
    n           = 100,
    mcConfig    = null,
    simStart    = null,
    simEnd      = null,
    cfgTemplate = null,
    parallel    = false,
    workerPool  = null,
  } = {}) {
    this.n           = n;
    this.mcConfig    = mcConfig;
    this.simStart    = simStart;
    this.simEnd      = simEnd;
    this.cfgTemplate = cfgTemplate;
    this._parallel   = parallel;
    this._pool       = workerPool;    // caller-owned: never terminated here
    this._ownsPool   = false;
  }

  /** Subclasses resolve the batch's world here. */
  _prepare(_baseParams = {}) {
    throw new Error(`${this.constructor.name} must implement _prepare`);
  }

  /**
   * Should this batch run on a worker pool?
   *
   * Three ways to answer no, and the third is the interesting one:
   *   - no pool was asked for (the default: an explicit opt-in keeps every existing
   *     caller — the lab scripts, the decision-graph runner, every test — on the
   *     exact path they run on today);
   *   - the environment has no `Worker` (Node without an injected spawn, SSR);
   *   - **a subclass overrides `_perturb`**. `_OffsetSeedMcRunner`
   *     (`decision-graph/decision-graph-runner.js`) does, to give each leaf its own
   *     seed space. A worker perturbs from the shared `perturbParams`, so it cannot
   *     see that override and would silently sample a different world. Detecting it
   *     and staying serial is the honest answer; the alternative — putting the offset
   *     in the context — is a real option if a decision graph ever needs the speed.
   */
  _poolFor(pool) {
    if (!pool) return null;
    if (this._perturb !== McRunner.prototype._perturb) {
      console.warn(`[${this.constructor.name}] \`_perturb\` is overridden; running MC serially. `
        + 'A worker cannot see the override and would sample a different world.');
      return null;
    }
    return pool;
  }

  /**
   * Run every iteration, in parallel when a pool is available and serially otherwise.
   *
   * The two paths call the SAME `buildIterationRunner`, so they agree by construction
   * rather than by review: iterations are independent and index-seeded, so a sharded
   * run is bit-identical to an ordered one.
   */
  async _runIterations(ctx, onProgress) {
    const pool = this._poolFor(this._resolvePool());
    if (pool) {
      try {
        pool.setContext(ctx);
        // Progress is reported in COMPLETION order (a count, not an index) — the one
        // thing that genuinely changes when the loop is sharded.
        return await pool.map(
          Array.from({ length: this.n }, (_, i) => i),
          { onSettled: onProgress },
        );
      } finally {
        if (this._ownsPool) { pool.terminate(); this._pool = null; this._ownsPool = false; }
      }
    }

    const iter   = buildIterationRunner(ctx);
    const mcRuns = [];
    for (let i = 0; i < this.n; i++) {
      // `this._perturb`, not the shared function, so a subclass override still governs
      // this path (see `_poolFor`).
      mcRuns.push(iter.runIteration(i, this._perturb(ctx.base, i, ctx.variables)));
      if (onProgress) onProgress(i + 1, this.n);
      // Yield to the browser so the UI stays responsive and progress is painted.
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    return mcRuns;
  }

  /**
   * Run every path and split them. A path that threw carries no result, so it cannot enter
   * the statistics — but dropping it silently would report a rate over n − k paths as if it
   * were n. It is excluded loudly instead: logged here and returned as `erroredRuns`.
   *
   * @returns {Promise<{ ctx: object, provenance: object, mcRuns: Array, erroredRuns: Array }>}
   */
  async _runAll(baseParams, onProgress) {
    const { ctx, provenance } = this._prepare(baseParams);
    const allRuns     = await this._runIterations(ctx, onProgress);
    const erroredRuns = allRuns.filter(r => r.error);
    const mcRuns      = allRuns.filter(r => !r.error);
    for (const r of erroredRuns) {
      console.error(`[${this.constructor.name}] path seed=${r.seed} threw and is excluded from the results: `
        + r.error.message);
    }
    return { ctx, provenance, mcRuns, erroredRuns };
  }

  /**
   * The pool this batch will use, if any: a caller-supplied one (reused across runs
   * and terminated by its owner), or one this runner creates and tears down when
   * `parallel` was requested and the environment actually has workers.
   */
  _resolvePool() {
    if (this._pool) return this._pool;
    if (!this._parallel || typeof Worker === 'undefined') return null;
    this._pool     = new McWorkerPool();
    this._ownsPool = true;
    return this._pool;
  }

  /**
   * Produce a perturbed parameter object for iteration i.
   *
   * Deep-clones baseParams so nested writes (e.g. shocks[N].severity) never
   * leak back into the live scenario or adjacent iterations.
   *
   * For every variable in the resolved list:
   *   - Enabled: sample from its distribution and write via set().
   *   - Disabled: if the path is absent from baseParams, fill the reference
   *     value (cfg.value ?? cfg.mean) so r.params is self-contained.
   */
  _perturb(baseParams, i, variables) {
    return perturbParams(baseParams, i, variables, this.constructor.scenarioKind);
  }
}

/**
 * Reduce a resolved variable list to a provenance record for the run summary.
 *
 * Answers "what world did these numbers come from?" — the question a failure rate
 * cannot be read without. Groups every variable by where its center came from (see
 * CENTER_SOURCES), plus the two sets that need calling out:
 *
 *   syntheticCenters — ENABLED variables centered on the MC template's hardcoded
 *                      mean because neither the scenario nor the param schema has a
 *                      value at that paramKey. Those paths are partly synthetic;
 *                      results must be labelled as such. Also warned to the console,
 *                      since nothing else would surface it.
 *   divergentCenters — centers deliberately set away from the scenario's own value.
 *                      Legitimate (that is what an override is for) but it means the
 *                      run is not centered on the plan as written.
 *
 * @param {Array}  variables                resolved variables from buildVariables()
 * @param {object} [layers]
 * @param {object} [layers.ownParams]       the loaded scenario's own param bag
 * @param {object} [layers.schemaDefaults]  key → schema defaultValue
 * @param {string} [layers.who]             the runner named in the console warning
 */
export function summarizeProvenance(variables, { ownParams = null, schemaDefaults = null, who = 'IntlRetirementMcRunner' } = {}) {
  const bySource = { scenario: [], schema: [], override: [], default: [] };
  const divergentCenters = [];
  const syntheticCenters = [];

  for (const v of variables) {
    // buildVariables can only report "resolvable in the merged bag or not"; the
    // runner knows WHICH layer answered, so it splits scenario-owned values from
    // schema defaults here — via the same function the MC panel's row tags use.
    const source = refineCenterSource(v, { ownParams, schemaDefaults });

    bySource[source]?.push(v.paramKey);
    if (v.centerDiverges) {
      divergentCenters.push({ paramKey: v.paramKey, center: v.center, scenarioValue: v.scenarioValue });
    }
    if (v.enabled && source === CENTER_SOURCES.DEFAULT) syntheticCenters.push(v.paramKey);
  }

  if (syntheticCenters.length > 0) {
    console.warn(`[${who}] sampling around FRAMEWORK DEFAULTS — the scenario `
      + `carries no value for: ${syntheticCenters.join(', ')}. Results are partly synthetic.`);
  }

  return {
    centersBySource: bySource,
    syntheticCenters,
    divergentCenters,
    /** True when every sampled center traces to the loaded scenario. */
    fromScenario: syntheticCenters.length === 0 && divergentCenters.length === 0,
  };
}

/** Median of a numeric array (ignoring null/undefined/NaN); null when empty. */
export function median(xs) {
  const v = xs.filter(x => x != null && Number.isFinite(x)).sort((a, b) => a - b);
  if (v.length === 0) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

/** Linear-interpolated percentile p∈[0,1] of a numeric array (ignoring null/NaN); null when empty. */
export function percentile(xs, p) {
  const v = xs.filter(x => x != null && Number.isFinite(x)).sort((a, b) => a - b);
  if (v.length === 0) return null;
  if (v.length === 1) return v[0];
  const idx = p * (v.length - 1);
  const lo  = Math.floor(idx), hi = Math.ceil(idx);
  return lo === hi ? v[lo] : v[lo] + (v[hi] - v[lo]) * (idx - lo);
}
