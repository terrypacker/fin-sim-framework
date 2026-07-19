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
 *   inheritedRole—dedicated promotion role (design 63 §15); non-super retirement only.
 *                 The plain IRA/K401/ROTH roles collide with the heir's own RMD /
 *                 contribution machinery, so a promoted inherited RA takes a distinct
 *                 role the SECURE stream still finds by stateKey.
 */
const INHERITED_ASSET_META = Object.freeze({
  RealProperty:          { category: 'real-property', accountType: null,                        isRetirement: false, isSuper: false, isRoth: false, inheritedRole: null },
  Collectible:           { category: 'collectible',   accountType: null,                        isRetirement: false, isSuper: false, isRoth: false, inheritedRole: null },
  InvestmentAccount:     { category: 'account',       accountType: ACCOUNT_TYPE.BROKERAGE,      isRetirement: false, isSuper: false, isRoth: false, inheritedRole: null },
  BrokerageAccount:      { category: 'account',       accountType: ACCOUNT_TYPE.BROKERAGE,      isRetirement: false, isSuper: false, isRoth: false, inheritedRole: null },
  TraditionalIRAAccount: { category: 'account',       accountType: ACCOUNT_TYPE.TRADITIONAL_IRA, isRetirement: true,  isSuper: false, isRoth: false, inheritedRole: ACCOUNT_ROLES.INHERITED_IRA },
  FourOhOneKAccount:     { category: 'account',       accountType: ACCOUNT_TYPE.FOUR_OH_ONE_K,  isRetirement: true,  isSuper: false, isRoth: false, inheritedRole: ACCOUNT_ROLES.INHERITED_K401 },
  RothAccount:           { category: 'account',       accountType: ACCOUNT_TYPE.ROTH,           isRetirement: true,  isSuper: false, isRoth: true,  inheritedRole: ACCOUNT_ROLES.INHERITED_ROTH },
  SuperannuationAccount: { category: 'account',       accountType: ACCOUNT_TYPE.SUPER,          isRetirement: true,  isSuper: true,  isRoth: false, inheritedRole: null },
});

/**
 * Derive the retirement flags for a PROMOTED inherited RA from its dedicated role
 * (design 63 §15). Promotion moves the RA into `cfg.accounts`, where its
 * originating `__type` meta is no longer at hand — the role is the durable marker.
 * Non-retirement roles → both false (brokerage funds a stepped-up lot, not IRD).
 * @param {string|null} role
 * @returns {{ isRetirement: boolean, isRoth: boolean }}
 */
