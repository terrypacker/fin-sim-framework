/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { InMemoryStorage } from '../../storage/in-memory-storage.js';

/**
 * Persists MPC decision records to localStorage (falls back to in-memory).
 * Mirrors ScenarioStorage / DecisionGraphStorage.
 *
 * Its OWN key (design 39 §13, H4). Decision records must never enter
 * `fin-sim-scenarios` — that is the Step 5c bug this design keeps fixed. They were
 * session-only until harvest (§13) made an un-harvested run worth keeping across a
 * page reload.
 */
export class DecisionRecordStorage {
  static STORAGE_KEY = 'fin-sim-decisions';
  _storageInstance = null;

  _getStorageInstance() {
    if (this._storageInstance) return this._storageInstance;
    try {
      if (typeof localStorage !== 'undefined') {
        const key = '__decision_storage_test__';
        localStorage.setItem(key, '1');
        localStorage.removeItem(key);
        this._storageInstance = localStorage;
      } else {
        this._storageInstance = new InMemoryStorage();
      }
    } catch {
      this._storageInstance = new InMemoryStorage();
    }
    return this._storageInstance;
  }

  load() {
    try {
      const raw = this._getStorageInstance().getItem(DecisionRecordStorage.STORAGE_KEY);
      if (raw) return JSON.parse(raw);
    } catch (e) {
      console.warn('[DecisionRecordStorage] Failed to load from localStorage:', e);
    }
    return { records: [] };
  }

  save(data) {
    try {
      this._getStorageInstance().setItem(
        DecisionRecordStorage.STORAGE_KEY,
        JSON.stringify(data),
      );
    } catch (e) {
      console.warn('[DecisionRecordStorage] Failed to save to localStorage:', e);
    }
  }
}
