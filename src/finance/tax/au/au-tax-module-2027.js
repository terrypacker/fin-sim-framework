/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { AuTaxModule2026 } from './au-tax-module-2026.js';
import { accumulateByOwnership } from '../../ownership-utils.js';
import { toAUD } from '../tax-fx.js';

/**
 * AuTaxModule2027 — AU tax classification for FY starting July 2027.
 *
 * Identical to AuTaxModule2026 except that resident capital-gains events also
 * record the *real (post-indexation) gain* into a new bucket,
 * auRealCapitalGainsYTD (per-person: auPersonRealCapitalGainsYTD), which the
 * FY2027 rates module (AuTaxRates2027) taxes with no 50% discount and a 30%
 * minimum-tax floor (design 57 §6.3/§6.5).
 *
 * The parent's buckets are left intact — auCapitalGainsYTD keeps holding the
 * *gross* gain (used for gross-income / effective-rate display), while the new
 * bucket carries the indexed gain that is actually assessed. US capital gains
 * and FTC classification are unchanged (US does not index).
 *
 *   Stock: uses action.auIndexedGain (design 57 §6.3, computed per-lot in the AU
 *          brokerage sale reducer). Until the 1 Jul 2027 deemed reset (§6.4)
 *          stamps acquisition price levels, auIndexedGain === auGain.
 *   House: property indexation is deferred (§6.4); the raw gain is used, so the
 *          reform's discount removal + 30% floor still apply to house sales.
 *
 * Cross-border (US-source) resident capital gains matter just as much: an AU
 * resident's US-brokerage sales, company-equity sales, and gold/collectible sales
 * are assessed by AU on the worldwide basis (relieved by FITO). Those flow through
 * the *US* module's action types (STOCK_WITHDRAWAL_TAX / COMPANY_SALE_TAX /
 * COLLECTIBLE_SALE_TAX), which stamp the gross auCapitalGainsYTD but know nothing
 * of the reform's real bucket. We register ADDITIVE AU reducers for those same
 * action types — DynamicTaxReducer registers one reducer per (country, action-type),
 * so the US and AU reducers both run — recording the AUD real (indexed) gain into
 * auRealCapitalGainsYTD in lockstep. Without this, the real bucket stays a present
 * zero and AuTaxRates2027 would grant a spurious 100% CGT relief (design 57 Bug 2).
 * These gains are US-source and land in the shared bucket (no per-person split),
 * mirroring the US module's shared auCapitalGainsYTD stamping.
 */
export class AuTaxModule2027 extends AuTaxModule2026 {
  get year() { return 2027; }

  getReducerFns() {
    const fns = super.getReducerFns();

    const baseStock = fns.get('AU_STOCK_WITHDRAWAL_TAX');
    fns.set('AU_STOCK_WITHDRAWAL_TAX', (state, action) => {
      const next = baseStock(state, action);
      if (action.residency !== 'AU') return next;   // real bucket for residents only
      const realGain = action.auIndexedGain ?? action.auGain ?? action.gain ?? 0;
      return this._recordRealGain(next, state, realGain, state.auStockAccount);
    });

    const baseHouse = fns.get('AU_HOUSE_SALE_TAX');
    fns.set('AU_HOUSE_SALE_TAX', (state, action) => {
      const next = baseHouse(state, action);
      if (action.residency !== 'AU') return next;
      // Property cost-base indexation is deferred (design 57 §6.4) — use the raw gain.
      const realGain = action.auIndexedGain ?? action.gain ?? 0;
      const asset = { ownershipType: action.ownershipType, ownerId: action.ownerId, owners: action.owners };
      return this._recordRealGain(next, state, realGain, asset);
    });

    // ── Cross-border (US-source) resident capital gains ──────────────────────
    // These three are ALL US-source, so besides the worldwide real bucket they
    // also feed usSourceRealCapGainsAudYTD — the FY2027 FITO "without" pass reduces
    // the real bucket by this to size the CG slice of the FITO limit (design 57
    // Part 2, Item D). AU-native AU_STOCK/AU_HOUSE above are AU-source ⇒ excluded.
    //
    // US brokerage stock: indexed AU gain (deemed acquisition = residency date,
    // design 57 §6.3), stepped-up auGain, else the US gain — converted to AUD.
    fns.set('STOCK_WITHDRAWAL_TAX', (state, action) => {
      if (action.residency !== 'AU') return state;
      const realGainUsd = action.auIndexedGain ?? action.auGain ?? action.gain ?? 0;
      const realGainAud = toAUD(realGainUsd, 'USD', state);
      return this._recordUsSourceRealGain(this._recordRealGain(state, state, realGainAud, null), realGainAud);
    });

    // Company equity: no AU cost-base step-up / indexation — the full US gain is
    // the real gain (design 57 §6.4 "company → full gain").
    fns.set('COMPANY_SALE_TAX', (state, action) => {
      if (action.residency !== 'AU') return state;
      const realGainAud = toAUD(action.gain ?? 0, 'USD', state);
      return this._recordUsSourceRealGain(this._recordRealGain(state, state, realGainAud, null), realGainAud);
    });

    // US house (foreign real property, design 62 §5): AU-assessable for a resident
    // from the stepped-up basis net of the main-residence exemption. Indexation is
    // deferred for property (design 57 §6.4), so the real gain is the un-indexed
    // auGain — matching the AU_HOUSE_SALE_TAX treatment.
    fns.set('US_HOUSE_SALE_TAX', (state, action) => {
      if (action.residency !== 'AU') return state;
      const realGainAud = toAUD(action.auGain ?? 0, 'USD', state);
      return this._recordUsSourceRealGain(this._recordRealGain(state, state, realGainAud, null), realGainAud);
    });

    // Collectibles: bullion (isGold) is an ordinary AU CGT asset → indexed like
    // equity; true collectibles are NOT indexed under the reform (design 57 §6.4).
    fns.set('COLLECTIBLE_SALE_TAX', (state, action) => {
      if (action.residency !== 'AU') return state;
      const realGainUsd = action.isGold
        ? (action.auIndexedGain ?? action.auGain ?? action.gain ?? 0)
        : (action.auGain ?? action.gain ?? 0);
      const realGainAud = toAUD(realGainUsd, 'USD', state);
      return this._recordUsSourceRealGain(this._recordRealGain(state, state, realGainAud, null), realGainAud);
    });

    return fns;
  }

  /**
   * Track the US-source slice of the real (indexed) AU capital gain (AUD). Feeds
   * the FY2027 FITO "without US-source" pass so the CG component of the FITO limit
   * tracks the *real* gain the reform assesses (design 57 Part 2, Item D). Shared
   * household scalar — split per-person at settle like usSourceCapGainsAudYTD.
   */
  _recordUsSourceRealGain(next, realGainAud) {
    return { ...next, usSourceRealCapGainsAudYTD: (next.usSourceRealCapGainsAudYTD ?? 0) + realGainAud };
  }

  /**
   * Add a real (post-indexation) capital gain into auRealCapitalGainsYTD, keyed
   * per-person by ownership when state.people is populated (mirrors the parent's
   * auCapitalGainsYTD handling so the two buckets slice identically).
   */
  _recordRealGain(next, refState, realGain, asset) {
    const perPerson = refState.people != null && asset != null;
    if (perPerson) {
      return {
        ...next,
        auPersonRealCapitalGainsYTD: accumulateByOwnership(
          next.auPersonRealCapitalGainsYTD ?? {}, asset, realGain, refState.people),
      };
    }
    return { ...next, auRealCapitalGainsYTD: (next.auRealCapitalGainsYTD ?? 0) + realGain };
  }
}
