/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { BaseComponent }                from '../components/base-component.js';
import { DgConfigPanel }               from './dg-config-panel.js';
import { DgResultsPanel }              from './dg-results-panel.js';
import { DecisionGraphRunner }         from '../../finance/decision-graph/decision-graph-runner.js';
import { IntlRetirementScenario } from '../../scenarios/intl-retirement-scenario.js';

/**
 * DecisionGraphPresenter — orchestrates the DG config and results panels.
 *
 * Mirrors MonteCarloPresenter: thin coordinator, no domain logic.
 *
 * Set onCompareLeaf(leafEntry, baseEntry) to wire the per-leaf Compare button
 * into the scenario-compare tab.
 */
export class DecisionGraphPresenter extends BaseComponent {
  /**
   * @param {object} opts
   * @param {HTMLElement|null} opts.configContainerEl  — #dgConfigPane
   * @param {HTMLElement|null} opts.resultsContainerEl — #dgResultsPane
   * @param {object}           opts.dgRegistry         — DecisionGraphRegistry
   * @param {object}           opts.scenarioRegistry   — ScenarioRegistry
   * @param {object}           [opts.resultStorage]    — DecisionGraphResultStorage (optional)
   */
  constructor({ configContainerEl, resultsContainerEl, dgRegistry, scenarioRegistry, resultStorage = null }) {
    super();
    this._dgRegistry       = dgRegistry;
    this._scenarioRegistry = scenarioRegistry;
    this._resultStorage    = resultStorage;

    /** @type {Function|null} Wired by WorkbenchApp */
    this.onCompareLeaf = null;

    this._configPanel  = configContainerEl
      ? new DgConfigPanel(configContainerEl, dgRegistry, scenarioRegistry, IntlRetirementScenario.buildFullParamSchema(), resultStorage)
      : null;
    this._resultsPanel = resultsContainerEl
      ? new DgResultsPanel(resultsContainerEl)
      : null;

    if (this._configPanel) {
      this._configPanel.onRun = (dg) => this._onRun(dg);
      this._configPanel.onLoadResult = (dg) => this._onLoadResult(dg);
    }

    if (this._resultsPanel) {
      this._resultsPanel.onCompareLeaf = (leafEntry, baseEntry) => {
        this.onCompareLeaf?.(leafEntry, baseEntry);
      };
    }
  }

  destroy() {
    this._configPanel?.destroy();
    this._resultsPanel?.destroy();
  }

  // ── Private ────────────────────────────────────────────────────────────────

  async _onRun(dg) {
    const baseEntry = this._scenarioRegistry?.get(dg.baseScenarioId);
    if (!baseEntry) {
      this._configPanel?.setStatus(`Error: scenario '${dg.baseScenarioId}' not found`);
      return;
    }

    this._configPanel?.setStatus('Running…');
    this._resultsPanel?.showRunning();

    const runner = new DecisionGraphRunner({ scenarioRegistry: this._scenarioRegistry });

    try {
      const result = await runner.run(dg, (done, total, leafDone, leafTotal) => {
        this._configPanel?.setStatus(
          `Leaf ${leafDone + 1}/${leafTotal} — draw ${done % (dg.mcDrawsPerLeaf ?? 100)}/${dg.mcDrawsPerLeaf ?? 100}`
        );
      });

      if (dg.persistLeaves && this._resultStorage) {
        this._resultStorage.saveResult(dg.id, result);
        this._configPanel?._refreshList();
      }

      this._configPanel?.setStatus(`Done — ${result.leaves.length} leaves`);
      this._resultsPanel?.showResults(result, baseEntry);
    } catch (err) {
      this._configPanel?.setStatus(`Error: ${err.message}`);
      console.error('[DecisionGraphPresenter] run failed', err);
    }
  }

  _onLoadResult(dg) {
    const result = this._resultStorage?.loadResult(dg.id);
    if (!result) return;
    const baseEntry = this._scenarioRegistry?.get(dg.baseScenarioId);
    this._configPanel?.setStatus(`Loaded persisted result — ${result.leaves?.length ?? 0} leaves`);
    this._resultsPanel?.showResults(result, baseEntry ?? null);
  }
}
