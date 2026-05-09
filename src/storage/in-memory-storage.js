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
 * For use when localStorage isn't available (i.e. not in browser)
 * for extension later.
 */
export class InMemoryStorage {
  constructor() {
    this._storageItems = new Map();
  }

  getItem(key) {
    return this._storageItems.get(key);
  }

  setItem(key, value) {
    this._storageItems.set(key, value);
  }

}