export function promotedRetirementMeta(role) {
  if (role === ACCOUNT_ROLES.INHERITED_ROTH) return { isRetirement: true, isRoth: true };
  if (role === ACCOUNT_ROLES.INHERITED_IRA || role === ACCOUNT_ROLES.INHERITED_K401) {
    return { isRetirement: true, isRoth: false };
  }
  return { isRetirement: false, isRoth: false };
}

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

    // Inline assets: retirement / super (never promoted — SECURE stream / lump-sum),
    // plus brokerage/property/collectible in the fallback case where promotion did
    // not run (an inert bequest, or a registry-less test context). The INHERITANCE
    // toolset seeds these at 0 (authoritative — net worth works even without the
    // owning toolset) and the INHERIT event funds them.
    for (const asset of (bequest.assets ?? [])) {
      const meta = inheritedAssetMeta(asset.__type);
      if (!meta || !asset.stateKey) continue;
      seeds[asset.stateKey] = this._seedPlain(asset, meta, bequest);
      inherited.push(this._fundingDescriptor(asset, meta, bequest));
    }

    // Promoted SERVICE records (design 63 §14): brokerage / property / collectible
    // that were moved out of `bequest.assets` into their own services. Their owning
    // toolsets also seed them, but the INHERITANCE toolset runs LAST and seeds them
    // at 0 too (authoritative — net worth works even without the owning toolset,
    // exactly like the pre-§14 seed). The INHERIT event funds them + stamps basis
    // at the date, off the funding descriptor built from the record's metadata.
    // Promoted records link on the bequest's STATEKEY (its durable identity — the
    // loader hoist tags them before createBequest (re)assigns the id).
    for (const { record, category } of this._promotedRecords(bequest.stateKey ?? bequest.id)) {
      seeds[record.stateKey] = this._seedFromRecord(record, category);
      inherited.push(this._fundingDescriptorFromRecord(record, category, bequest));
    }

    return { seeds, inherited, inheritanceDateMs };
  }

  // ─── Promotion helpers (design 63 §14) ──────────────────────────────────────
  //
  // Inherited brokerage / real-property / collectible are promoted OUT of
  // `bequest.assets` into first-class service records tagged `{ inherited, bequestId }`,
  // seeded at 0 (the FMV rides in `inheritedValue`; the INHERIT event funds them at
  // the date). Because they are ordinary records they flow into every system — net
  // worth, liquidity, drawdown, earnings/appreciation handlers, sale scheduling,
  // per-record params, the OPT/MC/MPC levers, the holdings/journal UI — with no
  // per-system special-casing, and they serialize ONCE (in their own service).
  //
  // The promotion itself is a CONFIG transform run by the loader BEFORE the param
  // cascade (`ScenarioLoader._promoteBequestAssets`, design 63 §14.4 load-order
  // invariant), so the promoted record is an ordinary `cfg.accounts/realProperties/
  // collectibles` entry when its per-record params cascade. This service keeps only
  // the runtime helpers below, which read the already-promoted records back by
  // `bequestId` to seed + fund them.

  /**
   * Build the zero-valued state seed for a promoted service record — the same
   * shape _seedPlain produces for an inline asset, so the INHERITANCE toolset's
   * authoritative net-worth seed is identical whether the asset was promoted or
   * left inline. Brokerage keeps its role + drawdownPriority so liquidity/drawdown
   * are state-driven (work even without the brokerage toolset; growth needs it).
   * @param {object} record   - the promoted account / property / collectible record
   * @param {string} category - 'account' | 'real-property' | 'collectible'
   * @returns {object}
   */
  _seedFromRecord(record, category) {
    const marker = {
      name:      record.name ?? null,
      stateKey:  record.stateKey,
      country:   record.country  ?? 'US',
      currency:  record.currency ?? null,
      ownerId:   record.ownerId  ?? null,
      inherited: true,
      bequestId: record.bequestId,
    };
    if (category === 'real-property') {
      return { kind: 'real-property', value: 0, mortgageBalance: 0, costBasis: 0, ...marker };
    }
    if (category === 'collectible') {
      return { kind: 'collectible', value: 0, costBasis: 0, ...marker };
    }
    // account (inherited brokerage OR promoted inherited retirement — design 63 §15).
    // Brokerage seeds with its equity role + drawdownPriority (liquid, drawdownable);
    // a promoted RA seeds with its dedicated inherited-* role, `drawdownPriority: null`
    // (forced-stream-only), and `contributionBasis: 0` (IRD — whole balance is ordinary
    // income on distribution). Both seed at balance 0; the INHERIT event funds them.
    const { isRetirement } = promotedRetirementMeta(record.role);
    const seed = {
      balance:               0,
      type:                  record.type ?? ACCOUNT_TYPE.BROKERAGE,
      role:                  record.role ?? null,
      minimumBalance:        0,
      drawdownPriority:      record.drawdownPriority ?? null,
      allowsEarlyWithdrawal: true,
      holdings:              [],
      ...marker,
    };
    if (isRetirement) { seed.contributionBasis = 0; seed.earningsBasis = 0; }
    return seed;
  }

  /**
   * The promoted service records belonging to this bequest, across the account /
   * real-property / collectible services, tagged with their category.
   * @param {string} bequestId
   * @returns {Array<{record: object, category: string}>}
   */
  _promotedRecords(bequestId) {
    const reg = this.bus?.serviceRegistry;
    if (!reg) return [];
    const out = [];
    const scan = (svc, category) => {
      for (const r of (svc?.getAll?.() ?? [])) {
        if (r.inherited && r.bequestId === bequestId) out.push({ record: r, category });
      }
    };
    scan(reg.accountService,      'account');
    scan(reg.realPropertyService, 'real-property');
    scan(reg.collectibleService,  'collectible');
    return out;
  }

  /**
   * Build the flat INHERIT funding descriptor for a promoted service record,
   * reading the basis anchors off the record's inheritance metadata (design 63
   * §14 P1). Mirrors _fundingDescriptor (which reads an inline asset), so the
   * INHERIT reducer funds a promoted record identically to an inline one.
   * @param {object} record
   * @param {string} category - 'account' | 'real-property' | 'collectible'
   * @param {import('../assets/bequest.js').Bequest} bequest
   * @returns {object}
   */
  _fundingDescriptorFromRecord(record, category, bequest) {
    // A promoted RA (design 63 §15) funds pre-tax with NO stepped-up lot — the
    // INHERIT reducer branches on isRetirement. Derive it from the dedicated role
    // (super is never promoted, so isSuper stays false here).
    const { isRetirement, isRoth } = promotedRetirementMeta(record.role);
    return {
      stateKey:                   record.stateKey,
      name:                       record.name ?? '',
      category,
      isRetirement,
      isSuper:                    false,
      isRoth,
      country:                    record.country ?? 'US',
      inheritedValue:             record.inheritedValue ?? 0,
      deceasedCostBase:           record.deceasedCostBase ?? null,
      deceasedAcquisitionDate:    record.deceasedAcquisitionDate ?? null,
      inheritedFromMainResidence: record.inheritedFromMainResidence ?? false,
      taxFreeComponent:           null,
      taxableComponent:           null,
      relationship:               bequest.relationship ?? 'immediate',
      decedentState:              bequest.decedentState ?? null,
      paidViaEstate:              bequest.paidViaEstate ?? false,
    };
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
