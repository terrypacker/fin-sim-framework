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
    this._fieldStore       = null;       // shared FieldSeriesStore, read to backfill on activation
    this._liveAfter        = new Map();  // path → ms of the last backfilled point (see activatePath)
    this._labels           = new Map();  // path → legend/chip label shown (a watch's own label wins)
    this._autoLabels       = new Map();  // path → the context label fixed at activation
    this._axes             = new Map();  // path → 'left' | 'right': a watch entry's axis override
    this._formatter        = null;       // FieldFormatter over the stamped registry (R2)
    this._onChipRemove     = null;       // chip ✕ callback (R7.3)
    this._drainExecEndMsgs = () => [];
  }

  /**
   * Inject the shared FieldSeriesStore. The chart only READS it, to backfill a path
   * when it is activated; WatchCapture fills it (design 101 W2).
   */
  set fieldStore(store) { this._fieldStore = store ?? null; }

  /** Callback (path) when an active-series chip's ✕ is clicked (R7.3). */
  set onChipRemove(fn) { this._onChipRemove = fn ?? null; }

  /**
   * Inject the FieldFormatter (design 101 R2). A series' kind (axis bucket) and its
   * legend/chip label then come from the app's stamped registry, not state-paths'
   * unstamped module default (R-9).
   */
  set formatter(f) { this._formatter = f ?? null; }

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
      label.textContent = this._labels.get(path) ?? path.split('.').pop().replace(/\[.*?\]/g, '');
      label.title = path;
      const x = document.createElement('button');
      x.className = 'wb-series-chip-x';
      x.textContent = '✕';
      x.title = 'Hide from chart (stays in the watchlist)';
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
      const ms   = new Date(msg.date).getTime();
      for (const path of this._activePaths) {
        // WatchCapture appends synchronously while this queue drains a frame later, so
        // a path activated mid-run was backfilled with points still waiting here.
        const after = this._liveAfter.get(path);
        if (after !== undefined) {
          if (ms <= after) continue;
          this._liveAfter.delete(path);
        }
        const value = get(snap, path);
        if (typeof value === 'number' && isFinite(value)) {
          data[path] = value;
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
    this._liveAfter.clear();
    // The view's reset drops each series' kind and label; the selection survives, so
    // restore them, or a rate series replays on the left (money) axis.
    for (const path of this._activePaths) this._describeToView(path);
  }

  // ── Active set / watchlist / promote ──────────────────────────────────────────

  /** Register a path in the active set + view (kind, label) without backfilling. */
  _activate(path) {
    this._activePaths.add(path);
    this._controller.discoverKey(path, groupFor(path));
    if (this._formatter) {
      const auto = this._uniqueLabel(path, this._formatter.contextLabel(path));
      this._autoLabels.set(path, auto);
      this._labels.set(path, auto);
    }
    this._describeToView(path);
    this._view.setDatasetVisible(path, true);
    this._renderChips();
  }

  /** Tell the view a series' kind (its axis) and label. */
  _describeToView(path) {
    const kind = this._formatter?.describe(path).kind ?? typeForPath(path)?.kind ?? 'unknown';
    this._view.setSeriesKind(path, kind);
    const label = this._labels.get(path);
    if (label) this._view.setSeriesLabel?.(path, label);
    const axis = this._axes.get(path);
    if (axis) this._view.setSeriesAxis?.(path, axis);
  }

  /**
   * Apply each charted watch entry's own label and axis (design 101 W3). A label the
   * user gave replaces the context label; clearing it restores that label. An axis
   * other than 'auto' puts the series on that side whatever its kind, which is how a
   * 100-based index is kept off a millions-of-dollars axis (§6.4).
   * @param {{ path: string, label: string|null, axis: string }[]} entries
   */
  applySeriesMeta(entries) {
    let chipsDirty = false;
    for (const { path, label, axis } of entries ?? []) {
      if (!this._activePaths.has(path)) continue;
      const nextLabel = label || this._autoLabels.get(path);
      if (nextLabel && nextLabel !== this._labels.get(path)) {
        this._labels.set(path, nextLabel);
        this._view.setSeriesLabel?.(path, nextLabel);
        chipsDirty = true;
      }
      const nextAxis = axis === 'left' || axis === 'right' ? axis : 'auto';
      if (nextAxis !== (this._axes.get(path) ?? 'auto')) {
        if (nextAxis === 'auto') this._axes.delete(path); else this._axes.set(path, nextAxis);
        this._view.setSeriesAxis?.(path, nextAxis);
      }
    }
    if (chipsDirty) this._renderChips();
  }

  /**
   * The label, suffixed "(2)", "(3)" when another charted series already shows it.
   * The chart keys legend state by name, so two equal names would toggle together.
   */
  _uniqueLabel(path, base) {
    const taken = new Set([...this._labels].filter(([p]) => p !== path).map(([, l]) => l));
    let label = base;
    for (let n = 2; taken.has(label); n++) label = `${base} (${n})`;
    return label;
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
      if (!backfilled && series.length > 0) this._liveAfter.set(path, new Date(series.at(-1).date).getTime());
    }
  }

  /** Remove `path` from the active set and drop its series from the chart. */
  deactivatePath(path) {
    this._activePaths.delete(path);
    this._liveAfter.delete(path);
    this._labels.delete(path);
    this._autoLabels.delete(path);
    this._axes.delete(path);
    this._setBackfilled(path, false);
    this._view.removeSeries?.(path);
    this._renderChips();
  }

  /** Whether `path` is currently charted. */
  isPathActive(path) {
    return this._activePaths.has(path);
  }

  /**
   * Make the active set exactly `paths`: the charted entries of the active watchlist
   * (design 101 W2). Only the difference is touched, so a series already on the chart
   * keeps its data, and a newly charted one is backfilled from the store.
   * @param {string[]} paths
   * @param {import('../state/field-series-store.js').FieldSeriesStore} [fieldStore]
   */
  syncActivePaths(paths, fieldStore = null) {
    const want = new Set(paths ?? []);
    for (const path of [...this._activePaths]) if (!want.has(path)) this.deactivatePath(path);
    for (const path of want) if (!this._activePaths.has(path)) this.activatePath(path, fieldStore);
  }

  // ── Annotations / passthrough ───────────────────────────────────────────────────

  resize()                 { this._view.resize(); }
  addAnnotation(id, opts)  { this._view.addAnnotation(id, opts); }
  removeAnnotation(id)     { this._view.removeAnnotation(id); }
}
