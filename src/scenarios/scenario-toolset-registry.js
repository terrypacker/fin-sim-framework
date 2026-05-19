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
 * ScenarioToolsetRegistry — singleton that maps toolset names to toolset classes.
 *
 * A toolset is a class with a static setup(config, services) method that wires
 * events/handlers/reducers for a custom JSON scenario after persons and accounts
 * have already been loaded via ScenarioSerializer.deserializePersonsAccounts().
 *
 * Usage:
 *   ScenarioToolsetRegistry.register('us-retirement', UsRetirementToolset);
 *   const toolset = ScenarioToolsetRegistry.get('us-retirement');
 *   toolset.setup(config, services);
 */
export class ScenarioToolsetRegistry {
  static _registry = new Map();

  static register(name, toolset) {
    this._registry.set(name, toolset);
  }

  static get(name) {
    const toolset = this._registry.get(name);
    if (!toolset) throw new Error(`ScenarioToolsetRegistry: toolset '${name}' not registered.`);
    return toolset;
  }

  static has(name) {
    return this._registry.has(name);
  }
}
