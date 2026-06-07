/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Lightweight registry of known chart series (path → {id, name, group}).
 *
 * Design 31 / R2: the chart-filter multi-select was removed and selection moved
 * to the State panel, so the controller no longer tracks visibility or serves a
 * QueryApi. It now only records which paths have been activated (for labels and
 * potential future surfaces). The active set itself lives on ChartPresenter.
 */
export class ChartController {
  constructor() {
    this._knownKeys = new Map(); // key → { id, name, group }
  }

  /**
   * Register a series key on first encounter.
   * @param {string}      key   - dot-separated state path (e.g. 'metrics.netWorth')
   * @param {string|null} group - curated group label (e.g. 'Metrics', 'FX')
   * @returns {boolean} true if the key was newly added
   */
  discoverKey(key, group = null) {
    if (this._knownKeys.has(key)) return false;
    this._knownKeys.set(key, { id: key, name: _pathToLabel(key), group: group ?? '' });
    return true;
  }

  getAllKeys() {
    return [...this._knownKeys.keys()];
  }
}

function _pathToLabel(key) {
  return key.split('.')
    .map(seg => seg
      .replace(/([A-Z])/g, ' $1')
      .replace(/_/g, ' ')
      .replace(/\b\w/g, c => c.toUpperCase())
      .trim())
    .join(' › ');
}
