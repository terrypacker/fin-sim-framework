/*
 * Copyright (c) 2026 Terry Packer.
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

import { SimGraphNode } from '../../graph/sim-graph-node.js';

/**
 * Asset — abstract base class for all financial holdings in the simulation graph.
 * Subclasses: Account (ledger-based), RealProperty (market-value).
 * Carries ownership metadata shared by all asset types.
 * No methods; safe for structuredClone snapshots.
 */
export class Asset extends SimGraphNode {
  /**
   * @param {string} name  - Asset identifier
   * @param {object} [opts]
   * @param {string|null} [opts.id=null]               - Assigned by service; null until registered
   * @param {string}      [opts.kind='asset']           - SimGraphNode kind discriminator
   * @param {string}      [opts.ownershipType='sole']   - 'sole' | 'joint'
   * @param {string|null} [opts.ownerId=null]           - Person id of primary owner
   * @param {number|null} [opts.drawdownPriority=null]  - Liquidation order (1 = first)
   */
  constructor(name = '', opts = {}) {
    super({ id: opts.id ?? null, kind: opts.kind ?? 'asset', layer: 'config', name });
    this.ownershipType    = opts.ownershipType    ?? 'sole';
    this.ownerId          = opts.ownerId          ?? null;
    this.drawdownPriority = opts.drawdownPriority ?? null;
  }
}
