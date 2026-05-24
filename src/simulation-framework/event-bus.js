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
  constructor() {
    this.listeners = new Map();
    this.history = []; // optional (for replay/debug)
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

    if (!this.listeners.has(type)) {
      this.listeners.set(type, []);
    }
    this.listeners.get(type).push({ predicate, fn });
  }

  publish(event) {
    this.history.push(event);

    const entries = this.listeners.get(event.type) || [];
    for (const { predicate, fn } of entries) {
      if (predicate === null || predicate(event)) fn(event);
    }

    const wildcards = this.listeners.get('*') || [];
    for (const { predicate, fn } of wildcards) {
      if (predicate === null || predicate(event)) fn(event);
    }
  }

  getHistory() {
    return this.history;
  }
}
