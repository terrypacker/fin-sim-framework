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

import { get } from '../../finance/monte-carlo/mc-param-paths.js';
import { EXECUTION_KINDS, EXECUTION_PHASES } from '../../simulation-framework/bus-messages.js';

/**
 * WatchCapture — design 101 W2. Buffers every watched path into the FieldSeriesStore
 * at full simulation resolution, whether or not it is charted.
 *
 * The capture set is the union of every entry in every watchlist (W-D2), so switching
 * lists or charting a watched field mid-run never falls back to coarse snapshot
 * backfill. Before W2 this loop lived in ChartPresenter._doRender and captured only
 * what was charted.
 *
 * It subscribes synchronously, one append per watched path per event: O(|capture
 * set|), UI runs only. MC workers never construct one.
 */
export class WatchCapture {
  /** @param {{ fieldStore: import('../state/field-series-store.js').FieldSeriesStore }} opts */
  constructor({ fieldStore }) {
    this._store = fieldStore ?? null;
    this._paths = [];
    this._unsub = null;
  }

  /** Replace the capture set. Takes effect from the next event. */
  setPaths(paths) {
    this._paths = [...new Set(paths ?? [])];
  }

  /** The current capture set. */
  get paths() { return [...this._paths]; }

  /**
   * Capture from EXECUTION_END(EVENT) on the per-run sim bus. Call once per
   * scenario after buildSim(); re-wiring drops the previous subscription.
   */
  wireSimBus(simBus) {
    this._unsub?.();
    this._unsub = simBus.subscribe(
      `EXECUTION_${EXECUTION_PHASES.END}`,
      { kind: EXECUTION_KINDS.EVENT },
      msg => this._capture(msg),
    );
  }

  _capture(msg) {
    const snap = msg?.stateSnapshot;
    if (!snap || !this._store || this._paths.length === 0) return;
    // The store ignores a non-finite value, so a path absent at this date is skipped.
    for (const path of this._paths) this._store.append(path, msg.date, get(snap, path));
  }

  destroy() {
    this._unsub?.();
    this._unsub = null;
  }
}
