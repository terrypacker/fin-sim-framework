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

import { BaseService }       from '../../services/base-service.js';
import { USD, AUD, ACCOUNT_TYPE } from '../assets/account.js';
import { ACCOUNT_ROLES }     from '../state/account-roles.js';

/**
 * Per-`__type` metadata for an inherited asset descriptor: how it seeds into
 * state and which death-tax path it follows (design 63 §5–§6). Centralized here
 * so the INHERITANCE toolset's zero-seed step (P1) and the INHERIT funding
 * reducer (P2) share one source of truth for the asset taxonomy.
 *
 *   category    — 'account' (numeric balance) | 'real-property' | 'collectible'
 *   accountType — ACCOUNT_TYPE discriminator for account-category assets
 *   isRetirement— pre-tax/Roth/super wrapper (IRD / SECURE / super-death paths)
 *   isSuper     — AU superannuation (forced lump-sum payout, not an ongoing account)
 *   isRoth      — inherited Roth (10-year clock, tax-free distributions)
 */
const INHERITED_ASSET_META = Object.freeze({
  RealProperty:          { category: 'real-property', accountType: null,                        isRetirement: false, isSuper: false, isRoth: false },
  Collectible:           { category: 'collectible',   accountType: null,                        isRetirement: false, isSuper: false, isRoth: false },
  InvestmentAccount:     { category: 'account',       accountType: ACCOUNT_TYPE.BROKERAGE,      isRetirement: false, isSuper: false, isRoth: false },
  BrokerageAccount:      { category: 'account',       accountType: ACCOUNT_TYPE.BROKERAGE,      isRetirement: false, isSuper: false, isRoth: false },
  TraditionalIRAAccount: { category: 'account',       accountType: ACCOUNT_TYPE.TRADITIONAL_IRA, isRetirement: true,  isSuper: false, isRoth: false },
  FourOhOneKAccount:     { category: 'account',       accountType: ACCOUNT_TYPE.FOUR_OH_ONE_K,  isRetirement: true,  isSuper: false, isRoth: false },
  RothAccount:           { category: 'account',       accountType: ACCOUNT_TYPE.ROTH,           isRetirement: true,  isSuper: false, isRoth: true  },
  SuperannuationAccount: { category: 'account',       accountType: ACCOUNT_TYPE.SUPER,          isRetirement: true,  isSuper: true,  isRoth: false },
});

/**
 * Resolve the seed/tax metadata for an inherited-asset `__type`.
 * @param {string} type
 * @returns {{category:string, accountType:(string|null), isRetirement:boolean, isSuper:boolean, isRoth:boolean}|null}
 */
export function inheritedAssetMeta(type) {
  return INHERITED_ASSET_META[type] ?? null;
}

/**
 * BequestService — CRUD and expansion for Bequest config containers (design 63).
 *
 * Extends BaseService (kind 'bequest', id prefix 'beq'). A Bequest is a graph
 * node like a Person/Account, but its inherited assets live inline in
 * `bequest.assets` rather than as separate service items, so the service owns
 * the expansion of a Bequest into (a) zero-valued state seeds (this file, P1)
 * and (b) the INHERIT + INHERITED_RA_DISTRIBUTION schedules (P2/P3, built in the
 * INHERITANCE toolset from the same expansion metadata).
 */
export class BequestService extends BaseService {
  /**
   * @param {import('../../graph/graph.js').Graph} [graph]
   * @param query - graph query api
   * @param {import('../../simulation-framework/event-bus.js').EventBus} [bus]
   */
  constructor(graph, query, bus) {
    super(graph, query, bus, 'bequest', 3, false);
  }

  // ─── Create / Update / Delete ─────────────────────────────────────────────

  /**
   * Register a pre-built Bequest, assign a service id, assign stable stateKeys to
   * any inherited asset that lacks one, and publish CREATE.
   * @param {import('../assets/bequest.js').Bequest} bequest
   * @returns {import('../assets/bequest.js').Bequest}
   */
  createBequest(bequest) {
    bequest.id = this._generateId(this._idPrefix);
    if (!bequest.stateKey) bequest.stateKey = bequest.id;
    this._assignAssetStateKeys(bequest);
    this._register(bequest);
    this._publish('CREATE', bequest);
    this._wireNodeEdges(bequest);
    return bequest;
  }

