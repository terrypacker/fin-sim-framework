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

import { HandlerEntry } from '../handlers.js';

export class HandlerBuilder {
  static handler(fn = null) {
    return new HandlerBuilder(fn);
  }

  constructor(fn = null) {
    this._fn               = fn;
    this._name             = 'anonymous';
    this._handledEvents    = [];
    this._generatedActionTypes = [];  // string[] — declared types for graph edges
    this._generatedActionDefs  = [];  // ActionDefinition[] — runtime instantiation
  }

  fn(v)             { this._fn = v;                               return this; }
  name(v)           { this._name = v;                             return this; }
  forEvent(event)   { this._handledEvents.push(event);            return this; }

  /**
   * Declare a type string that this handler may emit (graph edge metadata).
   * Use when the handler has a custom fn and you want to document declared outputs.
   */
  generateActionType(type) {
    if (!this._generatedActionTypes.includes(type)) {
      this._generatedActionTypes.push(type);
    }
    return this;
  }

  /**
   * Add an ActionDefinition for runtime instantiation.
   * Also registers the definition's type in generatedActionTypes automatically.
   */
  generateActionDef(def) {
    this._generatedActionDefs.push(def);
    if (!this._generatedActionTypes.includes(def.type)) {
      this._generatedActionTypes.push(def.type);
    }
    return this;
  }

  build() {
    const entry = new HandlerEntry(this._fn, this._name);
    entry.handledEvents             = [...this._handledEvents];
    entry.generatedActionTypes      = [...this._generatedActionTypes];
    entry.generatedActionDefinitions = [...this._generatedActionDefs];
    return entry;
  }
}
