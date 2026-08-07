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
   * @param {boolean}     [opts.speculative=false]      - Simulate but do not recognise (design 88)
   */
  constructor(name = '', opts = {}) {
    super({ id: opts.id ?? null, kind: opts.kind ?? 'asset', layer: 'config', name });
    this.ownershipType    = opts.ownershipType    ?? 'sole';
    this.ownerId          = opts.ownerId          ?? null;
    this.drawdownPriority = opts.drawdownPriority ?? null;
    // Design 88 D1/D3: "simulate this, but do not count it as mine." SUPPRESSES THE
    // CARRYING VALUE, NEVER THE MECHANICS — the asset still appreciates, still sells
    // on its plannedSaleYear, still pays CGT, and its proceeds are recognised in full
    // from the instant they land in an account. Lives on the base because a
    // pre-construction property and an unauthenticated artwork are speculative in
    // exactly the same sense as a private stake. Absent ⇒ false ⇒ today's behaviour.
    this.speculative      = opts.speculative === true;
    assertSpeculativeConsistency(this);
  }
}

/**
 * Design 88 D4: `speculative: true` and a non-null `drawdownPriority` is a
 * contradiction — you have told the model this asset may never convert, so the
 * model must not quietly fund a grocery bill from it. Reject rather than silently
 * pick a winner.
 *
 * This does NOT conflict with a scheduled sale: an explicit `plannedSaleYear` is
 * the planner stating an assumption, whereas opportunistic liquidation by the
 * drawdown engine is the model making one up. Only the second is prevented.
 *
 * Enforced at construction AND on every service update (AssetService#mergeChanges),
 * because today's solvency-inertness of company equity is an accident of the current
 * data, not a rule.
 *
 * @param {object} asset
 * @throws {Error} when the pair is contradictory
 */
export function assertSpeculativeConsistency(asset) {
  if (asset?.speculative === true && asset?.drawdownPriority != null) {
    throw new Error(
      `Asset "${asset.name || asset.id || '?'}": speculative:true is incompatible with `
      + `drawdownPriority:${asset.drawdownPriority} — a speculative asset is not `
      + 'drawdown-eligible (design 88 D4). Clear one of the two.');
  }
}

/**
 * Design 88: the recognition decision point, in one place so no two metrics can
 * drift. Deliberately `=== true` rather than truthiness — a projection that DROPPED
 * the field yields `undefined`, and `!entry.speculative` would read that as "not
 * speculative" and silently recognise the asset, which looks exactly like the
 * status quo and so never looks broken (design 88 §7 trap 3).
 *
 * @param {object} entry - a runtime STATE entry (not the config record)
 * @returns {boolean}
 */
export function isSpeculative(entry) {
  if (entry?.speculative !== true) return false;
  // Accounts are out of scope in phase 1 (D3, §10 OQ2) — `Account` extends `Asset`,
  // so the field is INHERITED whether or not it means anything yet. Answering false
  // for anything balance-shaped keeps every consumer (both net-worth scopes, the
  // after-tax pair, and the cube) agreeing on which rows are recognised, so a flag
  // set where it has no effect cannot break the §6 invariants instead of simply
  // doing nothing. When OQ2 is answered this is the one line that changes.
  return typeof entry.balance !== 'number';
}
