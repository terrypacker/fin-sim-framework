/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { get } from '../../finance/monte-carlo/mc-param-paths.js';

/**
 * Path-keyed time-series store for the state-panel field history modal.
 *
 * Live buffers (appended from EXECUTION_END events) carry full simulation
 * resolution. Post-hoc backfill from SimulationHistory is at snapshot
 * granularity (default ≈ 1/year) and is flagged backfilled: true (D2).
 *
 * Injected into StatePanelView via the `fieldSeriesStore` setter.
 * SimulationHistory is injected via `simulationHistory` setter.
 */
export class FieldSeriesStore {
  constructor() {
    this._buffers = new Map(); // path → [{date,value}]
    this._simHistory = null;
  }

  /** Inject the active SimulationHistory after buildSim(). */
  set simulationHistory(h) {
    this._simHistory = h ?? null;
  }

  /**
   * Append a live data point for a path (full simulation resolution).
   * No-op for non-finite values. Unbounded: the *count* of buffered paths is
   * bounded by the active set (design 31 / R10.2), so per-series length need not be.
   */
  append(path, date, value) {
    if (typeof value !== 'number' || !isFinite(value)) return;
    if (!this._buffers.has(path)) this._buffers.set(path, []);
    this._buffers.get(path).push({ date: new Date(date), value });
  }

  /**
   * Get the live buffer for a path, or null if not yet buffered.
   */
  get(path) {
    return this._buffers.get(path) ?? null;
  }

  /**
   * Backfill a path from SimulationHistory snapshots at snapshot granularity.
   * Each point carries backfilled: true so the UI can show the coarser
   * resolution affordance (D2).
   *
   * @returns {{ date: Date, value: number, backfilled: true }[]} — empty if no history available
   */
  backfill(path) {
    if (!this._simHistory) return [];
    const series = [];
    for (const snap of this._simHistory.snapshots) {
      const value = get(snap.state, path);
      if (typeof value === 'number' && isFinite(value)) {
        series.push({ date: new Date(snap.date), value, backfilled: true });
      }
    }
    return series;
  }

  /**
   * Return the best available history for a path:
   *   - live buffer if it has data (full resolution, backfilled: false)
   *   - snapshot backfill otherwise (coarse resolution, backfilled: true)
   *
   * @returns {{ series: {date,value}[], backfilled: boolean }}
   */
  getOrBackfill(path) {
    const live = this.get(path);
    if (live && live.length > 0) return { series: live, backfilled: false };
    const series = this.backfill(path);
    return { series, backfilled: series.length > 0 };
  }

  /** Clear all live buffers (call on rewind/replay). */
  clear() {
    this._buffers.clear();
  }
}
