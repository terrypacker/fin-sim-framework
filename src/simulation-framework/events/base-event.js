/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import {SimGraphNode} from "../../graph/sim-graph-node.js";

/**
 * Base class for all simulation event configurations.
 *
 * @property {string}  id      - Unique identifier
 * @property {string}  name    - Human-readable display name
 * @property {string}  type    - Simulation event type string (e.g. 'MONTHLY_SALARY')
 * @property {boolean} enabled - Whether this event is active
 * @property {string}  color   - CSS color used for visualization (e.g. '#888888')
 */
export class BaseEvent extends SimGraphNode {
  constructor({ id = null, name, type, enabled = true, color = '#888888', data = {}, meta = {} } = {}) {
    super({id: id, kind: 'event', layer: 'config', name})
    this.type    = type;
    this.enabled = enabled;
    this.color   = color;
    this.data    = data;
    this.meta    = meta;
  }

  /** Always matches constructor.name — can never drift from the actual class. */
  get eventType() { return this.constructor.name; }
}
