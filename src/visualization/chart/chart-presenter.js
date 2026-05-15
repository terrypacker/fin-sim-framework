/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { BaseComponent }               from '../components/base-component.js';
import { MapFilterMultiSelect }        from '../components/map-filter-multi-select.js';
import { EXECUTION_KINDS, EXECUTION_PHASES } from '../../simulation-framework/bus-messages.js';

/**
 * Wires ChartController and ChartView together and owns the metric filter.
 *
 * Exposes the same surface as ChartView so callers (SimulationAnimator,
 * TimeControls, BaseApp) can treat this as a drop-in replacement:
 *   wireSimBus(simBus)
 *   addSnapshot(date, data)
 *   setRenderThrottle(ms)    — inherited from BaseComponent
 *   resetHistory()
 *   startViz()
 *   stopViz()
 *   addAnnotation(id, opts)
 *   removeAnnotation(id)
 *
 * Filter state (which metrics are hidden) survives rewinds, so users can
 * configure the filter after one run and have it apply on replay.
 */
export class ChartPresenter extends BaseComponent {
  /**
   * @param {{
   *   controller: import('./chart-controller.js').ChartController,
   *   view:       import('./chart-view.js').ChartView
   * }}
   */
  constructor({ controller, view }) {
    super();
    this._controller    = controller;
    this._view          = view;
    this._processedKeys = new Set();
    this._metricFilter  = null;
    this._drainExecEndMsgs = () => [];
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────────

  startViz() {
    this._view.startViz();
    this._mountFilter();
  }

  stopViz() {
    this._metricFilter?.destroy();
    this._metricFilter = null;
    this._view.stopViz();
  }

  // ── Simulation bus ────────────────────────────────────────────────────────────

  /**
   * Subscribe to EXECUTION_END(EVENT) to receive metric snapshots directly from
   * the simulation bus. Call once per scenario after scenario.buildSim().
   * Processes every queued message (no data dropped) at each render frame.
   */
  wireSimBus(simBus) {
    this._drainExecEndMsgs = this.busQueue(
      simBus,
      `EXECUTION_${EXECUTION_PHASES.END}`,
      () => this.render(),
      { kind: EXECUTION_KINDS.EVENT }
    );
  }

  render() {
    this.scheduleRender(() => this._doRender());
  }

  _doRender() {
    for (const msg of this._drainExecEndMsgs()) {
      const metrics = msg.stateSnapshot?.metrics ? { ...msg.stateSnapshot.metrics } : {};
      this.addSnapshot(msg.date, metrics);
    }
  }

  // ── Data ingestion ────────────────────────────────────────────────────────────

  /**
   * Forward snapshot to the view and apply current visibility state to any
   * newly discovered metric keys.
   */
  addSnapshot(date, data) {
    this._view.addSnapshot(date, data);
    for (const key of Object.keys(data ?? {})) {
      if (this._processedKeys.has(key)) continue;
      this._processedKeys.add(key);
      this._controller.discoverKey(key);
      if (!this._controller.isVisible(key)) {
        this._view.setDatasetVisible(key, false);
      }
    }
  }

  // ── History (called by TimeControls on rewind) ────────────────────────────────

  /**
   * Clear chart data. Hidden-key selection in the controller is preserved so
   * the filter applies immediately when the simulation replays.
   */
  resetHistory() {
    this._view.resetHistory();
    this._processedKeys.clear();
  }

  // ── Annotations ───────────────────────────────────────────────────────────────

  addAnnotation(id, opts)  { this._view.addAnnotation(id, opts); }
  removeAnnotation(id)     { this._view.removeAnnotation(id); }

  // ── Private ───────────────────────────────────────────────────────────────────

  _mountFilter() {
    if (this._metricFilter) return;
    const filterBarEl = this._view.mountFilterBar();
    if (!filterBarEl) return;

    this._metricFilter = new MapFilterMultiSelect({
      parent:    this._view,
      container: filterBarEl.querySelector('#chart-metric-select'),
      queryApi:  this._controller.getQueryApi(),
      onToggle:  (_item, _added, selectedItems) => {
        if (selectedItems.length === 0) {
          this._controller.clearHidden();
          for (const key of this._controller.getAllKeys()) {
            this._view.setDatasetVisible(key, true);
          }
        } else {
          const selectedIds = new Set(selectedItems.map(s => s.id));
          for (const key of this._controller.getAllKeys()) {
            const visible = selectedIds.has(key);
            this._controller.setVisible(key, visible);
            this._view.setDatasetVisible(key, visible);
          }
        }
      },
    });
  }
}