  /**
   * Apply changes to an existing Bequest and publish UPDATE. Re-derives stateKeys
   * for any newly-added asset so the state seed stays addressable.
   * @param {string|import('../assets/bequest.js').Bequest} idOrBequest
   * @param {object} changes
   * @returns {import('../assets/bequest.js').Bequest}
   */
  updateBequest(idOrBequest, changes = {}) {
    const bequest  = this._resolve(idOrBequest);
    const original = { ...bequest };
    this.mergeChanges(bequest, changes);
    this._assignAssetStateKeys(bequest);
    this._publish('UPDATE', bequest, original);
    this._wireNodeEdges(bequest);
    return bequest;
  }

  /**
   * Remove a Bequest and publish DELETE.
   * @param {string|import('../assets/bequest.js').Bequest} idOrBequest
   * @returns {import('../assets/bequest.js').Bequest}
   */
  deleteBequest(idOrBequest) {
    const bequest = this._resolve(idOrBequest);
    this._unregister(bequest.id);
    this._publish('DELETE', bequest);
    return bequest;
  }

  // ─── Expansion ────────────────────────────────────────────────────────────

  /**
   * Expand a Bequest into zero-valued state seeds + per-asset funding metadata.
   *
   * Seed-at-zero, fund-on-event (design 63 §5): every inherited record seeds with
   * value/balance 0 so it contributes nothing to net worth or drawdown until the
   * INHERIT event funds it — no new visibility gates anywhere. The INHERITANCE
   * toolset consumes `.seeds` in its state() step; the INHERIT handler/reducer
   * (P2) consumes `.inherited` (funding descriptors) to fund each record, stamp
   * basis per country rules, and record death tax.
   *
   * @param {import('../assets/bequest.js').Bequest} bequest
   * @returns {{ seeds: Object<string,object>, inherited: Array<object>, inheritanceDateMs: number|null }}
   */
  expand(bequest) {
    const seeds     = {};
    const inherited = [];
    const inheritanceDateMs = bequest.inheritanceYear != null
      ? Date.UTC(bequest.inheritanceYear, bequest.inheritanceMonth ?? 0, bequest.inheritanceDay ?? 15)
      : null;

    for (const asset of (bequest.assets ?? [])) {
      const meta = inheritedAssetMeta(asset.__type);
      if (!meta || !asset.stateKey) continue;
      // INHERITANCE runs last, so this seed is authoritative (net worth always works,
      // even without the owning toolset). For promoted assets (design 63 §13) the
      // owning toolset — pulled in via the compiler's context-injection — adds the
      // growth / dividend / appreciation / sale *handlers* on top of this state.
      seeds[asset.stateKey] = this._seedPlain(asset, meta, bequest);
      inherited.push(this._fundingDescriptor(asset, meta, bequest));
    }

    return { seeds, inherited, inheritanceDateMs };
  }

