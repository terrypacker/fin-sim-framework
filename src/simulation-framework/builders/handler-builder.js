/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
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
    this._generatedActions = [];
  }

  fn(v)             { this._fn = v;                        return this; }
  name(v)           { this._name = v;                      return this; }
  forEvent(event)   { this._handledEvents.push(event);     return this; }
  generateAction(a) { this._generatedActions.push(a);      return this; }

  build() {
    const entry = new HandlerEntry(this._fn, this._name);
    entry.handledEvents    = [...this._handledEvents];
    entry.generatedActions = [...this._generatedActions];
    return entry;
  }
}
