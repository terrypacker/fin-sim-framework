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
 * StorageAdapter backed by window.localStorage.
 *
 * Write-through and durable on return, but capped at ~5 MB per origin — and a
 * single production scenario serializes to ~350 KB, so this backend runs out of
 * room after a handful of saves. It remains the fallback for browsers where
 * IndexedDB cannot be opened (private modes, blocked storage), and the source
 * that IndexedDbStorage migrates from.
 *
 * `isAvailable()` probes with a real write: merely finding `localStorage` defined
 * is not enough, since Safari private mode throws on setItem.
 */
export class LocalStorageAdapter extends StorageAdapter {
  static isAvailable() {
    try {
      if (typeof localStorage === 'undefined') return false;
      const probe = '__storage_probe__';
      localStorage.setItem(probe, '1');
      localStorage.removeItem(probe);
      return true;
    } catch {
      return false;
    }
  }

  getItem(key) {
    try {
      return localStorage.getItem(key);
    } catch (e) {
      console.warn('[LocalStorageAdapter] getItem failed:', e);
      return null;
    }
  }

  setItem(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch (e) {
      // Quota exceeded, or private mode. The caller's in-memory copy is still
      // correct for this session; only durability is lost.
      console.warn(`[LocalStorageAdapter] setItem('${key}') failed:`, e);
    }
  }

  removeItem(key) {
    try {
      localStorage.removeItem(key);
    } catch (e) {
      console.warn('[LocalStorageAdapter] removeItem failed:', e);
    }
  }

  keys() {
    try {
      return Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i))
        .filter(k => k != null);
    } catch {
      return [];
    }
  }

  get backendName() { return 'localStorage'; }
}
