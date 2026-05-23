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
 * ToolsetRegistry — maps toolset IDs to toolset objects for the ScenarioCompiler.
 *
 * Unlike ScenarioToolsetRegistry (which maps string names to classes with a
 * static setup() method), ToolsetRegistry maps uppercase IDs to plain toolset
 * objects with declarative state/schedules/handlers/reducers methods.
 */
export class ToolsetRegistry {
  constructor() {
    this._map = new Map();
  }

  register(toolset) {
    this._map.set(toolset.id, toolset);
  }

  get(id) {
    if (!this._map.has(id)) throw new Error(`ToolsetRegistry: '${id}' not registered`);
    return this._map.get(id);
  }

  has(id) {
    return this._map.has(id);
  }
}
