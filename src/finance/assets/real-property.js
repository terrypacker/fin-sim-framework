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
 * RealProperty — market-value asset representing owned real estate.
 * Tracks current value, mortgage, appreciation, and sale intent.
 * No methods; safe for structuredClone snapshots.
 * Logic lives in RealPropertyService.
 *
 * @typedef {{ personId: string, ownershipPct: number }} PropertyOwner
 */
export class RealProperty extends Asset {
  /**
   * @param {number} initialValue - Current market value (default 0)
   * @param {object} [opts]
   * @param {string|null}   [opts.id=null]                      - Assigned by service; null until registered
   * @param {string}        [opts.name='']                      - Display name (e.g. 'Primary Residence')
   * @param {string}        [opts.ownershipType='sole']         - 'sole' | 'joint' (fallback when owners is empty)
   * @param {string|null}   [opts.ownerId=null]                 - Primary owner id (fallback when owners is empty)
   * @param {number|null}   [opts.drawdownPriority=null]        - Liquidation order (1 = first)
   * @param {number}        [opts.costBasis=0]                  - Original purchase price
   * @param {number}        [opts.mortgageBalance=0]            - Outstanding mortgage balance
   * @param {number}        [opts.monthlyMortgage=0]            - Fixed monthly mortgage payment
   * @param {number}        [opts.appreciationRate=0.035]       - Annual appreciation rate as a decimal
   * @param {boolean}       [opts.isPrimaryResidence=false]     - Affects capital-gains tax treatment
   * @param {number|null}   [opts.plannedSaleYear=null]         - Calendar year of planned sale
   * @param {string|null}   [opts.saleDestinationAccount=null]  - Account id to receive net sale proceeds
   * @param {PropertyOwner[]} [opts.owners=[]]                  - Per-person ownership breakdown; overrides sole/joint split
   * @param {number|null}   [opts.balanceAtResidencyChange=null] - Value snapshot on first residency change
   */
  constructor(initialValue = 0, opts = {}) {
    super(opts.name ?? '', { ...opts, kind: 'real-property' });
    this.value                   = initialValue;
    this.costBasis               = opts.costBasis               ?? 0;
    this.mortgageBalance         = opts.mortgageBalance         ?? 0;
    this.monthlyMortgage         = opts.monthlyMortgage         ?? 0;
    this.appreciationRate        = opts.appreciationRate        ?? 0.035;
    this.isPrimaryResidence      = opts.isPrimaryResidence      ?? false;
    this.plannedSaleYear         = opts.plannedSaleYear         ?? null;
    this.saleDestinationAccount  = opts.saleDestinationAccount  ?? null;
    this.owners                  = opts.owners                  ?? [];
    this.balanceAtResidencyChange = opts.balanceAtResidencyChange ?? null;
  }
}
