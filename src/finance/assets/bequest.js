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

import { SimGraphNode } from '../../graph/sim-graph-node.js';

/**
 * Bequest — a config container (design 63) describing a scheduled inheritance of
 * assets from an **external decedent** (a parent, relative, etc.) who is NOT a
 * `Person` in the scenario.
 *
 * A Bequest is the mirror of the design-49 CompanyEquity/COMPANY_SALE mechanic:
 * where COMPANY_SALE *zeroes* an asset at a scheduled date, an `INHERIT` event
 * *funds* the inherited assets at the `inheritanceYear` date. The container holds
 * a decedent descriptor, the inheritance date, and a list of inherited-asset
 * descriptors that reuse the existing asset/account types (no new asset classes).
 *
 * Each inherited asset seeds at t=0 with value/balance 0 (invisible to net worth
 * and drawdown automatically — no new gating code) and is funded on the INHERIT
 * event (design 63 §5). The Bequest itself contributes nothing to net worth; it
 * is a container, not an asset, so it carries no `value`/`balance`.
 *
 * No methods; safe for structuredClone snapshots. Logic lives in BequestService.
 *
 * @typedef {'immediate'|'remote'|'unrelated'} BequestRelationship
 *   NE inheritance-tax class discriminator (design 63 §6.5):
 *     immediate → Class 1 (parents/grandparents/children/grandchildren/siblings), $100k / 1%
 *     remote    → Class 2 (aunts/uncles/nieces/nephews + descendants),            $40k / 11%
 *     unrelated → Class 3 (unrelated),                                            $25k / 15%
 *
 * @typedef {Object} InheritedAsset
 * @property {string}  __type            - Tagged asset type: 'RealProperty' | 'Collectible' |
 *                                          'InvestmentAccount' | 'BrokerageAccount' |
 *                                          'TraditionalIRAAccount' | 'FourOhOneKAccount' |
 *                                          'RothAccount' | 'SuperannuationAccount'
 * @property {string}  [name]            - Display name
 * @property {string}  [stateKey]        - Slot in sim.state (assigned by BequestService if absent)
 * @property {string}  [country]         - 'US' | 'AU' — determines currency + death-tax path
 * @property {number}  [inheritedValue]  - FMV at the inheritance date (nominal); funded on INHERIT
 * @property {number}  [deceasedCostBase]        - AU inherited cost base (no step-up; design 63 §6.3)
 * @property {number}  [deceasedAcquisitionDate] - Deceased's acquisition date (epoch ms) — preserves
 *                                          the AU CGT-discount / indexation clock (design 62 §4)
 * @property {number}  [taxFreeComponent]        - AU super tax-free component (design 63 §6.4)
 * @property {number}  [taxableComponent]        - AU super taxable component (defaults to full balance)
 * @property {boolean} [inheritedFromMainResidence] - AU deceased main-residence 2-year exemption (§6.3)
 * @property {string}  [distributionMode]        - US inherited-RA SECURE strategy id (design 63 §6.2)
 */
export class Bequest extends SimGraphNode {
  /**
   * @param {object} [opts]
   * @param {string|null} [opts.id=null]              - Assigned by service; null until registered
   * @param {string}      [opts.name='']              - Display name (e.g. "Mother's Estate")
   * @param {string}      [opts.decedentName='']       - Name of the external decedent
   * @param {BequestRelationship} [opts.relationship='immediate'] - Heir↔decedent class (NE tax)
   * @param {string|null} [opts.decedentState=null]   - Decedent's US state situs (NE/HI/SD/…);
   *                                                     state death tax keys off this, NOT the
   *                                                     heir's residency (design 63 §4.2). Null ⇒
   *                                                     defaults to the heir's residency state.
   * @param {string|null} [opts.heirId=null]          - Person id of the inheriting scenario person
   * @param {number|null} [opts.inheritanceYear=null] - Calendar year of the inheritance
   * @param {number}      [opts.inheritanceMonth=0]   - 0-based month of the inheritance date
   * @param {number}      [opts.inheritanceDay=15]    - Day-of-month of the inheritance date
   * @param {boolean}     [opts.paidViaEstate=false]  - AU super: paid via estate (no +2% Medicare)
   *                                                     vs direct to beneficiary (design 63 §6.4)
   * @param {InheritedAsset[]} [opts.assets=[]]       - Inherited-asset descriptors
   */
  constructor(opts = {}) {
    super({ id: opts.id ?? null, kind: 'bequest', layer: 'config', name: opts.name ?? '' });
    this.decedentName     = opts.decedentName     ?? '';
    this.relationship     = opts.relationship     ?? 'immediate';
    this.decedentState    = opts.decedentState    ?? null;
    this.heirId           = opts.heirId           ?? null;
    this.inheritanceYear  = opts.inheritanceYear  ?? null;
    this.inheritanceMonth = opts.inheritanceMonth ?? 0;
    this.inheritanceDay   = opts.inheritanceDay   ?? 15;
    this.paidViaEstate    = opts.paidViaEstate    ?? false;
    this.assets           = opts.assets           ?? [];
  }
}
