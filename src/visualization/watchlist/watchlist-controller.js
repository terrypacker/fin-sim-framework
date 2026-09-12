/*
 * Copyright (c) 2026 Terry Packer.
 *
 * This file is part of Terry Packer's Work.
 * See www.terrypacker.com for further info.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { WatchlistModel, LEGACY_LIST_NAME, balanceCopyKeys } from './watchlist-model.js';
import { WB_EVENTS } from '../workbench/workbench-runtime.js';

/**
 * WatchlistController — design 101 W2. One per loaded scenario; built by
 * WorkbenchApp.initScenario and replaced on the next Rebuild.
 *
 * It owns the scenario's WatchlistModel and keeps everything that reads it in step
 * on every change:
 *   - persists the lists into the scenario cfg (§8.1); loading alone never writes;
 *   - the chart plots the ACTIVE list's charted entries (W-D1);
 *   - WatchCapture buffers every entry of every list (W-D2);
 *   - the State panel's checkboxes mean "in the active list" (W-D4) and its picker
 *     names that list;
 *   - other panels hear WB_EVENTS.WATCHLIST_CHANGED and act through facade() (W-D7).
 *
 * The chart chip ✕ un-charts and leaves the entry in the list (W-D5).
 */
export class WatchlistController {
  /**
   * @param {object}  opts
   * @param {object}  opts.cfg          the loaded scenario cfg (read, and written on change)
   * @param {object}  opts.chart        ChartPresenter (syncActivePaths)
   * @param {object}  [opts.fieldStore] FieldSeriesStore, for backfill on activation
   * @param {object}  [opts.capture]    WatchCapture (setPaths)
   * @param {object}  [opts.statePanel] StatePanelView (setWatchlists, render)
   * @param {object}  [opts.bus]        the workbench bus
   */
  constructor({ cfg, chart, fieldStore = null, capture = null, statePanel = null, bus = null }) {
    this._cfg        = cfg ?? null;
    this._chart      = chart ?? null;
    this._fieldStore = fieldStore;
    this._capture    = capture;
    this._statePanel = statePanel;
    this._bus        = bus;
    this.model       = WatchlistModel.fromCfg(cfg);
    this._off        = this.model.onChange(evt => this._onChange(evt));
  }

  /** Push the loaded lists to the chart, capture and State panel, and announce them. */
  start() {
    this._sync();
    this._publish({ reason: 'load', watchlistId: this.model.activeId });
  }

  // ── Gestures ──────────────────────────────────────────────────────────────

  /** Whether the State panel checkbox for `path` is checked: in the active list. */
  isWatched(path) {
    return this.model.has(path);
  }

  /**
   * The State panel checkbox. Checking adds a charted entry to the active list, so
   * the field appears on the chart as it always has; unchecking removes the entry.
   * With no list at all, checking creates one rather than doing nothing.
   */
  toggleWatched(path, on) {
    return on ? this._add(path, { charted: true }) : this.model.remove(path);
  }

  /** The chart chip ✕: take the line off the chart, keep the watch (W-D5). */
  uncharted(path) {
    return this.model.setCharted(path, false);
  }

  /** The State panel picker. */
  selectList(id) {
    return this.model.setActive(id);
  }

  /**
   * The cross-panel contract (§8): `runtime.watchlist`. A panel produces by adding a
   * path it already shows, and consumes by reading `active()` and `series(path)` on
   * WATCHLIST_CHANGED. The maintenance half serves the Watchlist panel (W3).
   * Entry operations act on the active list.
   */
  facade() {
    const m = this.model;
    return {
      has:        path => m.has(path),
      add:        (path, opts = {}) => this._add(path, opts),
      remove:     path => m.remove(path),
      active:     () => m.active(),
      /** Every list as { id, name, size }. */
      lists:      () => m.lists.map(({ id, name, entries }) => ({ id, name, size: entries.length })),
      activeId:   () => m.activeId,
      setActive:  id => m.setActive(id),
      create:     name => m.create(name),
      rename:     (id, name) => m.rename(id, name),
      duplicate:  id => m.duplicate(id),
      delete:     id => m.delete(id),
      setCharted: (path, on) => m.setCharted(path, on),
      setLabel:   (path, label) => m.setLabel(path, label),
      setAxis:    (path, axis) => m.setAxis(path, axis),
      moveEntry:  (from, to) => m.moveEntry(from, to),
      /** The path's full-resolution captured series, [{ date, value }] (W-D2). */
      series:     path => this._fieldStore?.get(path) ?? [],
      /**
       * The best series there is, and whether it is snapshot backfill: a field watched
       * only after the run has no live capture (W4 series CSV).
       */
      seriesWithResolution: path => this._fieldStore?.getOrBackfill?.(path)
        ?? { series: this._fieldStore?.get(path) ?? [], backfilled: false },
      /** Lists with their entries, for a definition export: every list, or those in `ids`. */
      definitionLists: (ids = null) => m.lists
        .filter(l => ids == null || ids.includes(l.id))
        .map(({ name, entries }) => ({ name, entries })),
      /** Append lists from a definition file (W4), aliased for this scenario. @returns {string[]} */
      importLists: lists => m.importLists(lists, balanceCopyKeys(this._cfg)),
    };
  }

  destroy() {
    this._off?.();
    this._off = null;
  }

  // ── Private ───────────────────────────────────────────────────────────────

  _add(path, opts) {
    if (this.model.activeId == null) this.model.create(LEGACY_LIST_NAME);
    return this.model.add(path, opts);
  }

  _onChange(evt) {
    if (this._cfg) this.model.applyTo(this._cfg);
    this._sync();
    this._publish(evt);
  }

  _sync() {
    const charted = (this.model.active()?.entries ?? []).filter(e => e.charted);
    this._chart?.syncActivePaths(charted.map(e => e.path), this._fieldStore);
    this._chart?.applySeriesMeta?.(charted);   // each entry's own label and axis (W3)
    this._capture?.setPaths(this.model.capturePaths());
    this._statePanel?.setWatchlists?.(this.model.lists.map(({ id, name }) => ({ id, name })), this.model.activeId);
    this._statePanel?.render?.();   // coalesced: checkboxes follow the active list
  }

  _publish(evt) {
    this._bus?.publish({ type: WB_EVENTS.WATCHLIST_CHANGED, ...evt });
  }
}
