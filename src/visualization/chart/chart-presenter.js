/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { BaseComponent }            from '../components/base-component.js';
import { groupFor, typeForPath }    from '../state/state-paths.js';
import { get }                      from '../../finance/monte-carlo/mc-param-paths.js';
import { EXECUTION_KINDS, EXECUTION_PHASES } from '../../simulation-framework/bus-messages.js';

/**
 * Wires ChartController and ChartView together; owns the chart's **active set**.
 *
 * Design 31 / R1 — allow-list ingestion (the hang fix):
 *   The chart no longer flattens the whole state on every event. It keeps an
 *   `_activePaths` set and, per event, reads *only* those paths from the
 *   stateSnapshot (via mc-param-paths `get()`), so per-frame cost is O(|active|)
 *   rather than O(|state|). Selection lives in the State panel (the chart filter
 *   widget was removed in R2); paths are activated via `activatePath()` (the
 *   state-panel "+"/checkbox) and seeded from the scenario watchlist.
 *
 * Interim default (pre R9.0/R12): curated `metrics.*` are auto-charted so the
 * chart is non-empty out of the box, matching v1. R12 will replace this with a
 * single seeded `metrics.netWorth`.
 *
 * Exposes the same surface as ChartView so callers (SimulationAnimator,
 * TimeControls) can treat this as a drop-in replacement: wireSimBus, resetHistory,
 * startViz, stopViz, addAnnotation, removeAnnotation, resize, setRenderThrottle.
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
    this._controller       = controller;
    this._view             = view;
    this._activePaths      = new Set();
    this._backfilledPaths  = new Set();  // active paths currently shown at snapshot resolution (R10.1)
    this._fieldStore       = null;       // shared FieldSeriesStore for live buffering (R10.3)
    this._onChipRemove     = null;       // chip ✕ callback (R7.3)
    this._drainExecEndMsgs = () => [];
  }

  /** Inject the shared FieldSeriesStore so charted paths get full-res live buffers (R10.3). */
  set fieldStore(store) { this._fieldStore = store ?? null; }

  /** Callback (path) when an active-series chip's ✕ is clicked (R7.3). */
  set onChipRemove(fn) { this._onChipRemove = fn ?? null; }

  /** Snapshot of the active paths, for the active-series chip strip (R7.3). */
  get activePaths() { return [...this._activePaths]; }

  /** Render the active-series chip strip into #chartActiveSeries (R7.3). */
  _renderChips() {
    const host = (typeof document !== 'undefined') && document.getElementById('chartActiveSeries');
    if (!host) return;
    host.replaceChildren();
    for (const path of this._activePaths) {
      const chip = document.createElement('span');
      chip.className = 'wb-series-chip';
      if (this._backfilledPaths.has(path)) chip.classList.add('is-backfilled');
      const label = document.createElement('span');
      label.textContent = path.split('.').pop().replace(/\[.*?\]/g, '');
      label.title = path;
      const x = document.createElement('button');
      x.className = 'wb-series-chip-x';
      x.textContent = '✕';
      x.title = 'Remove from chart';
      x.addEventListener('click', () => this._onChipRemove?.(path));
      chip.append(label, x);
      host.appendChild(chip);
    }
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────────

  startViz() { this._view.startViz(); }
  stopViz()  { this._view.stopViz();  }

  // ── Simulation bus ────────────────────────────────────────────────────────────

  /**
   * Subscribe to EXECUTION_END(EVENT) to receive state snapshots directly from
   * the simulation bus. Call once per scenario after scenario.buildSim().
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
      const snap = msg.stateSnapshot;
      if (!snap || this._activePaths.size === 0) continue;

      // Allow-list: read ONLY the active set from the snapshot (the hang fix).
      const data = {};
      for (const path of this._activePaths) {
        const value = get(snap, path);
        if (typeof value === 'number' && isFinite(value)) {
          data[path] = value;
          this._fieldStore?.append(path, msg.date, value);  // R10.3: full-res live buffer
          if (this._backfilledPaths.has(path)) this._setBackfilled(path, false); // live now (R10.1)
        }
      }
      if (Object.keys(data).length > 0) this._view.addSnapshot(msg.date, data);
    }
  }

  // ── Data ingestion ────────────────────────────────────────────────────────────

  /** Thin forwarder retained for direct callers/tests. */
  addSnapshot(date, data) {
    this._view.addSnapshot(date, data);
  }

  // ── History (called by TimeControls on rewind) ────────────────────────────────

  /**
   * Clear chart data. The active-path selection survives a rewind so replay
   * re-plots the same series.
   */
  resetHistory() {
    this._view.resetHistory();
    this._backfilledPaths.clear();   // replay re-ingests live data, clearing any coarse badge
  }

  // ── Active set / watchlist / promote ──────────────────────────────────────────

  /** Register a path in the active set + view (kind, label) without backfilling. */
  _activate(path) {
    this._activePaths.add(path);
    this._controller.discoverKey(path, groupFor(path));
    this._view.setSeriesKind(path, typeForPath(path)?.kind ?? 'unknown');
    this._view.setDatasetVisible(path, true);
    this._renderChips();
  }

  /** Mark/unmark a series as backfilled (coarse) so the view can dash it (R10.1). */
  _setBackfilled(path, on) {
    const had = this._backfilledPaths.has(path);
    if (on) this._backfilledPaths.add(path); else this._backfilledPaths.delete(path);
    this._view.setSeriesBackfilled?.(path, on);
    if (had !== on) this._renderChips();
  }

  /**
   * Make `path` an active chart series. If a run already completed, backfill its
   * history from the store (live full-res if available, else snapshot resolution, D2).
   * @param {string} path
   * @param {import('../state/field-series-store.js').FieldSeriesStore} [fieldStore]
   */
  activatePath(path, fieldStore = null) {
    this._activate(path);
    const store = fieldStore ?? this._fieldStore;
    if (store) {
      const { series, backfilled } = store.getOrBackfill(path);
      for (const { date, value } of series) {
        this._view.addSnapshot(date, { [path]: value });
      }
      this._setBackfilled(path, backfilled && series.length > 0);
    }
  }

  /** Remove `path` from the active set and drop its series from the chart. */
  deactivatePath(path) {
    this._activePaths.delete(path);
    this._setBackfilled(path, false);
    this._view.removeSeries?.(path);
    this._renderChips();
  }

  /** Whether `path` is currently charted. */
  isPathActive(path) {
    return this._activePaths.has(path);
  }

  /**
   * Seed the chart from a scenario's watchlist on scenario load.
   * @param {string[]} watchlists
   * @param {import('../state/field-series-store.js').FieldSeriesStore} [fieldStore]
   */
  seedWatchlist(watchlists, fieldStore = null) {
    for (const path of (watchlists ?? [])) {
      this.activatePath(path, fieldStore);
    }
  }

  // ── Annotations / passthrough ───────────────────────────────────────────────────

  resize()                 { this._view.resize(); }
  addAnnotation(id, opts)  { this._view.addAnnotation(id, opts); }
  removeAnnotation(id)     { this._view.removeAnnotation(id); }
}
