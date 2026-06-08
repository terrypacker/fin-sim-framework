/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { McConfigPanel }           from './mc-config-panel.js';
import { McResultsPanel }          from './mc-results-panel.js';
import { McRunsPanel }             from './mc-runs-panel.js';
import { IntlRetirementMcConfig }  from '../../finance/monte-carlo/intl-retirement-mc-config.js';

/**
 * MonteCarloPresenter — wires McConfigPanel callbacks to MonteCarloController
 * and drives McResultsPanel with results.
 *
 * Recreated each time initScenario() runs (same pattern as ChartPresenter).
 * Holds a reference to the current scenario for simStart/simEnd/params.
 */
export class MonteCarloPresenter {
  /**
   * @param {object} opts
   * @param {import('./monte-carlo-controller.js').MonteCarloController} opts.controller
   * @param {import('./monte-carlo-view.js').MonteCarloView}             opts.view
   * @param {object}                                                     opts.scenario
   */
  constructor({ controller, view, scenario }) {
    this._controller    = controller;
    this._view          = view;
    this._scenario      = scenario;
    this._lastResult    = null;

    this._configPanel  = new McConfigPanel(view.configPane);
    this._resultsPanel = new McResultsPanel(view.resultsPane);
    this._runsPanel    = new McRunsPanel(view.runsPane);

    this._configPanel.onRun         = (config) => this._onRun(config);
    this._runsPanel.onRunSelected   = (run)    => this.onReplayRun?.(run);

    // Populate panel with the full dynamic variable list (including per-shock rows)
    const baseParams = this._resolveBaseParams();
    this._configPanel.setVariables(new IntlRetirementMcConfig().buildVariables(baseParams));

    /** Set by WorkbenchApp to handle replay: onReplayRun(run) */
    this.onReplayRun = null;
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────────

  destroy() {
    this._configPanel.destroy();
    this._resultsPanel.destroy();
    this._runsPanel.destroy();
    this._view.destroy();
  }

  // ── Result access (for sub-panels in Session 5) ───────────────────────────────

  /** Returns the last { runs, summary } result, or null if no run yet. */
  getLastResult() { return this._lastResult; }

  // ── Private ───────────────────────────────────────────────────────────────────

  _onRun(config) {
    const { n, variableConfigs } = config;
    const mcConfig = IntlRetirementMcConfig.fromVariableConfigs(variableConfigs);
    this._configPanel.showProgress(`Running 0 / ${n}…`);

    // rAF lets the browser paint the "Running" status before async work starts.
    requestAnimationFrame(() => {
      this._controller.runMonteCarlo({
        simStart:       this._scenario.simStart,
        simEnd:         this._scenario.simEnd,
        n,
        mcConfig,
        baseParams:     this._resolveBaseParams(),
        onProgress:     (done, total) => {
          this._configPanel.showProgress(`Running ${done} / ${total}…`);
        },
      }).then(result => {
        this._lastResult = result;
        this._configPanel.showProgress(`Completed ${n} runs`);
        this._configPanel.enableRun();
        this._resultsPanel.showResults(result.summary, result.runs);
        this._runsPanel.showResults(result.summary, result.runs);
      }).catch(err => {
        this._configPanel.showProgress(`Error: ${err.message}`);
        this._configPanel.enableRun();
        console.error('[MonteCarloPresenter] run failed', err);
      });
    });
  }

  /**
   * Extract a plain-object param map from the current scenario.
   * The scenario stores params as an array [ { key, value, type } ] from the
   * scenario editor, or as a plain object when built from defaults.
   * Returns a plain object suitable for IntlRetirementMcRunner.
   */
  _resolveBaseParams() {
    const raw = this._scenario?.params;
    if (!raw) return {};
    if (Array.isArray(raw)) {
      return Object.fromEntries(raw.map(p => [p.key, p.value]));
    }
    return typeof raw === 'object' ? { ...raw } : {};
  }
}