  /**
   * Promote a Bequest's inherited brokerage / real-property / collectible assets
   * into first-class SERVICE-RECORD shapes (design 63 §13) so the compiler can
   * inject them into `context.accounts` / `context.realProperties` /
   * `context.collectibles`. Their own toolsets then seed (at 0), grow, draw, and
   * sell them like any other record — the INHERIT event funds them at the date.
   *
   * Only ACTIVE bequests (a set inheritanceYear) contribute, so an inert bequest
   * injects nothing and the reference golden stays byte-identical. Inherited
   * retirement accounts are NOT promoted here (they are drained by the SECURE
   * 10-year stream, §6.2; discretionary drawdown + growth are v2 — §13.4/§13.5);
   * super is a forced lump-sum (§6.4).
   *
   * @param {import('../assets/bequest.js').Bequest} bequest
   * @returns {{ accounts: object[], realProperties: object[], collectibles: object[] }}
   */
  expandContextRecords(bequest) {
    const out = { accounts: [], realProperties: [], collectibles: [] };
    if (bequest.inheritanceYear == null) return out;   // inert ⇒ inject nothing

    for (const asset of (bequest.assets ?? [])) {
      const meta = inheritedAssetMeta(asset.__type);
      if (!meta || !asset.stateKey) continue;
      const country  = asset.country ?? 'US';
      const currency = asset.currency ?? (country === 'AU' ? AUD : USD);
      const ownerId  = asset.ownerId ?? bequest.heirId ?? null;
      const marker   = { inherited: true, bequestId: bequest.id };

      if (meta.category === 'account' && !meta.isRetirement) {
        // Inherited brokerage → heir-owned equity account: liquid, drawdownable,
        // grows + pays dividends via the country's brokerage machinery.
        out.accounts.push({
          __type:                'BrokerageAccount',
          name:                  asset.name ?? 'Inherited Brokerage',
          stateKey:              asset.stateKey,
          type:                  ACCOUNT_TYPE.BROKERAGE,
          role:                  country === 'AU' ? ACCOUNT_ROLES.AU_STOCK : ACCOUNT_ROLES.US_STOCK,
          balance:               0,
          contributionBasis:     0,
          holdings:              [],
          ownerId, country, currency,
          drawdownPriority:      asset.drawdownPriority ?? 2,
          growthRate:            asset.growthRate   ?? null,
          dividendRate:          asset.dividendRate ?? null,
          allowsEarlyWithdrawal: true,
          ...marker,
        });
      } else if (meta.category === 'real-property') {
        out.realProperties.push({
          __type:              'RealProperty',
          name:                asset.name ?? 'Inherited Home',
          stateKey:            asset.stateKey,
          value:               0,
          costBasis:           0,
          mortgageBalance:     0,
          appreciationRate:    asset.appreciationRate ?? 0.04,
          plannedSaleYear:     asset.plannedSaleYear ?? null,
          ownerId, country, currency,
          isPrimaryResidence:  false,
          inheritedFromMainResidence: asset.inheritedFromMainResidence ?? false,
          ...marker,
        });
      } else if (meta.category === 'collectible') {
        out.collectibles.push({
          __type:           'Collectible',
          name:             asset.name ?? 'Inherited Collectible',
          stateKey:         asset.stateKey,
          value:            0,
          costBasis:        0,
          appreciationRate: asset.appreciationRate ?? 0.035,
          plannedSaleYear:  asset.plannedSaleYear ?? null,
          isGold:           asset.isGold ?? false,
          ownerId, country, currency,
          ...marker,
        });
      }
    }
    return out;
  }

  // ─── Internal helpers ─────────────────────────────────────────────────────

  /**
   * Build the flat, structuredClone-safe funding descriptor baked into the
   * INHERIT event's data (design 63 §5). The INHERIT handler/reducer read these
   * fields to fund each record, stamp basis (§6.1/§6.3/§7), and — later — record
   * death tax (§6.4/§6.5). No service refs, so it survives the event queue.
   * @param {object} asset
   * @param {object} meta
   * @param {import('../assets/bequest.js').Bequest} bequest
   * @returns {object}
   */
  _fundingDescriptor(asset, meta, bequest) {
    return {
      stateKey:                   asset.stateKey,
      name:                       asset.name ?? '',
      category:                   meta.category,
      isRetirement:               meta.isRetirement,
      isSuper:                    meta.isSuper,
      isRoth:                     meta.isRoth,
      country:                    asset.country ?? 'US',
      inheritedValue:             asset.inheritedValue ?? 0,
      deceasedCostBase:           asset.deceasedCostBase ?? null,
      deceasedAcquisitionDate:    asset.deceasedAcquisitionDate ?? null,
      inheritedFromMainResidence: asset.inheritedFromMainResidence ?? false,
      // AU super death-benefit split (§6.4) — consumed in P4.
      taxFreeComponent:           asset.taxFreeComponent ?? null,
      taxableComponent:           asset.taxableComponent ?? null,
      // NE inheritance-tax discriminators (§6.5) — consumed in P4.
      relationship:               bequest.relationship ?? 'immediate',
      decedentState:              bequest.decedentState ?? null,
      paidViaEstate:              bequest.paidViaEstate ?? false,
    };
  }

