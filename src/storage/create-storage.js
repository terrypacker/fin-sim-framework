/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { IndexedDbStorage }   from './indexed-db-storage.js';
import { LocalStorageAdapter } from './local-storage-adapter.js';
import { InMemoryStorage }    from './in-memory-storage.js';
import { ALL_STORAGE_KEYS }   from './storage-keys.js';

/**
 * The one StorageAdapter every persisted store shares.
 *
 * One adapter, not one per store: IndexedDbStorage owns a database connection, a
 * mirror and a write queue, and four of those would mean four connections and
 * four separate flushes of what is logically one save.
 */
let _appStorage = null;

/**
 * Pick the best backend available, without touching it yet.
 *
 * Deliberately synchronous, so the stores can be constructed at any time: the
 * IndexedDB backend is inert (empty mirror, no connection) until `hydrate()`.
 * Callers that need real data must await `hydrateAppStorage()` first.
 *
 * @returns {import('./storage-adapter.js').StorageAdapter}
 */
export function getAppStorage() {
  if (_appStorage) return _appStorage;

  if (IndexedDbStorage.isAvailable())      _appStorage = new IndexedDbStorage();
  else if (LocalStorageAdapter.isAvailable()) _appStorage = new LocalStorageAdapter();
  else                                     _appStorage = new InMemoryStorage();

  return _appStorage;
}

/**
 * Bring the app's storage online. Call once at boot, BEFORE anything constructs
 * ServiceRegistry — the registries load from storage in their constructors, so an
 * un-hydrated adapter reads as an empty profile.
 *
 * On the IndexedDB path this also carries existing localStorage data across the
 * first time it runs. The localStorage copy is deliberately left in place: it is
 * the rollback path if this backend misbehaves, and it costs nothing but quota
 * nothing else is competing for any more. `clearMigratedLegacyKeys()` reclaims it
 * once the user is confident.
 *
 * Falls back to localStorage if IndexedDB will not open (private modes, blocked
 * storage, a blocking connection in another tab), so boot cannot fail here.
 *
 * @returns {Promise<import('./storage-adapter.js').StorageAdapter>}
 */
export async function hydrateAppStorage() {
  const storage = getAppStorage();

  try {
    await storage.hydrate();
  } catch (e) {
    console.warn(`[storage] ${storage.backendName} failed to hydrate; falling back:`, e);
    _appStorage = LocalStorageAdapter.isAvailable()
      ? new LocalStorageAdapter()
      : new InMemoryStorage();
    await _appStorage.hydrate();
    return _appStorage;
  }

  if (storage instanceof IndexedDbStorage && LocalStorageAdapter.isAvailable()) {
    const adopted = storage.adoptFrom(new LocalStorageAdapter(), ALL_STORAGE_KEYS);
    if (adopted.length) {
      await storage.flush();
      console.info(`[storage] migrated from localStorage: ${adopted.join(', ')}`);
    }
  }

  return storage;
}

/**
 * Delete the legacy localStorage copies of the migrated keys.
 *
 * Opt-in, and destructive: it removes the pre-migration data, so only call it
 * once IndexedDB is known good. Refuses to run unless the current backend
 * actually holds the key, so it can never delete the only copy.
 *
 * @returns {string[]} the keys cleared
 */
export function clearMigratedLegacyKeys() {
  if (!LocalStorageAdapter.isAvailable()) return [];
  const storage = getAppStorage();
  if (storage instanceof LocalStorageAdapter) return [];

  const legacy  = new LocalStorageAdapter();
  const cleared = [];
  for (const key of ALL_STORAGE_KEYS) {
    if (legacy.getItem(key) == null) continue;
    if (storage.getItem(key) == null) {
      console.warn(`[storage] refusing to clear '${key}': the current backend has no copy`);
      continue;
    }
    legacy.removeItem(key);
    cleared.push(key);
  }
  return cleared;
}

/** Reset the shared adapter. Tests only. */
export function _resetAppStorage(adapter = null) {
  _appStorage = adapter;
}
