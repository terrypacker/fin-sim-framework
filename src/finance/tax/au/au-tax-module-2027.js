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
import { accumulateByOwnership, resolveAttributionAsset, resolveAttributionFractions } from '../../ownership-utils.js';
import { toAUD } from '../tax-fx.js';
import { signedAuCapitalGain, auRealCapitalGain } from '../capital-gain-character.js';

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
 *          brokerage sale reducer). A lot with no acquisition price level and no
 *          purchase date cannot be indexed, and auIndexedGain === auGain.
 *   House: also uses action.auIndexedGain — the indexed, post-s118-185 assessable
 *          gain, computed in the AU/US real-property sale reducers (design 57
 *          §6.3). Property used to book its RAW gain here, taking the reform's
 *          discount removal and 30% floor without the cost-base indexation that is
 *          supposed to pay for them; see the AU_HOUSE_SALE_TAX reducer below.
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
      const realGain = this._realGain(action, action.auGain ?? action.gain ?? 0);
      // Design 76 Gap C: resolve the same account the parent's gross-bucket path
      // resolved, so the real bucket slices identically (see _recordRealGain).
      return this._recordRealGain(next, state, realGain, resolveAttributionAsset(state, action, 'auStockAccount'));
    });

    const baseHouse = fns.get('AU_HOUSE_SALE_TAX');
    fns.set('AU_HOUSE_SALE_TAX', (state, action) => {
      const next = baseHouse(state, action);
      if (action.residency !== 'AU') return next;
      // This bucket is what `AuTaxRates2027._cgtRelief` actually taxes, so it must take
      // the ASSESSABLE gain. Booking the raw `action.gain` here discarded the s118-185
      // main-residence exemption the parent reducer had just computed: the return printed
      // the exemption on its "Capital Gains" line and taxed 100% of the gain on the next.
      // Measured on a dwelling with an 11.77% exemption, that was A$116,508 of phantom
      // assessable income — ~A$54,759 of tax. The exemption was zero on every scenario in
      // the suite (the sale-date day-count bug was forcing `auTaxableFraction` to 1),
      // which is why nothing caught it.
      //
      // `auIndexedGain` is now that same assessable figure measured from the CPI-indexed
      // cost base (design 57 §6.3). It was absent for years — §10 said "property
      // indexation deferred to §6.4", meaning the Phase-4 deemed-reset work would deliver
      // it, and Part 2 Item B then deleted the deemed reset without revisiting property.
      // The fallback stays for a replayed action emitted before the field existed.
      const realGain = auRealCapitalGain(
        AuTaxModule2026.auAssessableHouseGain(action), action.auIndexedGain);
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
      const realGainUsd = this._realGain(action, action.auGain ?? action.gain ?? 0);
      const realGainAud = toAUD(realGainUsd, 'USD', state);
      return this._recordUsSourceReal(state, action, 'usStockAccount', realGainAud);
    });

    // Company equity: AU-assessable from the s855-45 stepped-up basis and indexed
    // from the move-date price level (design 72 §3), matching the equity/gold path.
    // Supersedes design 57 §6.4's "company → full gain", which pre-dated company
    // equity receiving a residency step-up at all. Falls back to the full US gain
    // when no step-up was stamped (pre-move sale, or no move in the scenario).
    fns.set('COMPANY_SALE_TAX', (state, action) => {
      if (action.residency !== 'AU') return state;
      const realGainUsd = this._realGain(action, action.auGain ?? action.gain ?? 0);
      const realGainAud = toAUD(realGainUsd, 'USD', state);
      return this._recordUsSourceReal(state, action, null, realGainAud);
    });

    // US house (foreign real property, design 62 §5): AU-assessable for a resident
    // from the stepped-up basis net of the main-residence exemption, and — like every
    // other AU CGT asset under the reform — indexed from the deemed-acquisition price
    // level stamped at the move (design 57 §6.3). Matches AU_HOUSE_SALE_TAX.
    fns.set('US_HOUSE_SALE_TAX', (state, action) => {
      if (action.residency !== 'AU') return state;
      const realGainAud = toAUD(this._realGain(action, action.auGain ?? 0), 'USD', state);
      return this._recordUsSourceReal(state, action, null, realGainAud);
    });

    // Collectibles: bullion (isGold) is an ordinary AU CGT asset → indexed like
    // equity; true collectibles are NOT indexed under the reform (design 57 Part 2, Q3).
    fns.set('COLLECTIBLE_SALE_TAX', (state, action) => {
      if (action.residency !== 'AU') return state;
      // A true collectible is not indexed under the reform (Part 2, Q3), so its real
      // amount is simply its nominal one — but it still has to travel through the same
      // s960-275 / slice rules, or a collectible LOSS reaches the two buckets differently.
      const auGainUsd = action.auGain ?? action.gain ?? 0;
      const realGainUsd = this._realGain(action, auGainUsd, action.isGold === true);
      const realGainAud = toAUD(realGainUsd, 'USD', state);
      return this._recordUsSourceReal(state, action, null, realGainAud);
    });

    return fns;
  }

  /**
   * The signed amount this disposal contributes to `auRealCapitalGainsYTD`.
   *
   * The FY2027 real bucket and the nominal `auCapitalGainsYTD` are booked by two
   * different modules from the same action (§6.5), and they are only meaningful as a
   * pair: `_cgtRelief` assesses the real one and prints `nominal − real` as the
   * indexation relief. So the real amount is derived FROM the nominal amount its
   * sibling booked — `signedAuCapitalGain` returns exactly what
   * `characterizeAuCapitalGain`'s caller added — rather than recomputed from the
   * payload a second time. Recomputing is what let them come apart (au-house-sale F5),
   * and `auRealCapitalGain` then applies the two rules that keep them a partition:
   * s960-275 for a loss, and real ≤ nominal for a gain.
   *
   * `AU_HOUSE_SALE_TAX` is the exception that calls `auRealCapitalGain` directly: its
   * nominal side is the s118-185 exemption-applied `auAssessableHouseGain`, not the
   * character split, so it supplies its own nominal.
   *
   * @param {object} action
   * @param {number} auGain    the AU-measured gain, in the action's currency
   * @param {boolean} indexable  false for a true collectible (Part 2, Q3), which the
   *   reform does not index — its real amount is its nominal one
   */
  _realGain(action, auGain, indexable = true) {
    const nominal = signedAuCapitalGain(action, auGain);
    return auRealCapitalGain(nominal, indexable ? action.auIndexedGain : nominal);
  }

  /**
   * Book a US-source real (post-indexation) capital gain for an AU resident, into
   * BOTH the real bucket and its US-source slice, attributed per person.
   *
   * Design 76: these two must be attributed identically, and identically to the
   * gross bucket the parent US module already booked — the FY2027 FITO "without
   * US-source" pass subtracts `usSourceRealCapGainsAudYTD` from `auRealCapitalGainsYTD`
   * to size the CG slice of the limit (design 57 Part 2, Item D). A person holding
   * 100% of the gain but half the US-source slice gets a limit computed off a base
   * they do not have — the same defect measured at +32.8% on the ordinary buckets.
   *
   * These four action types are US-source, so they previously wrote the household
   * scalars unconditionally ("no per-person split", the original comment said). That
   * was left behind by the main Gap B migration and surfaced by design 76 P5's
   * unattributed-residue warning on a real scenario, not by the test suite — the
   * default scenarios have no FY2027+ US-source realisation.
   *
   * @param {object} state         state before this action
   * @param {object} action        the tax action (carries stateKey / owner fields)
   * @param {string|null} canonicalKey  fallback account key for the account-derived case
   * @param {number} realGainAud   the real gain, AUD
   */
  _recordUsSourceReal(state, action, canonicalKey, realGainAud) {
    const fractions = resolveAttributionFractions(state, action, canonicalKey);
    if (fractions == null) {
      return {
        ...state,
        auRealCapitalGainsYTD:      (state.auRealCapitalGainsYTD      ?? 0) + realGainAud,
        usSourceRealCapGainsAudYTD: (state.usSourceRealCapGainsAudYTD ?? 0) + realGainAud,
      };
    }
    const spread = (map) => {
      const out = { ...(map ?? {}) };
      for (const { personKey, fraction } of fractions) {
        out[personKey] = (out[personKey] ?? 0) + realGainAud * fraction;
      }
      return out;
    };
    return {
      ...state,
      auPersonRealCapitalGainsYTD:        spread(state.auPersonRealCapitalGainsYTD),
      auPersonUsSourceRealCapGainsAudYTD: spread(state.auPersonUsSourceRealCapGainsAudYTD),
    };
  }

  /**
   * Add a real (post-indexation) capital gain into the real bucket, keyed per-person
   * by ownership when state.people is populated (mirrors the parent's
   * auCapitalGainsYTD handling so the two buckets slice identically). Used by the
   * AU-native paths, whose gains are AU-source and so feed no US-source slice.
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
