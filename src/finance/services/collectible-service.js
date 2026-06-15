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

import { AssetService } from './asset-service.js';

/**
 * CollectibleService — CRUD and domain operations for Collectible instances.
 *
 * Extends AssetService (BaseService → AssetService → CollectibleService).
 * Inherits takeLoan / repayLoan from AssetService (useful for art-secured lending).
 * Overrides getPersonShare and recordResidencyChange for collectible semantics.
 */
export class CollectibleService extends AssetService {
  /**
   * @param {import('../../graph/graph.js').Graph} [graph]
   * @param query - graph query api
   * @param {import('../../simulation-framework/event-bus.js').EventBus} [bus]
   */
  constructor(graph, query, bus) {
    super(graph, query, bus, 'collectible', 2, false);
  }

  // ─── Create / Update / Delete ─────────────────────────────────────────────

  /**
   * Register a pre-built collectible, assign a service-generated id, and publish CREATE.
   * @param {import('../assets/collectible.js').Collectible} collectible
   * @returns {import('../assets/collectible.js').Collectible}
   */
  createCollectible(collectible) {
    collectible.id = this._generateId(this._idPrefix);
    if (!collectible.stateKey) {
      collectible.stateKey = collectible.id;
    }
    this._register(collectible);
    this._publish('CREATE', collectible);
    this._wireNodeEdges(collectible);
    return collectible;
  }

  /**
   * Apply changes to an existing collectible and publish UPDATE.
   * @param {string|import('../assets/collectible.js').Collectible} idOrCollectible
   * @param {object} changes
   * @returns {import('../assets/collectible.js').Collectible}
   */
  updateCollectible(idOrCollectible, changes = {}) {
    const collectible = this._resolve(idOrCollectible);
    const original    = { ...collectible };
    this.mergeChanges(collectible, changes);
    this._publish('UPDATE', collectible, original);
    this._wireNodeEdges(collectible);
    return collectible;
  }

  /**
   * Remove a collectible from the service and publish DELETE.
   * @param {string|import('../assets/collectible.js').Collectible} idOrCollectible
   * @returns {import('../assets/collectible.js').Collectible}
   */
  deleteCollectible(idOrCollectible) {
    const collectible = this._resolve(idOrCollectible);
    this._unregister(collectible.id);
    this._publish('DELETE', collectible);
    return collectible;
  }

  // ─── Domain operations ────────────────────────────────────────────────────

  /**
   * Returns the collectible value attributable to one person.
   * When personId is provided and an owners array exists, uses percentage-based split.
   * Falls back to sole/joint split when no owners array or no matching owner.
   * @param {import('../assets/collectible.js').Collectible} collectible
   * @param {string} [personId]
   * @returns {number}
   */
  getPersonShare(collectible, personId) {
    if (personId && collectible.owners?.length) {
      const owner = collectible.owners.find(o => o.personId === personId);
      return owner ? collectible.value * (owner.ownershipPct / 100) : 0;
    }
    return collectible.ownershipType === 'joint' ? collectible.value / 2 : collectible.value;
  }

  /**
   * Snapshots the current value on first residency change (one-time capture).
   * No-op if already set.
   * @param {import('../assets/collectible.js').Collectible} collectible
   */
  recordResidencyChange(collectible) {
    if (collectible.balanceAtResidencyChange === null) {
      collectible.balanceAtResidencyChange = collectible.value;
    }
  }

  /**
   * Compounds the annual appreciation rate over the given period.
   * @param {import('../assets/collectible.js').Collectible} collectible
   * @param {number} [years=1] - Years to compound (fractional values supported)
   */
  applyAppreciation(collectible, years = 1) {
    collectible.value = collectible.value * Math.pow(1 + collectible.appreciationRate, years);
  }

  /**
   * Sets the current market value directly (e.g. from a formal appraisal or auction estimate).
   * @param {import('../assets/collectible.js').Collectible} collectible
   * @param {number} newValue
   */
  appraise(collectible, newValue) {
    collectible.value = newValue;
  }
}
