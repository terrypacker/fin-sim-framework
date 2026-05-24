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

  subscribe(type, handler) {
    if (!this.listeners.has(type)) {
      this.listeners.set(type, []);
    }
    this.listeners.get(type).push(handler);
  }

  publish(event) {
    // event = { date, type, payload }

    this.history.push(event);

    const handlers = this.listeners.get(event.type) || [];
    for (const h of handlers) {
      h(event);
    }

    // wildcard listeners
    const any = this.listeners.get('*') || [];
    for (const h of any) {
      h(event);
    }
  }

  getHistory() {
    return this.history;
  }
}
