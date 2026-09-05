/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { getAppStorage } from '../storage/create-storage.js';
import { STORAGE_KEYS }  from '../storage/storage-keys.js';

/**
 * Persists user scenarios through a StorageAdapter.
 *
 * The largest of the four persisted stores by a wide margin — a single
 * production scenario serializes to ~350 KB — and the reason the app outgrew
 * localStorage's ~5 MB origin cap.
 */
export class ScenarioStorage {
  static STORAGE_KEY = STORAGE_KEYS.SCENARIOS;

  /**
   * @param {import('../storage/storage-adapter.js').StorageAdapter} [storage]
   *        defaults to the shared app storage; pass one explicitly to isolate.
   */
  constructor(storage = getAppStorage()) {
    this._storage = storage;
  }

  /**
   * The persisted document, as a FRESH copy.
   *
   * `ScenarioRegistry._init` mutates what this returns and installs the result as
   * live graph nodes, so returning a shared reference would make the live graph
   * and the persisted document the same objects. `JSON.parse` guarantees the copy
   * here; a backend that ever stores live objects rather than strings must clone
   * on the way out to keep this promise.
   */
  load() {
    try {
      const raw = this._storage.getItem(ScenarioStorage.STORAGE_KEY);
      if (raw) return JSON.parse(raw);
    } catch (e) {
      console.warn('[ScenarioStorage] Failed to load scenarios:', e);
    }
    return { scenarios: [] };
  }

  /**
   * We only recieve user scenarios to save here
   * { scenarios: [...], lastUsed: 'id of active scenario' }
   * @param data
   */
  /**
   * Snapshots `data` at call time — `JSON.stringify` is what decouples the stored
   * copy from the live graph nodes the caller hands in. See _persist() in
   * ScenarioRegistry for why that boundary is load-bearing.
   */
  save(data) {
    try {
      this._storage.setItem(ScenarioStorage.STORAGE_KEY, JSON.stringify(data));
    } catch (e) {
      console.warn('[ScenarioStorage] Failed to save scenarios:', e);
    }
  }
}
