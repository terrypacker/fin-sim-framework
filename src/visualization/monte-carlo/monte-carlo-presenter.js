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
import { resolveAliasCenters } from '../../scenarios/scenario-param-apply.js';
import { scenarioParamValues, paramSchemaDefaults } from '../../finance/param-schema-utils.js';
import { ServiceRegistry }         from '../../services/service-registry.js';
import { APP_EVENTS }              from '../app-display-settings.js';
import { buildOptVariables }       from '../../finance/optimization/intl-retirement-opt-config.js';
import { get }                     from '../../finance/monte-carlo/mc-param-paths.js';
import { formatDuration, formatAxisValue } from './mc-grid-format.js';
import { gridCellRuns }            from '../../finance/monte-carlo/mc-grid-runner.js';

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
    // { result, keptAt } — the batch later runs are compared against (design 100 §5).
    // In memory only; WorkbenchApp carries it across a rebuild like the result itself.
    this._baseline      = null;
    // The last lever grid (design 100 §7), and which of the two the results pane shows.
    this._lastGrid      = null;
    this._showing       = 'batch';
    this._gridView      = { ref: null, sel: null };   // the grid's reference and selected cells
    this._gridRuns      = new Map();                  // cell → run records (see gridCellRuns)
    // Wall-clock ms per path from the last run: the grid's cost estimate (§7.2).
    this._msPerPath     = null;
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
    this._configPanel.onRunGrid          = (config)  => this._onRunGrid(config);
    this._resultsPanel.onGridCellSelected = (view)   => this._onGridCellSelected(view);
    this._resultsPanel.onKeepBaseline  = () => this.keepBaseline();
    this._resultsPanel.onClearBaseline = () => this.clearBaseline();
    this._resultsPanel.onMetricChange = (metric) => {
      if (this._lastResult) {
        this._runsPanel.showResults(this._lastResult.summary, this._lastResult.runs, metric);
      }
    };

    // Populate panel with the full dynamic variable list (including per-shock rows),
    // each row carrying the provenance of its center.
    this._configPanel.setVariables(this._resolveVariables());
    this._configPanel.setGridAxes(this._resolveGridAxes());

    /** Set by WorkbenchApp to handle replay: onReplayRun(run) */
    this.onReplayRun = null;
    /** Set by WorkbenchApp: unpin the replay seed and rebuild. */
    this.onClearReplaySeed = null;

    // Re-render results in the active display currency on change (design 10 §Phase 4).
    if (appBus) {
      this._unsubSettings = appBus.subscribe(APP_EVENTS.DISPLAY_SETTINGS_CHANGED, () => {
        if (this._showing === 'grid' && this._lastGrid) {
          this._resultsPanel.showGrid(this._lastGrid, this._gridView);
          return;
        }
        if (!this._lastResult) return;
        this._showResult(this._lastResult);
        this._runsPanel.showResults(this._lastResult.summary, this._lastResult.runs, this._resultsPanel._metric);
      });
    }
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────────

  destroy() {
    this._unsubSettings?.();
    // The controller owns the MC worker pool; a rebuild recreates this presenter, so
    // without this every Rebuild would leak a poolful of worker threads.
    this._controller.destroy?.();
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
    this._showResult(result);
    this._runsPanel.setReplaySeed(replaySeed);
    this._runsPanel.showResults(result.summary, result.runs, this._resultsPanel._metric);
    this._configPanel.setStatus(`Showing ${result.runs.length} runs from the last batch.`);
  }

  // ── Baseline slot (design 100 §5) ─────────────────────────────────────────────

  /** Pin the current result; later results are shown against it, path by path. */
  keepBaseline() {
    if (!this._lastResult) return;
    this._baseline = { result: this._lastResult, keptAt: new Date() };
    this._showResult(this._lastResult);
    this._configPanel.setStatus('Kept as baseline. The next run is compared against it.');
  }

  clearBaseline() {
    this._baseline = null;
    if (this._lastResult) this._showResult(this._lastResult);
  }

  /** The `{ result, keptAt }` baseline, or null — for WorkbenchApp's rebuild carry. */
  getBaseline() { return this._baseline; }

  /** Re-install a baseline kept by a previous presenter (see `restoreResult`). */
  restoreBaseline(baseline) {
    if (!baseline?.result?.runs) return;
    this._baseline = baseline;
    if (this._lastResult) this._showResult(this._lastResult);
  }

  // ── Private ───────────────────────────────────────────────────────────────────

  _showResult(result) {
    this._showing = 'batch';
    this._runsPanel.setContext(null);
    this._resultsPanel.showResults(result.summary, result.runs, { baseline: this._baseline });
  }

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
    // The active cfg lets the harvest reach generated per-record params (design 98 W3).
    const activeCfg      = ServiceRegistry.getInstance()?.scenarioService?.getActive?.() ?? null;
    const vars = new IntlRetirementMcConfig().buildVariables({ ...schemaDefaults, ...ownParams }, { cfg: activeCfg });
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
    const { n, variableConfigs, mix = false, spending = false } = config;
    const mcConfig = IntlRetirementMcConfig.fromVariableConfigs(variableConfigs);
    const started  = performance.now();
    this._configPanel.showProgress(`Running 0 / ${n}…`);

    // rAF lets the browser paint the "Running" status before async work starts.
    requestAnimationFrame(() => {
      this._controller.runMonteCarlo({
        simStart:       this._scenario.simStart,
        simEnd:         this._scenario.simEnd,
        n,
        mcConfig,
        mix,
        spending,
        baseParams:     this._resolveBaseParams(),
        onProgress:     (done, total) => {
          this._configPanel.showProgress(`Running ${done} / ${total}…`);
        },
      }).then(result => {
        this._lastResult = result;
        // Spending runs at ~7.5x (design 89 §20) and a grid never records it, so its rate
        // would overstate a grid's cost several times over.
        if (!spending) this._recordPathRate(started, n);
        const errored = result.summary.erroredRuns?.length ?? 0;
        this._configPanel.showProgress(errored
          ? `Completed ${n - errored} runs — ${errored} errored and excluded (see console)`
          : `Completed ${n} runs`);
        this._configPanel.enableRun();
        this._showResult(result);
        this._runsPanel.showResults(result.summary, result.runs, this._resultsPanel._metric);
      }).catch(err => {
        this._configPanel.showProgress(`Error: ${err.message}`);
        this._configPanel.enableRun();
        console.error('[MonteCarloPresenter] run failed', err);
      });
    });
  }

  /** Run a lever grid (design 100 §7) and show it in the results pane. */
  _onRunGrid(config) {
    const { n, variableConfigs, axes, mode, runs } = config;
    const mcConfig = IntlRetirementMcConfig.fromVariableConfigs(variableConfigs);
    const started  = performance.now();
    this._configPanel.showProgress(`Grid: 0 / ${runs} runs…`);

    requestAnimationFrame(() => {
      this._controller.runGrid({
        simStart:   this._scenario.simStart,
        simEnd:     this._scenario.simEnd,
        n, mcConfig, axes, mode,
        baseParams: this._resolveBaseParams(),
        onProgress: (done, total) => {
          const left = done ? ((performance.now() - started) / done) * (total - done) : null;
          this._configPanel.showProgress(`Grid: ${done} / ${total} runs`
            + (left != null && done < total ? ` · about ${formatDuration(left)} left` : ''));
        },
      }).then(grid => {
        this._lastGrid = grid;
        this._showing  = 'grid';
        this._gridRuns = new Map();
        this._gridView = { ref: null, sel: null };
        this._recordPathRate(started, runs);
        const errored = grid.cells.reduce((s, c) => s + (c.errored?.length ?? 0), 0);
        this._configPanel.showProgress(`Completed grid: ${grid.cells.length} cells, ${runs} runs`
          + (errored ? ` — ${errored} errored and excluded (see console)` : ''));
        this._configPanel.enableRun();
        this._resultsPanel.showGrid(grid);
      }).catch(err => {
        this._configPanel.showProgress(`Error: ${err.message}`);
        this._configPanel.enableRun();
        console.error('[MonteCarloPresenter] grid run failed', err);
      });
    });
  }

  /**
   * List the paths of the grid cell being read in the Runs panel, with their params, so
   * a grid path can be inspected and replayed like a batch run. A context line names the
   * cell, because seed N exists in every cell.
   */
  _onGridCellSelected({ ref, sel, shown }) {
    this._gridView = { ref, sel };
    const g = this._lastGrid;
    if (!g?.cells?.[shown]) return;
    if (!this._gridRuns.has(shown)) this._gridRuns.set(shown, gridCellRuns(g, shown));
    const runs  = this._gridRuns.get(shown);
    const label = g.axes.map((a, k) => `${a.label} ${formatAxisValue(g.cells[shown].values[k])}`).join(', ');
    this._runsPanel.setContext(`Grid cell — ${label}${shown === ref ? ' (reference)' : ''} · `
      + `${runs.length} path${runs.length === 1 ? '' : 's'}`);
    this._runsPanel.showResults({ p50: g.cells[shown].summary.p50 }, runs, 'netWorthUsd');
  }

  /** The grid and how it is being read, for WorkbenchApp's rebuild carry; null with no grid. */
  getGridState() {
    return this._lastGrid ? { grid: this._lastGrid, showing: this._showing, ...this._gridView } : null;
  }

  /**
   * Re-install a grid carried across a rebuild. Replaying a grid path rebuilds the
   * scenario, and without this the grid vanished at the moment one of its runs was
   * being looked into, the same problem `restoreResult` solves for a batch.
   */
  restoreGrid(state, replaySeed = null) {
    if (!state?.grid?.cells) return;
    this._lastGrid = state.grid;
    this._gridRuns = new Map();
    this._gridView = { ref: state.ref ?? null, sel: state.sel ?? null };
    if (state.showing !== 'grid') return;
    this._showing = 'grid';
    this._runsPanel.setReplaySeed(replaySeed);
    this._resultsPanel.showGrid(state.grid, this._gridView);
    this._configPanel.setStatus(`Showing the last grid: ${state.grid.cells.length} cells.`);
  }

  /** Wall-clock ms per path from a finished run, for the grid's cost line (design 100 §7.2). */
  _recordPathRate(started, paths) {
    if (!(paths > 0)) return;
    this._msPerPath = (performance.now() - started) / paths;
    this._configPanel.setMsPerPath(this._msPerPath);
  }

  /**
   * The levers a grid axis can be: the Opt harvest (design 100 §7.2), each with the
   * plan's value so the panel can show it. Schema defaults are layered under the plan
   * here, and only for that display value, so a lever the plan leaves at its default
   * still shows the value the sim runs at.
   */
  _resolveGridAxes() {
    const base      = this._resolveBaseParams();
    const activeCfg = ServiceRegistry.getInstance()?.scenarioService?.getActive?.() ?? null;
    const withDefaults = { ...paramSchemaDefaults(IntlRetirementScenario.buildFullParamSchema()), ...base };
    return buildOptVariables(base, this._scenario?.accounts, { cfg: activeCfg })
      .map(v => ({ ...v, planValue: get(withDefaults, v.paramKey) }));
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
    // they win over the params bag, which can hold a stale copy. Other legacy-keyed
    // levers (the house sale years, the wages) take their generated successor's value.
    return { ...snapshot, ...scenarioParamValues(activeCfg), ...resolveAliasCenters(activeCfg),
             ...resolveBalanceCenters(activeCfg) };
  }
}
