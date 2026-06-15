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
    this._configPanel.setVariables(buildOptVariables(baseParams));

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
    const { optimizationConfigs, objective, objectiveKey, candidateCount } = config;
    this._configPanel.showProgress(`Running 0 / ${candidateCount}…`);

    requestAnimationFrame(() => {
      this._controller.runOptimization({
        optimizationConfigs,
        objective,
        objectiveKey,
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

  _resolveBaseParams() {
    const raw = this._scenario?.params;
    if (!raw) return {};
    if (Array.isArray(raw)) return Object.fromEntries(raw.map(p => [p.key, p.value]));
    return typeof raw === 'object' ? { ...raw } : {};
  }
}
