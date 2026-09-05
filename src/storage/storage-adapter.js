/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * StorageAdapter — the key/value contract every persistence backend implements.
 *
 * ## Why the reads are synchronous
 *
 * The four persistence stores (ScenarioStorage, DecisionGraphStorage,
 * DecisionGraphResultStorage, DecisionRecordStorage) all `load()` inside their
 * registry's *constructor*, and ServiceRegistry.getInstance() is synchronous with
 * hundreds of call sites. Making reads async would push `await` through all of
 * them for no benefit, because every registry already holds its whole document in
 * memory and rewrites it wholesale.
 *
 * So the contract is: **reads are synchronous, writes may be asynchronous.** An
 * async backend (IndexedDB) satisfies it by keeping a synchronous in-memory
 * mirror, filled once by `hydrate()` before the app boots, and writing behind.
 * The mirror — not the database — is what `getItem` answers from.
 *
 * The consequence, and the one real behavioural difference from localStorage: a
 * write is not durable the instant `setItem` returns. Backends that write behind
 * MUST flush on page hide, and `flush()` is available for anywhere that needs a
 * hard guarantee.
 *
 * ## Values
 *
 * Values are opaque to the adapter. Today every caller passes a JSON string, as
 * they did with localStorage; nothing here requires that, so a caller can later
 * hand IndexedDB a live object and skip the stringify round-trip without the
 * interface changing.
 *
 * @interface
 */
export class StorageAdapter {
  /**
   * Load persisted state into memory. Idempotent; safe to await more than once.
   * Synchronous backends resolve immediately.
   * @returns {Promise<void>}
   */
  async hydrate() {}

  /**
   * @param {string} key
   * @returns {string|null|undefined} the stored value, or null/undefined if absent
   */
  getItem(key) { throw new Error('getItem() not implemented'); }

  /**
   * @param {string} key
   * @param {string} value
   */
  setItem(key, value) { throw new Error('setItem() not implemented'); }

  /** @param {string} key */
  removeItem(key) { throw new Error('removeItem() not implemented'); }

  /** @returns {string[]} every key currently held */
  keys() { throw new Error('keys() not implemented'); }

  /**
   * Resolve once every pending write has reached durable storage.
   * A no-op for backends that write through.
   * @returns {Promise<void>}
   */
  async flush() {}

  /** Human-readable backend name, for diagnostics. @returns {string} */
  get backendName() { return 'unknown'; }
}
