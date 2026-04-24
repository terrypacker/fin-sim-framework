/*
 * Copyright (c) 2026 Terry Packer.
 *
 * This file is part of Terry Packer's Work.
 * See www.terrypacker.com for further info.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * keyFn is critical
 * Must be:
 *   unique
 *   stable over lifetime
 *   cheap to compute
 *
 * No duplicates allowed
 *   If you need duplicates, you must:
 *   encode uniqueness into the key (e.g., id + sequence)
 *
 * update() = decrease-key / increase-key
 *   This is huge for schedulers, simulations, Dijkstra, etc.
 *
 * Memory tradeoff
 *   You pay O(n) extra for indexMap, but gain:
 *   fast deletes
 *   fast updates
 */
export class IndexedMinHeap {
  constructor(compareFn, keyFn, typeFn) {
    this.data = [];
    this.compare = compareFn;
    this.keyFn = keyFn; // MUST return a unique, stable key per item
    this.typeFn = typeFn;
    this.indexMap = new Map(); // key -> index
    this.typeMap = new Map();    // type -> Set<key>
  }

  size() {
    return this.data.length;
  }

  peek() {
    return this.data[0] || null;
  }

  has(key) {
    return this.indexMap.has(key);
  }

  push(item) {
    const key = this.keyFn(item);
    const type = this.typeFn(item);

    if (this.indexMap.has(key)) {
      throw new Error(`Duplicate key: ${key}`);
    }

    this.data.push(item);
    const index = this.data.length - 1;

    this.indexMap.set(key, index);

    if (!this.typeMap.has(type)) {
      this.typeMap.set(type, new Set());
    }
    this.typeMap.get(type).add(key);

    this.bubbleUp(index);
  }

  pop() {
    if (this.data.length === 0) return null;

    const top = this.data[0];
    this.removeByKey(this.keyFn(top));
    return top;
  }

  removeByKey(key) {
    const index = this.indexMap.get(key);
    if (index === undefined) return false;

    const item = this.data[index];
    const type = this.typeFn(item);

    const lastIndex = this.data.length - 1;

    this.swap(index, lastIndex);

    this.data.pop();
    this.indexMap.delete(key);

    // remove from type map
    const set = this.typeMap.get(type);
    set.delete(key);
    if (set.size === 0) this.typeMap.delete(type);

    if (index === lastIndex) return true;

    this.bubbleUp(index);
    this.bubbleDown(index);

    return true;
  }

  update(item) {
    const key = this.keyFn(item);
    const index = this.indexMap.get(key);
    if (index === undefined) return false;

    this.data[index] = item;

    // Rebalance both directions
    this.bubbleUp(index);
    this.bubbleDown(index);

    return true;
  }

  swap(i, j) {
    const a = this.data[i];
    const b = this.data[j];

    this.data[i] = b;
    this.data[j] = a;

    this.indexMap.set(this.keyFn(a), j);
    this.indexMap.set(this.keyFn(b), i);
  }

  bubbleUp(index) {
    while (index > 0) {
      const parentIndex = Math.floor((index - 1) / 2);

      if (this.compare(this.data[index], this.data[parentIndex]) >= 0) break;

      this.swap(index, parentIndex);
      index = parentIndex;
    }
  }

  bubbleDown(index) {
    const length = this.data.length;

    while (true) {
      let left = index * 2 + 1;
      let right = index * 2 + 2;
      let smallest = index;

      if (
          left < length &&
          this.compare(this.data[left], this.data[smallest]) < 0
      ) {
        smallest = left;
      }

      if (
          right < length &&
          this.compare(this.data[right], this.data[smallest]) < 0
      ) {
        smallest = right;
      }

      if (smallest === index) break;

      this.swap(index, smallest);
      index = smallest;
    }
  }

  /**
   * Replace the heap contents and rebuild indexMap + typeMap from scratch.
   * Use this whenever restoring data from a snapshot or branch, instead of
   * assigning to .data directly (which leaves the maps stale).
   */
  restoreData(items) {
    this.data = items.slice();
    this.indexMap = new Map();
    this.typeMap  = new Map();

    for (let i = 0; i < this.data.length; i++) {
      const item = this.data[i];
      const key  = this.keyFn(item);
      const type = this.typeFn(item);

      this.indexMap.set(key, i);

      if (!this.typeMap.has(type)) this.typeMap.set(type, new Set());
      this.typeMap.get(type).add(key);
    }
  }

  removeAllByType(type) {
    const set = this.typeMap.get(type);
    if (!set) return 0;

    // Copy because we'll mutate during removal
    const keys = Array.from(set);

    for (const key of keys) {
      this.removeByKey(key);
    }

    return keys.length;
  }
}
