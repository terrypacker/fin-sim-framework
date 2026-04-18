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

/**
 * Asset — named holding with a current value and cost basis.
 * Used for non-ledger assets such as real property.
 * No methods; safe for structuredClone snapshots.
 * Logic lives in AssetService.
 */
export class Asset {
  /**
   * @param {string} name      - Asset identifier (e.g. 'Primary Residence')
   * @param {number} value     - Current market value (default 0)
   * @param {number} costBasis - Original purchase cost (default 0)
   * @param {object} [opts]
   * @param {string}      [opts.ownershipType='sole']          - 'sole' | 'joint'
   * @param {string}      [opts.ownerId=null]                  - Person id of primary owner
   * @param {number|null} [opts.drawdownPriority=null]         - Liquidation order (1 = first)
   * @param {number|null} [opts.balanceAtResidencyChange=null] - Snapshot on residency change
   * @param {number}      [opts.loanBalance=0]                 - Outstanding loan (AR-9)
   */
  constructor(name = '', value = 0, costBasis = 0, opts = {}) {
    this.name                     = name;
    this.value                    = value;
    this.costBasis                = costBasis;
    this.ownershipType            = opts.ownershipType            ?? 'sole';
    this.ownerId                  = opts.ownerId                  ?? null;
    this.drawdownPriority         = opts.drawdownPriority         ?? null;
    this.balanceAtResidencyChange = opts.balanceAtResidencyChange ?? null;
    this.loanBalance              = opts.loanBalance              ?? 0;
  }
}
