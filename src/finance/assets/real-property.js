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
   * @param {string}        [opts.country='US']                 - 'US' | 'AU' — determines currency and sale tax treatment
   * @param {object|null}   [opts.currency=null]                - Currency descriptor (e.g. USD / AUD from account.js)
   * @param {Array<{date: Date|string, rate: number}>|null} [opts.appreciationSchedule=null]
   *                                                            - Step-wise appreciation schedule (design 28 §3)
   * @param {string|null}   [opts.market=null]                  - Market code, e.g. 'US-SF-BAY' (design 28 §4)
   *
   * Rental income (design 48). All optional; inert when rentalEnabled is false.
   * @param {boolean}       [opts.rentalEnabled=false]          - Master switch for the rental income series
   * @param {number}        [opts.monthlyRent=0]                - Gross fully-occupied monthly rent (property currency)
   * @param {number}        [opts.occupancyRate=0.95]           - Fraction of potential realized (LTR ≈ 0.95, STR ≈ 0.55)
   * @param {number}        [opts.rentalExpenseRatio=0.25]      - Deductible cash opex as a fraction of effective gross rent
   * @param {number}        [opts.mortgageInterestRate=0]       - Annual mortgage interest rate; deductible interest = balance × rate / 12
   * @param {number}        [opts.landValueRatio=0.2]           - Non-depreciable land fraction of costBasis
   * @param {number|null}   [opts.annualDepreciationOverride=null] - Explicit annual depreciation $; overrides per-country derivation
   * @param {number}        [opts.accumulatedDepreciation=0]    - Running total of depreciation taken; reduces basis at sale (§4.5)
   *
   * Cross-border CGT (design 62 §5). Set on foreign (non-TAP) property when the owner
   * becomes an AU resident — the ITAA97 s855-45 deemed acquisition. Absent for TAP
   * (domestic) property, which keeps its original basis.
   * @param {Object<string,number>|null} [opts.costBaseByCountry=null]      - Per-country stepped-up basis (market value at the move)
   * @param {number|null}   [opts.acquisitionPriceLevel=null]              - CPI level at the deemed AU acquisition (for reform indexation)
   * @param {Object<string,number>|null} [opts.acquisitionDateByCountry=null] - Per-country deemed-acquisition date (epoch ms); also the
   *                                                                          main-residence absence-rule start date (design 62 §5.3)
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
    this.country                 = opts.country                 ?? 'US';
    this.currency                = opts.currency                ?? null;
    this.appreciationSchedule    = opts.appreciationSchedule    ?? null;
    this.market                  = opts.market                  ?? null;
    // Rental income (design 48)
    this.rentalEnabled              = opts.rentalEnabled              ?? false;
    this.monthlyRent                = opts.monthlyRent                ?? 0;
    this.occupancyRate              = opts.occupancyRate              ?? 0.95;
    this.rentalExpenseRatio         = opts.rentalExpenseRatio         ?? 0.25;
    this.mortgageInterestRate       = opts.mortgageInterestRate       ?? 0;
    // Prime-relative mortgage rate (design 56 Phase 3). When set, the synthesized loan
    // (synthesizeLoanForProperty) carries this as its `primeSpread` and pays
    // `Prime(country,t) + spread`; null → the fixed absolute `mortgageInterestRate`.
    this.mortgagePrimeSpread        = opts.mortgagePrimeSpread        ?? null;
    this.landValueRatio             = opts.landValueRatio             ?? 0.2;
    this.annualDepreciationOverride = opts.annualDepreciationOverride ?? null;
    this.accumulatedDepreciation    = opts.accumulatedDepreciation    ?? 0;
    // Cross-border CGT step-up (design 62 §5) — foreign property only.
    this.costBaseByCountry          = opts.costBaseByCountry          ?? null;
    this.acquisitionPriceLevel      = opts.acquisitionPriceLevel      ?? null;
    this.acquisitionDateByCountry   = opts.acquisitionDateByCountry   ?? null;
  }
}