  /**
   * Assign a stable `stateKey` to every inherited asset that lacks one, derived
   * from the bequest id so it survives serialize/deserialize round-trips.
   * @param {import('../assets/bequest.js').Bequest} bequest
   */
  _assignAssetStateKeys(bequest) {
    const base = bequest.stateKey || bequest.id;
    (bequest.assets ?? []).forEach((asset, i) => {
      if (asset.stateKey) return;
      // Design 63 §14.6: account-category inherited assets get an `…Account`
      // suffix so their `<stateKey>.balance` journal rows match the per-account
      // reports' `contains 'account.balance'` convention (the report `api` can't
      // see the account set, so the key itself must carry the marker). Property /
      // collectible keys stay bare — they journal `.value`, not `.balance`, and are
      // correctly excluded from account-balance reports.
      const isAccount = inheritedAssetMeta(asset.__type)?.category === 'account';
      asset.stateKey = `${base}_a${i}${isAccount ? 'Account' : ''}`;
    });
  }

  /**
   * Build the zero-valued state entry for one inherited asset. Shapes mirror the
   * existing account / real-property / collectible state plains so net-worth.js
   * and the post-funding sale/CGT paths consume the funded record unchanged.
   * @param {object} asset - inherited-asset descriptor
   * @param {object} meta  - INHERITED_ASSET_META entry
   * @param {import('../assets/bequest.js').Bequest} bequest
   * @returns {object}
   */
  _seedPlain(asset, meta, bequest) {
    const country  = asset.country ?? 'US';
    const currency = asset.currency ?? (country === 'AU' ? AUD : USD);
    const ownerId  = asset.ownerId ?? bequest.heirId ?? null;
    // Common markers so funding (P2) + death-tax (P4) code can find inherited
    // records and route them back to their originating bequest.
    const marker = { inherited: true, bequestId: bequest.id };

    if (meta.category === 'real-property') {
      return {
        kind:           'real-property',
        name:           asset.name ?? null,
        stateKey:       asset.stateKey,
        value:          0,
        mortgageBalance: 0,
        costBasis:      0,
        country, currency, ownerId,
        ...marker,
      };
    }
    if (meta.category === 'collectible') {
      return {
        kind:      'collectible',
        name:      asset.name ?? null,
        stateKey:  asset.stateKey,
        value:     0,
        costBasis: 0,
        country, currency, ownerId,
        ...marker,
      };
    }
    // account category (brokerage / retirement / super).
    // Inherited BROKERAGE is promoted (design 63 §13): a heir-owned equity account
    // with a role + drawdownPriority so it counts toward net liquidity and enters
    // the discretionary drawdown list (state-driven — works even without the
    // brokerage toolset; growth/dividends need it). Retirement stays out of
    // discretionary drawdown in v1 (drained by the SECURE stream; §13.5 v2), and
    // super is a lump-sum (never funded as an account).
    const isPromotedBrokerage = meta.category === 'account' && !meta.isRetirement;
    const plain = {
      balance:               0,
      name:                  asset.name ?? null,
      stateKey:              asset.stateKey,
      type:                  meta.accountType,
      country, currency, ownerId,
      role:                  isPromotedBrokerage
                               ? (country === 'AU' ? ACCOUNT_ROLES.AU_STOCK : ACCOUNT_ROLES.US_STOCK)
                               : null,
      minimumBalance:        0,
      drawdownPriority:      isPromotedBrokerage ? (asset.drawdownPriority ?? 2) : null,
      allowsEarlyWithdrawal: isPromotedBrokerage,
      holdings:              [],
      ...marker,
    };
    if (meta.isRetirement) {
      plain.contributionBasis = 0;
      plain.earningsBasis     = 0;
    }
    return plain;
  }
}
