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

    return fns;
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
