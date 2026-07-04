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
 * CompanyEquityService — CRUD and domain operations for CompanyEquity instances.
 *
 * Extends AssetService (BaseService → AssetService → CompanyEquityService).
 * Mirrors CollectibleService; id prefix 'com' (prefixLength 3) keeps ids
 * distinct from collectibles' 'co'.
 */
export class CompanyEquityService extends AssetService {
  /**
   * @param {import('../../graph/graph.js').Graph} [graph]
   * @param query - graph query api
   * @param {import('../../simulation-framework/event-bus.js').EventBus} [bus]
   */
  constructor(graph, query, bus) {
    super(graph, query, bus, 'company', 3, false);
  }

  // ─── Create / Update / Delete ─────────────────────────────────────────────

  /**
   * Register a pre-built company-equity asset, assign a service-generated id,
   * and publish CREATE.
   * @param {import('../assets/company-equity.js').CompanyEquity} equity
   * @returns {import('../assets/company-equity.js').CompanyEquity}
   */
  createCompanyEquity(equity) {
    equity.id = this._generateId(this._idPrefix);
    if (!equity.stateKey) {
      equity.stateKey = equity.id;
    }
    this._register(equity);
    this._publish('CREATE', equity);
    this._wireNodeEdges(equity);
    return equity;
  }

  /**
   * Apply changes to an existing company-equity asset and publish UPDATE.
   * @param {string|import('../assets/company-equity.js').CompanyEquity} idOrEquity
   * @param {object} changes
   * @returns {import('../assets/company-equity.js').CompanyEquity}
   */
  updateCompanyEquity(idOrEquity, changes = {}) {
    const equity   = this._resolve(idOrEquity);
    const original = { ...equity };
    this.mergeChanges(equity, changes);
    this._publish('UPDATE', equity, original);
    this._wireNodeEdges(equity);
    return equity;
  }

  /**
   * Remove a company-equity asset from the service and publish DELETE.
   * @param {string|import('../assets/company-equity.js').CompanyEquity} idOrEquity
   * @returns {import('../assets/company-equity.js').CompanyEquity}
   */
  deleteCompanyEquity(idOrEquity) {
    const equity = this._resolve(idOrEquity);
    this._unregister(equity.id);
    this._publish('DELETE', equity);
    return equity;
  }

  // ─── Domain operations ────────────────────────────────────────────────────

  /**
   * Returns the stake value attributable to one person.
   * When personId is provided and an owners array exists, uses percentage-based split.
   * Falls back to sole/joint split when no owners array or no matching owner.
   * @param {import('../assets/company-equity.js').CompanyEquity} equity
   * @param {string} [personId]
   * @returns {number}
   */
  getPersonShare(equity, personId) {
    if (personId && equity.owners?.length) {
      const owner = equity.owners.find(o => o.personId === personId);
      return owner ? equity.value * (owner.ownershipPct / 100) : 0;
    }
    return equity.ownershipType === 'joint' ? equity.value / 2 : equity.value;
  }

  /**
   * Snapshots the current value on first residency change (one-time capture).
   * No-op if already set.
   * @param {import('../assets/company-equity.js').CompanyEquity} equity
   */
  recordResidencyChange(equity) {
    if (equity.balanceAtResidencyChange === null) {
      equity.balanceAtResidencyChange = equity.value;
    }
  }

  /**
   * Compounds the annual appreciation rate over the given period.
   * @param {import('../assets/company-equity.js').CompanyEquity} equity
   * @param {number} [years=1] - Years to compound (fractional values supported)
   */
  applyAppreciation(equity, years = 1) {
    equity.value = equity.value * Math.pow(1 + equity.appreciationRate, years);
  }
}
