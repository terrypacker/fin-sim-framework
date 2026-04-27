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
 * A single registered handler for an event type.
 */
export class HandlerEntry {
  static description = 'Returns generated actions.';

  constructor(fn, name = 'anonymous') {
    this.id   = null;
    this.fn   = fn ?? this.defaultFunction;
    this.name = name;
    this.handledEvents = [];
    this.generatedActions = [];
  }

  call(ctx) {
    return this.fn(ctx);
  }

  defaultFunction ({ data, date, state }) {
    const actions = [...this.generatedActions];
    return actions;
  }

  get kind() { return 'handler'; }

  /** Always matches constructor.name — can never drift from the actual class. */
  get handlerClass() { return this.constructor.name; }

  static getDescription() {
    return this.description;
  }

  getDescription() {
    return this.constructor.getDescription();
  }

}

// ─── Class registry ────────────────────────────────────────────────────────────

/**
 * Maps handlerClass string → class.
 * Used by HandlerService.replaceHandler to instantiate the correct subclass
 * when the user changes the type of an existing handler in the UI.
 */
export const HANDLER_CLASSES = {
  HandlerEntry,
};

/**
 * Registry that maps event types to ordered lists of HandlerEntry instances.
 * Mirrors the ReducerPipeline API style.
 */
export class HandlerRegistry {
  constructor() {
    this.map = new Map(); // eventType -> [HandlerEntry]
  }

  register(type, fnOrEntry, name = 'anonymous') {
    if (!this.map.has(type)) this.map.set(type, []);
    const entry = fnOrEntry instanceof HandlerEntry
      ? fnOrEntry
      : new HandlerEntry(fnOrEntry, name);
    this.map.get(type).push(entry);
  }

  get(type) {
    return this.map.get(type) || [];
  }

  has(type) {
    return this.map.has(type);
  }

  /**
   * Remove a HandlerEntry from every event-type list it appears in.
   * Used when re-syncing a handler's handledEvents after a UI edit.
   */
  unregisterFromAll(handler) {
    for (const [type, entries] of this.map) {
      const idx = entries.indexOf(handler);
      if (idx !== -1) {
        entries.splice(idx, 1);
        if (entries.length === 0) this.map.delete(type);
      }
    }
  }
}
