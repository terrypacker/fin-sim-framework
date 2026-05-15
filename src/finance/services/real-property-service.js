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
 * RealPropertyService — CRUD and domain operations for RealProperty instances.
 *
 * Extends AssetService (BaseService → AssetService → RealPropertyService).
 * Inherits takeLoan / repayLoan from AssetService.
 * Overrides getPersonShare and recordResidencyChange for property semantics.
 */
export class RealPropertyService extends AssetService {
  /**
   * @param {import('../../graph/graph.js').Graph} [graph]
   * @param query - graph query api
   * @param {import('../../simulation-framework/event-bus.js').EventBus} [bus]
   */
  constructor(graph, query, bus) {
    super(graph, query, bus, 'real-property', 2, false);
  }

  // ─── Create / Update / Delete ─────────────────────────────────────────────

  /**
   * Register a pre-built property, assign a service-generated id, and publish CREATE.
   * @param {import('../assets/real-property.js').RealProperty} property
   * @returns {import('../assets/real-property.js').RealProperty}
   */
  createProperty(property) {
    property.id = this._generateId(this._idPrefix);
    this._register(property);
    this._publish('CREATE', property);
    this._wireNodeEdges(property);
    return property;
  }

  /**
   * Apply changes to an existing property and publish UPDATE.
   * @param {string|import('../assets/real-property.js').RealProperty} idOrProperty
   * @param {object} changes
   * @returns {import('../assets/real-property.js').RealProperty}
   */
  updateProperty(idOrProperty, changes = {}) {
    const property = this._resolve(idOrProperty);
    const original = { ...property };
    this.mergeChanges(property, changes);
    this._publish('UPDATE', property, original);
    this._wireNodeEdges(property);
    return property;
  }

  /**
   * Remove a property from the service and publish DELETE.
   * @param {string|import('../assets/real-property.js').RealProperty} idOrProperty
   * @returns {import('../assets/real-property.js').RealProperty}
   */
  deleteProperty(idOrProperty) {
    const property = this._resolve(idOrProperty);
    this._unregister(property.id);
    this._publish('DELETE', property);
    return property;
  }

  // ─── Domain operations ────────────────────────────────────────────────────

  /**
   * Returns the property value attributable to one person.
   * When personId is provided and an owners array exists, uses percentage-based split.
   * Falls back to sole/joint split when no owners array or no matching owner.
   * @param {import('../assets/real-property.js').RealProperty} property
   * @param {string} [personId]
   * @returns {number}
   */
  getPersonShare(property, personId) {
    if (personId && property.owners?.length) {
      const owner = property.owners.find(o => o.personId === personId);
      return owner ? property.value * (owner.ownershipPct / 100) : 0;
    }
    return property.ownershipType === 'joint' ? property.value / 2 : property.value;
  }

  /**
   * Snapshots the current value on first residency change (one-time capture).
   * No-op if already set.
   * @param {import('../assets/real-property.js').RealProperty} property
   */
  recordResidencyChange(property) {
    if (property.balanceAtResidencyChange === null) {
      property.balanceAtResidencyChange = property.value;
    }
  }

  /**
   * Increases the outstanding mortgage balance.
   * @param {import('../assets/real-property.js').RealProperty} property
   * @param {number} amount - Positive draw amount
   */
  takeMortgageLoan(property, amount) {
    property.mortgageBalance = (property.mortgageBalance ?? 0) + amount;
  }

  /**
   * Decreases the outstanding mortgage balance, floored at 0.
   * @param {import('../assets/real-property.js').RealProperty} property
   * @param {number} amount - Positive repayment amount
   */
  repayMortgage(property, amount) {
    property.mortgageBalance = Math.max(0, (property.mortgageBalance ?? 0) - amount);
  }

  /**
   * Compounds the annual appreciation rate over the given period.
   * @param {import('../assets/real-property.js').RealProperty} property
   * @param {number} [years=1] - Years to compound (fractional values supported)
   */
  applyAppreciation(property, years = 1) {
    property.value = property.value * Math.pow(1 + property.appreciationRate, years);
  }

  /**
   * Sets the current market value directly (e.g. from a formal appraisal).
   * @param {import('../assets/real-property.js').RealProperty} property
   * @param {number} newValue
   */
  appraise(property, newValue) {
    property.value = newValue;
  }
}
