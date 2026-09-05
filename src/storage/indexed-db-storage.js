/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { StorageAdapter } from './storage-adapter.js';

const DB_NAME    = 'fin-sim';
const DB_VERSION = 1;
const STORE_NAME = 'kv';

/** Wrap an IDBRequest as a promise. */
function promisifyRequest(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror   = () => reject(request.error);
  });
}

/**
 * StorageAdapter backed by IndexedDB, with a synchronous in-memory mirror.
 *
 * IndexedDB is async and the StorageAdapter contract requires synchronous reads
 * (see storage-adapter.js for why), so this backend keeps every key/value pair in
 * a Map:
 *
 *   - `hydrate()` fills the Map from IndexedDB once, before the app boots.
 *   - `getItem` answers from the Map. Never touches the database.
 *   - `setItem` updates the Map synchronously and marks the key dirty; the
 *     database catches up on a debounced flush.
 *
 * The Map is therefore authoritative within a session and the database is a
 * durable shadow of it. That inverts localStorage's guarantee — a write is no
 * longer durable the moment `setItem` returns — so writes are also flushed on
 * `pagehide`/`visibilitychange`, which is the last point a browser reliably gives
 * us before the tab goes away.
 *
 * The payoff over localStorage is quota: a share of free disk (typically
 * hundreds of MB) rather than ~5 MB, against ~350 KB per saved scenario.
 */
export class IndexedDbStorage extends StorageAdapter {
  /**
   * @param {object} [opts]
   * @param {number} [opts.flushDelayMs=150] — write-behind debounce window. Long
   *        enough to coalesce a burst of edits into one transaction, short enough
   *        that an idle tab is durable almost immediately.
   * @param {IDBFactory} [opts.indexedDB] — injectable for tests.
   */
  constructor({ flushDelayMs = 150, indexedDB: idbFactory = null } = {}) {
    super();
    this._mirror       = new Map();
    this._dirty        = new Set();
    this._db           = null;
    this._hydrated     = false;
    this._hydrating    = null;
    this._flushTimer   = null;
    this._flushPending = null;
    this._flushDelayMs = flushDelayMs;
    this._idb          = idbFactory ?? (typeof indexedDB !== 'undefined' ? indexedDB : null);
    this._onPageHide   = null;
  }

  static isAvailable() {
    return typeof indexedDB !== 'undefined' && indexedDB !== null;
  }

  get backendName() { return 'indexedDB'; }

  /** Keys currently held in the mirror. */
  keys() { return [...this._mirror.keys()]; }

  getItem(key) {
    return this._mirror.has(key) ? this._mirror.get(key) : null;
  }

  setItem(key, value) {
    this._mirror.set(key, value);
    this._dirty.add(key);
    this._scheduleFlush();
  }

  removeItem(key) {
    this._mirror.delete(key);
    // Still dirty: the flush must issue a delete against the database. Absence
    // from the mirror is what tells it to delete rather than put.
    this._dirty.add(key);
    this._scheduleFlush();
  }

  /**
   * Open the database and fill the mirror. Idempotent — concurrent callers share
   * one in-flight promise, and a second call after success is a no-op.
   */
  async hydrate() {
    if (this._hydrated) return;
    if (this._hydrating) return this._hydrating;
    this._hydrating = this._doHydrate().finally(() => { this._hydrating = null; });
    return this._hydrating;
  }

  async _doHydrate() {
    if (!this._idb) throw new Error('IndexedDB is not available');

    this._db = await this._openDb();

    const tx    = this._db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const [keys, values] = await Promise.all([
      promisifyRequest(store.getAllKeys()),
      promisifyRequest(store.getAll()),
    ]);
    keys.forEach((k, i) => this._mirror.set(k, values[i]));

    this._hydrated = true;
    this._installUnloadFlush();
  }

  _openDb() {
    return new Promise((resolve, reject) => {
      const req = this._idb.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE_NAME)) {
          req.result.createObjectStore(STORE_NAME);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror   = () => reject(req.error);
      req.onblocked = () => reject(new Error('IndexedDB open blocked by another connection'));
    });
  }

  /**
   * A write-behind window is invisible until the tab closes inside it. `pagehide`
   * is the last event a browser reliably fires before unload; `visibilitychange`
   * to hidden covers mobile task-switching, where `pagehide` may never come.
   */
  _installUnloadFlush() {
    if (this._onPageHide || typeof window === 'undefined') return;
    this._onPageHide = () => { void this.flush(); };
    window.addEventListener('pagehide', this._onPageHide);
    window.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') this._onPageHide();
    });
  }

  _scheduleFlush() {
    if (!this._hydrated || this._flushTimer != null) return;
    this._flushTimer = setTimeout(() => {
      this._flushTimer = null;
      void this.flush();
    }, this._flushDelayMs);
  }

  /**
   * Write every dirty key in one transaction. Resolves when it commits.
   *
   * A flush already in flight is awaited rather than duplicated, and keys dirtied
   * while it runs are picked up by the next one.
   */
  async flush() {
    if (this._flushTimer != null) {
      clearTimeout(this._flushTimer);
      this._flushTimer = null;
    }
    if (this._flushPending) await this._flushPending;
    if (!this._hydrated || this._dirty.size === 0) return;

    // Claim the current dirty set; anything dirtied during the write stays for
    // the next flush rather than being silently dropped.
    const batch = [...this._dirty];
    this._dirty.clear();

    this._flushPending = this._writeBatch(batch).catch(e => {
      console.warn('[IndexedDbStorage] flush failed; keys stay dirty for retry:', e);
      // Re-dirty so the data is not lost from the next flush's point of view.
      batch.forEach(k => this._dirty.add(k));
    }).finally(() => { this._flushPending = null; });

    return this._flushPending;
  }

  _writeBatch(batch) {
    return new Promise((resolve, reject) => {
      const tx    = this._db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      for (const key of batch) {
        if (this._mirror.has(key)) store.put(this._mirror.get(key), key);
        else store.delete(key);
      }
      tx.oncomplete = () => resolve();
      tx.onerror    = () => reject(tx.error);
      tx.onabort    = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
    });
  }

  /**
   * Seed the mirror from another adapter for keys this database has never seen,
   * and queue them for write. Used once, to carry existing localStorage data
   * across; keys already in IndexedDB always win, so re-running is harmless.
   *
   * @param {StorageAdapter} source
   * @param {string[]} keys — the keys to consider
   * @returns {string[]} the keys actually adopted
   */
  adoptFrom(source, keys) {
    const adopted = [];
    for (const key of keys) {
      if (this._mirror.has(key)) continue;
      const value = source.getItem(key);
      if (value == null) continue;
      this.setItem(key, value);
      adopted.push(key);
    }
    return adopted;
  }
}
