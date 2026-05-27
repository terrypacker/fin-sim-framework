/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { InMemoryStorage } from "../storage/in-memory-storage.js";
import {ScenarioSerializer} from "./scenario-serializer.js";
import {ServiceRegistry} from "../services/service-registry.js";

export class ScenarioStorage {
  static STORAGE_KEY = 'fin-sim-scenarios';
  _storage_instance = null;

  _getStorageInstance() {
    try {
      if (typeof localStorage !== 'undefined') {
        // sanity test
        const key = '__storage_test__';
        localStorage.setItem(key, '1');
        localStorage.removeItem(key);

        this._storage_instance = localStorage;
      } else {
        this._storage_instance = new InMemoryStorage();
      }
    } catch {
      this._storage_instance = new InMemoryStorage();
    }
    return this._storage_instance;
  }


  load() {
    try {
      const raw = this._getStorageInstance().getItem(ScenarioStorage.STORAGE_KEY);
      if (raw) return JSON.parse(raw);
    } catch (e) {
      console.warn('Failed to load scenarios from localStorage:', e);
    }
    return { scenarios: [] };
  }

  /**
   * We only recieve user scenarios to save here
   * { scenarios: [...], lastUsed: 'id of active scenario' }
   * @param data
   */
  save(data) {
    this._getStorageInstance().setItem(ScenarioStorage.STORAGE_KEY, JSON.stringify(data));
  }
}
