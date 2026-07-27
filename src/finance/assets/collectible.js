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

import { Asset } from './asset.js';

/**
 * Collectible — market-value asset representing a physical collectible
 * (art, wine, jewellery, vintage cars, etc.).
 * No mortgage or monthly payments; appreciates like real property.
 * No methods; safe for structuredClone snapshots.
 * Logic lives in CollectibleService.
 *
 * @typedef {{ personId: string, ownershipPct: number }} CollectibleOwner
 */
export class Collectible extends Asset {
  /**
   * @param {number} initialValue - Current market value (default 0)
   * @param {object} [opts]
   * @param {string|null}   [opts.id=null]                      - Assigned by service; null until registered
   * @param {string}        [opts.name='']                      - Display name (e.g. 'Picasso Sketch')
   * @param {string}        [opts.ownershipType='sole']         - 'sole' | 'joint' (fallback when owners is empty)
   * @param {string|null}   [opts.ownerId=null]                 - Primary owner id (fallback when owners is empty)
   * @param {number|null}   [opts.drawdownPriority=null]        - Liquidation order (1 = first)
   * @param {number}        [opts.costBasis=0]                  - Original purchase price
   * @param {number}        [opts.appreciationRate=0.035]       - Annual appreciation rate as a decimal
   * @param {number|null}   [opts.plannedSaleYear=null]         - Calendar year of planned sale
   * @param {string|null}   [opts.saleDestinationAccount=null]  - Account id to receive net sale proceeds
   * @param {CollectibleOwner[]} [opts.owners=[]]               - Per-person ownership breakdown; overrides sole/joint split
   * @param {number|null}   [opts.balanceAtResidencyChange=null] - Value snapshot on first residency change
   * @param {string}        [opts.country='US']                 - 'US' | 'AU' — determines currency and sale tax treatment
   * @param {object|null}   [opts.currency=null]                - Currency descriptor (e.g. USD / AUD from account.js)
   * @param {Array<{date: Date|string, rate: number}>|null} [opts.appreciationSchedule=null]
   *                                                            - Step-wise appreciation schedule (design 28 §3)
   * @param {boolean}       [opts.isGold=false]                 - Investment bullion: an ordinary AU CGT asset (indexed
   *                                                              under the FY2027 reform), not a true collectible (design 57 Part 2, Item C)
   * @param {object|null}   [opts.costBaseByCountry=null]       - Per-country cost-base override (AU s855-45 residency step-up)
   * @param {number|null}   [opts.acquisitionPriceLevel=null]   - AU CPI level at the deemed AU acquisition (residency date) for indexation
   */
  constructor(initialValue = 0, opts = {}) {
    super(opts.name ?? '', { ...opts, kind: 'collectible' });
    this.value                    = initialValue;
    this.costBasis                = opts.costBasis                ?? 0;
    this.appreciationRate         = opts.appreciationRate         ?? 0.035;
    this.plannedSaleYear          = opts.plannedSaleYear          ?? null;
    this.saleDestinationAccount   = opts.saleDestinationAccount   ?? null;
    this.owners                   = opts.owners                   ?? [];
    this.balanceAtResidencyChange  = opts.balanceAtResidencyChange ?? null;
    this.country                  = opts.country                  ?? 'US';
    this.currency                 = opts.currency                 ?? null;
    this.appreciationSchedule     = opts.appreciationSchedule     ?? null;
    // AU CGT reform (design 57 Part 2, Item C). Bullion is an ordinary AU CGT
    // asset → its AU gain is cost-base indexed like equity; true collectibles are
    // not. costBaseByCountry.AU + acquisitionPriceLevel are stamped at the AU
    // residency step-up (CollectibleService.recordResidencyChange).
    this.isGold                   = opts.isGold                   ?? false;
    this.costBaseByCountry        = opts.costBaseByCountry        ?? null;
    this.acquisitionPriceLevel    = opts.acquisitionPriceLevel    ?? null;
  }
}
