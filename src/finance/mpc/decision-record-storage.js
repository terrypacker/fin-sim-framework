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
 * Persists MPC decision records through a StorageAdapter.
 * Mirrors ScenarioStorage / DecisionGraphStorage.
 *
 * Its OWN key (design 39 §13, H4). Decision records must never enter
 * `fin-sim-scenarios` — that is the Step 5c bug this design keeps fixed. They were
 * session-only until harvest (§13) made an un-harvested run worth keeping across a
 * page reload.
 */
export class DecisionRecordStorage {
  static STORAGE_KEY = STORAGE_KEYS.DECISION_RECORDS;

  /**
   * @param {import('../../storage/storage-adapter.js').StorageAdapter} [storage]
   *        defaults to the shared app storage; pass one explicitly to isolate.
   */
  constructor(storage = getAppStorage()) {
    this._storage = storage;
  }

  load() {
    try {
      const raw = this._storage.getItem(DecisionRecordStorage.STORAGE_KEY);
      if (raw) return JSON.parse(raw);
    } catch (e) {
      console.warn('[DecisionRecordStorage] Failed to load:', e);
    }
    return { records: [] };
  }

  save(data) {
    try {
      this._storage.setItem(DecisionRecordStorage.STORAGE_KEY, JSON.stringify(data));
    } catch (e) {
      console.warn('[DecisionRecordStorage] Failed to save:', e);
    }
  }
}
