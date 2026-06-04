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
 * Persists the last DecisionGraphResult per DG id to localStorage.
 *
 * Only used when the analysis has persistLeaves: true.
 * Falls back to in-memory when localStorage is unavailable.
 */
export class DecisionGraphResultStorage {
  static STORAGE_KEY = 'fin-sim-dg-results';

  _getStorage() {
    if (this._storage) return this._storage;
    try {
      if (typeof localStorage !== 'undefined') {
        const k = '__dgr_test__';
        localStorage.setItem(k, '1');
        localStorage.removeItem(k);
        this._storage = localStorage;
      } else {
        this._storage = new InMemoryStorage();
      }
    } catch {
      this._storage = new InMemoryStorage();
    }
    return this._storage;
  }

  _loadAll() {
    try {
      const raw = this._getStorage().getItem(DecisionGraphResultStorage.STORAGE_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch {
      return {};
    }
  }

  _saveAll(all) {
    try {
      this._getStorage().setItem(DecisionGraphResultStorage.STORAGE_KEY, JSON.stringify(all));
    } catch (e) {
      console.warn('[DecisionGraphResultStorage] Failed to save:', e);
    }
  }

  /** Returns the persisted result for dgId, or null. */
  loadResult(dgId) {
    return this._loadAll()[dgId] ?? null;
  }

  /** Persist result for dgId. Overwrites any previous value. */
  saveResult(dgId, result) {
    const all = this._loadAll();
    all[dgId] = result;
    this._saveAll(all);
  }

  /** Remove persisted result for dgId. */
  clearResult(dgId) {
    const all = this._loadAll();
    delete all[dgId];
    this._saveAll(all);
  }
}
