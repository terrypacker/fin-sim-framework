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
 * Persists the last DecisionGraphResult per DG id through a StorageAdapter.
 *
 * Only used when the analysis has persistLeaves: true.
 */
export class DecisionGraphResultStorage {
  static STORAGE_KEY = STORAGE_KEYS.DG_RESULTS;

  /**
   * @param {import('../../storage/storage-adapter.js').StorageAdapter} [storage]
   *        defaults to the shared app storage; pass one explicitly to isolate.
   */
  constructor(storage = getAppStorage()) {
    this._storage = storage;
  }

  _loadAll() {
    try {
      const raw = this._storage.getItem(DecisionGraphResultStorage.STORAGE_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch {
      return {};
    }
  }

  _saveAll(all) {
    try {
      this._storage.setItem(DecisionGraphResultStorage.STORAGE_KEY, JSON.stringify(all));
    } catch (e) {
      console.warn('[DecisionGraphResultStorage] Failed to save:', e);
    }
  }

  /** Returns the persisted result for dgId, or null. */
  loadResult(dgId) {
    return this._loadAll()[dgId] ?? null;
  }

  /**
   * Persist result for dgId. Overwrites any previous value.
   *
   * Each leaf's `entry` is a ~350 KB serialized copy of the base scenario, so a
   * 50-leaf result would persist ~17 MB of near-identical config. It is dropped
   * here: `makeLeafEntry` is pure, and `baseScenarioId` + the leaf's own
   * `params` — both still stored — are everything needed to rebuild it. Readers
   * go through `resolveLeafEntry(leaf, baseEntry)`, which rebuilds on demand.
   */
  saveResult(dgId, result) {
    const all = this._loadAll();
    all[dgId] = DecisionGraphResultStorage.stripLeafEntries(result);
    this._saveAll(all);
  }

  /**
   * A copy of `result` with `entry` removed from every leaf.
   *
   * Leaves that never carried an `entry` are passed through untouched — the key
   * is omitted, not set to undefined, so a stripped result of an entry-less
   * result deep-equals the original.
   */
  static stripLeafEntries(result) {
    if (!result || !Array.isArray(result.leaves)) return result;
    return {
      ...result,
      leaves: result.leaves.map(leaf => {
        if (!leaf || !('entry' in leaf)) return leaf;
        const { entry, ...rest } = leaf;
        return rest;
      }),
    };
  }

  /** Remove persisted result for dgId. */
  clearResult(dgId) {
    const all = this._loadAll();
    delete all[dgId];
    this._saveAll(all);
  }
}
