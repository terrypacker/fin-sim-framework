/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { getAppStorage } from '../../storage/create-storage.js';
import { STORAGE_KEYS }  from '../../storage/storage-keys.js';

/**
 * Persists DecisionGraph configs through a StorageAdapter.
 * Mirrors ScenarioStorage.
 */
export class DecisionGraphStorage {
  static STORAGE_KEY = STORAGE_KEYS.DECISION_GRAPHS;

  /**
   * @param {import('../../storage/storage-adapter.js').StorageAdapter} [storage]
   *        defaults to the shared app storage; pass one explicitly to isolate.
   */
  constructor(storage = getAppStorage()) {
    this._storage = storage;
  }

  load() {
    try {
      const raw = this._storage.getItem(DecisionGraphStorage.STORAGE_KEY);
      if (raw) return JSON.parse(raw);
    } catch (e) {
      console.warn('[DecisionGraphStorage] Failed to load:', e);
    }
    return { graphs: [] };
  }

  save(data) {
    try {
      this._storage.setItem(DecisionGraphStorage.STORAGE_KEY, JSON.stringify(data));
    } catch (e) {
      console.warn('[DecisionGraphStorage] Failed to save:', e);
    }
  }
}
