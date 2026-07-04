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
 * CompanyEquity — market-value asset representing an ownership stake in a
 * private or public company (startup equity, a founder's business, a private
 * holding, etc.). Appreciates like a collectible and liquidates in a single
 * lump sum at a planned sale year, paying capital-gains tax on the gain via the
 * existing COMPANY_SALE → COMPANY_SALE_TAX pathway (US LTCG + AU CGT when
 * AU-resident). No mortgage or monthly payments.
 * No methods; safe for structuredClone snapshots.
 * Logic lives in CompanyEquityService.
 *
 * @typedef {{ personId: string, ownershipPct: number }} CompanyEquityOwner
 */
export class CompanyEquity extends Asset {
  /**
   * @param {number} initialValue - Current market value of the stake (default 0)
   * @param {object} [opts]
   * @param {string|null}   [opts.id=null]                      - Assigned by service; null until registered
   * @param {string}        [opts.name='']                      - Display name (e.g. 'Startup Equity')
   * @param {string}        [opts.ownershipType='sole']         - 'sole' | 'joint' (fallback when owners is empty)
   * @param {string|null}   [opts.ownerId=null]                 - Primary owner id (fallback when owners is empty)
   * @param {number|null}   [opts.drawdownPriority=null]        - Liquidation order (1 = first)
   * @param {number}        [opts.costBasis=0]                  - Original acquisition / strike cost
   * @param {number}        [opts.appreciationRate=0.08]        - Annual appreciation rate as a decimal (equity default 8%)
   * @param {number|null}   [opts.plannedSaleYear=null]         - Calendar year of the liquidity event
   * @param {string|null}   [opts.saleDestinationAccount=null]  - Account id to receive net sale proceeds
   * @param {CompanyEquityOwner[]} [opts.owners=[]]             - Per-person ownership breakdown; overrides sole/joint split
   * @param {number|null}   [opts.balanceAtResidencyChange=null] - Value snapshot on first residency change
   * @param {string}        [opts.country='US']                 - 'US' | 'AU' — determines currency and sale tax treatment
   * @param {object|null}   [opts.currency=null]                - Currency descriptor (e.g. USD / AUD from account.js)
   * @param {Array<{date: Date|string, rate: number}>|null} [opts.appreciationSchedule=null]
   *                                                            - Step-wise appreciation schedule (design 28 §3)
   */
  constructor(initialValue = 0, opts = {}) {
    super(opts.name ?? '', { ...opts, kind: 'company' });
    this.value                    = initialValue;
    this.costBasis                = opts.costBasis                ?? 0;
    this.appreciationRate         = opts.appreciationRate         ?? 0.08;
    this.plannedSaleYear          = opts.plannedSaleYear          ?? null;
    this.saleDestinationAccount   = opts.saleDestinationAccount   ?? null;
    this.owners                   = opts.owners                   ?? [];
    this.balanceAtResidencyChange = opts.balanceAtResidencyChange ?? null;
    this.country                  = opts.country                  ?? 'US';
    this.currency                 = opts.currency                 ?? null;
    this.appreciationSchedule     = opts.appreciationSchedule     ?? null;
  }
}
