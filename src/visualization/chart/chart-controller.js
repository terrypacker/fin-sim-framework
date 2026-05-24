/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import {QueryApi} from "../../query/query-api.js";

/**
 * Tracks which metric keys are known and which are hidden.
 * Persists hidden-key selection across rewinds so the filter survives replay.
 */
export class ChartController {
  constructor() {
    this._knownKeys = new Map(); // key → { id, name }
    this._hiddenKeys = new Set();
  }

  /**
   * Register a metric key on first encounter.
   * @returns {boolean} true if the key was newly added
   */
  discoverKey(key) {
    if (this._knownKeys.has(key)) return false;
    const name = key
      .replace(/([A-Z])/g, ' $1')
      .replace(/_/g, ' ')
      .replace(/\b\w/g, c => c.toUpperCase())
      .trim();
    this._knownKeys.set(key, { id: key, name });
    return true;
  }

  isVisible(key) {
    return !this._hiddenKeys.has(key);
  }

  setVisible(key, visible) {
    if (visible) {
      this._hiddenKeys.delete(key);
    } else {
      this._hiddenKeys.add(key);
    }
  }

  clearHidden() {
    this._hiddenKeys.clear();
  }

  getAllKeys() {
    return [...this._knownKeys.keys()];
  }

  /**
   * Returns a duck-typed query API compatible with MapFilterMultiSelect.
   * Each item is { id: key, name: humanLabel }.
   */
  getQueryApi() {
    return new QueryApi({getAll: () => [...this._knownKeys.values()]});
  }
}
