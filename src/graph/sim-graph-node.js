/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

export class SimGraphNode {
  constructor({
    id, // Assigned by ActionService (config) or instantiate() (runtime UUID)
    kind,           // 'event' | 'handler' | 'action' | 'reducer'

    // Layer
    layer,          // 'config' | 'execution' | 'scenario'

    // Structural identity
    name,

    // Link to config (for runtime nodes)
    definitionId = null,

    // Runtime fields
    timestamp = null,

    // Free-form buckets
    data = {},
    meta = {}
  }) {
    this.id = id;
    this.kind = kind;
    this.layer = layer;
    this.name = name;

    this.definitionId = definitionId;

    this.timestamp = timestamp;

    this.data = data;
    this.meta = meta;
  }
}
