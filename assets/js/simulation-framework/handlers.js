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
  constructor(fn, name = 'anonymous') {
    this.fn   = fn;
    this.name = name;
  }

  call(ctx) {
    return this.fn(ctx);
  }
}

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
}
