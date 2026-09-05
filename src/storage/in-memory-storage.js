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

/**
 * StorageAdapter backed by a plain Map — nothing survives the process.
 *
 * Used when no browser storage is available (Node test runs) and as the
 * last-resort fallback when a real backend fails to open.
 */
export class InMemoryStorage extends StorageAdapter {
  constructor() {
    super();
    this._storageItems = new Map();
  }

  getItem(key) {
    return this._storageItems.get(key);
  }

  setItem(key, value) {
    this._storageItems.set(key, value);
  }

  removeItem(key) {
    this._storageItems.delete(key);
  }

  keys() {
    return [...this._storageItems.keys()];
  }

  get backendName() { return 'memory'; }
}
