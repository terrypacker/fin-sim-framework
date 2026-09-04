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
import { IntlRetirementMcConfig, refineCenterSource } from '../../finance/monte-carlo/intl-retirement-mc-config.js';
import { resolveBalanceCenters, IntlRetirementScenario } from '../../scenarios/intl-retirement-scenario.js';
import { scenarioParamValues, paramSchemaDefaults } from '../../finance/param-schema-utils.js';
import { ServiceRegistry }         from '../../services/service-registry.js';
import { APP_EVENTS }              from '../app-display-settings.js';

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
  constructor({ controller, view, scenario, appBus = null }) {
    this._controller    = controller;
    this._view          = view;
    this._scenario      = scenario;
    this._lastResult    = null;
    this._unsubSettings = null;

    this._configPanel  = new McConfigPanel(view.configPane);
    this._resultsPanel = new McResultsPanel(view.resultsPane);
    this._runsPanel    = new McRunsPanel(view.runsPane);

    this._configPanel.onRun              = (config)  => this._onRun(config);
    this._configPanel.onCopyFromScenario = ()        => this._onCopyFromScenario();
    // Lets the panel re-centre untouched variables on the live scenario at run time,
    // so a run always describes the plan as it stands rather than as it was loaded.
    this._configPanel.onResolveScenarioCenters = ()  => this._scenarioCenters();
    this._runsPanel.onRunSelected        = (run)     => this.onReplayRun?.(run);
    this._runsPanel.onClearReplaySeed    = ()        => this.onClearReplaySeed?.();
    this._resultsPanel.onMetricChange = (metric) => {
      if (this._lastResult) {
        this._runsPanel.showResults(this._lastResult.summary, this._lastResult.runs, metric);
      }
    };

    // Populate panel with the full dynamic variable list (including per-shock rows),
    // each row carrying the provenance of its center.
    this._configPanel.setVariables(this._resolveVariables());

    /** Set by WorkbenchApp to handle replay: onReplayRun(run) */
    this.onReplayRun = null;
    /** Set by WorkbenchApp: unpin the replay seed and rebuild. */
    this.onClearReplaySeed = null;

    // Re-render results in the active display currency on change (design 10 §Phase 4).
    if (appBus) {
      this._unsubSettings = appBus.subscribe(APP_EVENTS.DISPLAY_SETTINGS_CHANGED, () => {
        if (!this._lastResult) return;
        this._resultsPanel.showResults(this._lastResult.summary, this._lastResult.runs);
        this._runsPanel.showResults(this._lastResult.summary, this._lastResult.runs, this._resultsPanel._metric);
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

  // ── Result access (for sub-panels in Session 5) ───────────────────────────────

  /** Returns the last { runs, summary } result, or null if no run yet. */
  getLastResult() { return this._lastResult; }

  /**
   * Re-present a result computed BEFORE the current presenter existed.
   *
   * Replaying a run rebuilds the scenario, and the rebuild recreates this presenter —
   * so the batch the user was reading vanished at the exact moment they asked to look
   * into one of its runs, and the only way back was to re-run it. WorkbenchApp carries
   * the result across the rebuild and hands it back here.
   *
   * @param {{runs: Array, summary: object}} result
   * @param {number|null} [replaySeed] the run the live scenario is now pinned to
   */
  restoreResult(result, replaySeed = null) {
    if (!result?.runs) return;
    this._lastResult = result;
    this._resultsPanel.showResults(result.summary, result.runs);
    this._runsPanel.setReplaySeed(replaySeed);
    this._runsPanel.showResults(result.summary, result.runs, this._resultsPanel._metric);
    this._configPanel.setStatus(`Showing ${result.runs.length} runs from the last batch.`);
  }

  // ── Private ───────────────────────────────────────────────────────────────────

  /**
   * The variable list as the RUNNER will resolve it, each row tagged with where its
   * center comes from (see CENTER_SOURCES).
   *
   * The schema-defaults layer is added here and NOT in `_resolveBaseParams()` on
   * purpose. The runner layers it in weakest-first; `_resolveBaseParams()` is handed
   * to the runner as `baseParams`, its STRONGEST layer, so folding schema defaults
   * into that would let a stale `stockBalance` default outrank the account's real
   * balance. Here it only affects what the panel displays — which is exactly the
   * point, since the panel should show the value the sim will actually run at.
   */
  _resolveVariables() {
    const ownParams      = this._resolveBaseParams();
    const schemaDefaults = paramSchemaDefaults(IntlRetirementScenario.buildFullParamSchema());
    const vars = new IntlRetirementMcConfig().buildVariables({ ...schemaDefaults, ...ownParams });
    return vars.map(v => ({ ...v, centerSource: refineCenterSource(v, { ownParams, schemaDefaults }) }));
  }

  /**
   * The live scenario's value for every MC variable, as Map(paramKey → value).
   *
   * Rebuilds the variable list against the current scenario params so each variable
   * carries a freshly-resolved `defaultValue` (the scenario value at its paramKey).
   * Fully generic: any MC variable, including ones added later, is covered because
   * its scenario value flows through buildVariables() — no per-param wiring here.
   */
  _scenarioCenters() {
    return new Map(this._resolveVariables().map(v => [v.paramKey, v.defaultValue]));
  }

  /** Copy the live scenario parameter values into the MC variable centers. */
  _onCopyFromScenario() {
    const count = this._configPanel.applyScenarioValues(this._scenarioCenters());
    this._configPanel.setStatus(`Copied ${count} scenario value${count === 1 ? '' : 's'} into variable centers.`);
  }

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
        this._runsPanel.showResults(result.summary, result.runs, this._resultsPanel._metric);
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
    // The ACTIVE CFG is the live record — the scenario editor writes into its typed
    // `params` array by reference — so it beats the scenario INSTANCE's bag, which is
    // a snapshot frozen at the last Rebuild. Reading only the instance is how a panel
    // ends up centered on a plan the user has already edited away from.
    const activeCfg = ServiceRegistry.getInstance()?.scenarioService?.getActive?.() ?? null;
    const instance  = this._scenario?.params;
    const snapshot  = (instance && !Array.isArray(instance)) ? instance : {};
    // Balance MC levers key on legacy flat keys whose value lives on the account records
    // (a holdings-bearing balance isn't a plain param), so resolve them from the cfg;
    // they win over the params bag, which can hold a stale copy.
    return { ...snapshot, ...scenarioParamValues(activeCfg), ...resolveBalanceCenters(activeCfg) };
  }
}
