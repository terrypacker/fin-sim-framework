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

export class EventBus {
  constructor({ keepHistory = false } = {}) {
    this.listeners = new Map();
    this._keepHistory = keepHistory;
    this.history = []; // populated only when keepHistory is true
  }

  /**
   * Subscribe to messages of a given type, with optional filtering.
   *
   * Overloads:
   *   subscribe(type, handler)
   *   subscribe(type, filter, handler)
   *
   * Filter fields (all optional, combined with AND):
   *   kind      — matches msg.kind exactly
   *   subtype   — matches msg.subtype exactly
   *   instanceOf — matches msg.item instanceof X
   */
  subscribe(type, filterOrHandler, handler) {
    let predicate, fn;

    if (typeof filterOrHandler === 'function') {
      predicate = null;
      fn = filterOrHandler;
    } else {
      const { kind, subtype, instanceOf: Cls } = filterOrHandler;
      predicate = (msg) => {
        if (kind     !== undefined && msg.kind    !== kind)              return false;
        if (subtype  !== undefined && msg.subtype !== subtype)           return false;
        if (Cls      !== undefined && !(msg.item instanceof Cls))        return false;
        return true;
      };
      fn = handler;
    }

    const entry = { predicate, fn };
    if (!this.listeners.has(type)) {
      this.listeners.set(type, []);
    }
    this.listeners.get(type).push(entry);
    return () => {
      const arr = this.listeners.get(type);
      if (arr) {
        const idx = arr.indexOf(entry);
        if (idx !== -1) arr.splice(idx, 1);
      }
    };
  }

  publish(event) {
    if (this._keepHistory) this.history.push(event);

    // Snapshot before dispatch so subscribers added during delivery don't fire in this pass
    const entries = (this.listeners.get(event.type) || []).slice();
    for (const { predicate, fn } of entries) {
      if (predicate === null || predicate(event)) fn(event);
    }

    const wildcards = (this.listeners.get('*') || []).slice();
    for (const { predicate, fn } of wildcards) {
      if (predicate === null || predicate(event)) fn(event);
    }
  }

  getHistory() {
    return this.history;
  }
}
