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
 * Persists DecisionGraph configs to localStorage (falls back to in-memory).
 * Mirrors ScenarioStorage.
 */
export class DecisionGraphStorage {
  static STORAGE_KEY = 'fin-sim-decision-graphs';
  _storageInstance = null;

  _getStorageInstance() {
    if (this._storageInstance) return this._storageInstance;
    try {
      if (typeof localStorage !== 'undefined') {
        const key = '__dg_storage_test__';
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
      const raw = this._getStorageInstance().getItem(DecisionGraphStorage.STORAGE_KEY);
      if (raw) return JSON.parse(raw);
    } catch (e) {
      console.warn('[DecisionGraphStorage] Failed to load from localStorage:', e);
    }
    return { graphs: [] };
  }

  save(data) {
    try {
      this._getStorageInstance().setItem(
        DecisionGraphStorage.STORAGE_KEY,
        JSON.stringify(data),
      );
    } catch (e) {
      console.warn('[DecisionGraphStorage] Failed to save to localStorage:', e);
    }
  }
}
