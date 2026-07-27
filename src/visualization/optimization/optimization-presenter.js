/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { OptConfigPanel }     from './opt-config-panel.js';
import { OptResultsPanel }    from './opt-results-panel.js';
import { OptRunsPanel }       from './opt-runs-panel.js';
import { buildOptVariables }  from '../../finance/optimization/intl-retirement-opt-config.js';
import { set }                from '../../finance/monte-carlo/mc-param-paths.js';
import { scenarioParamValues } from '../../finance/param-schema-utils.js';
import { ServiceRegistry }    from '../../services/service-registry.js';
import { APP_EVENTS }         from '../app-display-settings.js';

/**
 * OptimizationPresenter — wires OptConfigPanel callbacks to OptimizationController
 * and drives OptResultsPanel / OptRunsPanel with results.
 *
 * Recreated each time initScenario() runs (same pattern as MonteCarloPresenter).
 */
export class OptimizationPresenter {
  /**
   * @param {object} opts
   * @param {import('./optimization-controller.js').OptimizationController} opts.controller
   * @param {import('./optimization-view.js').OptimizationView}             opts.view
   * @param {object}                                                        opts.scenario
   */
  constructor({ controller, view, scenario, appBus = null }) {
    this._controller = controller;
    this._view       = view;
    this._scenario   = scenario;
    this._lastResult = null;
    this._unsubSettings = null;

    this._configPanel  = new OptConfigPanel(view.configPane);
    this._resultsPanel = new OptResultsPanel(view.resultsPane);
    this._runsPanel    = new OptRunsPanel(view.runsPane);

    this._configPanel.onRun              = (config)    => this._onRun(config);
    this._runsPanel.onCandidateSelected  = (candidate) => {
      this.onApplyCandidate?.(this._mergeParams(candidate));
    };

    // Populate panel with the full dynamic variable list (including per-shock rows)
    const baseParams = this._resolveBaseParams();
    // Pass the scenario's accounts so the Lever-B drawdown-weight axes are pruned
    // to roles an account actually backs (design 58 build-time filter).
    this._configPanel.setVariables(buildOptVariables(baseParams, this._scenario?.accounts));

    /** Set by WorkbenchApp: onApplyCandidate(mergedParams) */
    this.onApplyCandidate = null;

    // Re-render results in the active display currency on change (design 10 §Phase 4).
    if (appBus) {
      this._unsubSettings = appBus.subscribe(APP_EVENTS.DISPLAY_SETTINGS_CHANGED, () => {
        if (!this._lastResult) return;
        this._resultsPanel.showResults(this._lastResult);
        this._runsPanel.showResults(this._lastResult);
      });
    }
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────────

  destroy() {
    this._unsubSettings?.();
    this._configPanel.destroy();
    this._resultsPanel.destroy();
    this._runsPanel.destroy();
    this._view.destroy();
  }

  // ── Result access ─────────────────────────────────────────────────────────────

  getLastResult() { return this._lastResult; }

  // ── Private ───────────────────────────────────────────────────────────────────

  _onRun(config) {
    const { optimizationConfigs, objective, objectiveKey, candidateCount, solverKey, solverOptions } = config;
    this._configPanel.showProgress(`Running 0 / ${candidateCount}…`);

    requestAnimationFrame(() => {
      this._controller.runOptimization({
        optimizationConfigs,
        objective,
        objectiveKey,
        solverKey,
        solverOptions,
        baseParams:  this._resolveBaseParams(),
        simStart:    this._scenario.simStart,
        simEnd:      this._scenario.simEnd,
        onProgress:  (done, total) => {
          this._configPanel.showProgress(`Running ${done} / ${total}…`);
        },
      }).then(result => {
        this._lastResult = result;
        this._configPanel.showProgress(`Completed ${result.totalRuns} candidates`);
        this._configPanel.enableRun();
        this._resultsPanel.showResults(result);
        this._runsPanel.showResults(result);
      }).catch(err => {
        this._configPanel.showProgress(`Error: ${err.message}`);
        this._configPanel.enableRun();
        console.error('[OptimizationPresenter] run failed', err);
      });
    });
  }

  /**
   * Merge the selected candidate's param overrides into the current base params
   * to produce a full replay param set.
   */
  _mergeParams(candidateEntry) {
    const base = this._resolveBaseParams();
    for (const [k, v] of Object.entries(candidateEntry.candidate)) {
      set(base, k, v);
    }
    return base;
  }

  /**
   * The param snapshot the search space is built from and every candidate runs on.
   *
   * The ACTIVE CFG is the live record — the scenario editor writes into its typed
   * `params` array by reference — so it beats the scenario INSTANCE's bag, which is
   * frozen at the last Rebuild. That staleness is not cosmetic here: `buildOptVariables`
   * reads these params to synthesize the per-shock / expense-band / Roth-schedule axes
   * and to evaluate each variable's `visibleWhen`, so a stale snapshot silently drops
   * whole DIMENSIONS from the search rather than merely mis-labelling one.
   *
   * Deliberately NO `resolveBalanceCenters()` here, unlike the MC presenter: MC writes
   * a value for every variable each iteration and so must carry the true balance,
   * whereas Opt only writes the keys a candidate actually searches. Injecting balance
   * keys would push them through the `balanceTarget` alias cascade and rescale holdings
   * on every rollout for no gain.
   */
  _resolveBaseParams() {
    const activeCfg = ServiceRegistry.getInstance()?.scenarioService?.getActive?.() ?? null;
    const instance  = this._scenario?.params;
    const snapshot  = (instance && !Array.isArray(instance)) ? instance : {};
    return { ...snapshot, ...scenarioParamValues(activeCfg) };
  }
}
