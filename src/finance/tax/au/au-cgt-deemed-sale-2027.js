/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * The 1 July 2027 deemed sale and reacquisition (design 132; ITAA 1997 Subdiv 112-E).
 *
 * An individual who acquired a CGT asset before 1 July 2027 and still holds it then is
 * taken to have sold it just before 1 July 2027 at market value and reacquired it for the
 * same amount (s112-155(2)–(3)). The gain on that deemed sale is deferred to the real
 * disposal (s112-160), where it is a discount capital gain at 50% (s115-100(aa)) if the
 * asset was held 12 months from its ORIGINAL acquisition (s112-160(3)(c)), and it is
 * neither indexed (s110-36(1A) Note 4) nor subject to the 30% minimum tax (s119-5(2),
 * s102-6(3)–(5)). Only the gain after 1 July 2027 takes the new regime.
 *
 * The stamp keeps the pre-2027 AU cost base under `costBaseByCountry[AU_PRE2027_KEY]` and
 * makes the market value the lot's AU base, indexed from the July 2027 CPI level. Every
 * lot-splitting, merging and scaling path already carries every key of
 * `costBaseByCountry`, so the deferred gain travels with the units without new code.
 */

import { Reducer, PRIORITY } from '../../../simulation-framework/reducers.js';
import { ACCOUNT_TYPE }      from '../../assets/account.js';
import { ALLOCATION }        from '../../holdings/allocation.js';
import { resolveAttributionFractions } from '../../ownership-utils.js';
import { primaryPersonKey }  from '../../residency-utils.js';

import { AU_DEEMED_SALE_MS, AU_PRE2027_KEY, auAcquisitionMs as _auAcquisitionMs, scalarDeferredGainFields }
  from './au-cgt-2027-constants.js';

export { AU_DEEMED_SALE_MS, AU_PRE2027_KEY, scalarDeferredGainFields };

/**
 * Whether s112-155 reaches this lot: a non-cash lot, not already stamped, acquired (for AU
 * purposes) before 1 July 2027. A lot with no date at all is a seed lot of unknown age and
 * is treated as held before the date — the scenario authored it as already owned.
 */
export function isDeemedSaleLot(h) {
  if (!h || h.allocation === ALLOCATION.CASH) return false;
  if (!((h.marketValue ?? 0) > 0)) return false;
  if (h.costBaseByCountry?.[AU_PRE2027_KEY] != null) return false;
  const acq = _auAcquisitionMs(h);
  return acq == null || acq < AU_DEEMED_SALE_MS;
}

/**
 * The stamped lot. `costBaseByCountry.AU` falls back to `costBasis` exactly as the FIFO
 * does for an un-stepped-up lot, so the pre-2027 base is the one the old regime would
 * have measured the gain from.
 */
export function stampDeemedSale(h, auLevel) {
  const preBase = h.costBaseByCountry?.AU ?? h.costBasis ?? 0;
  return {
    ...h,
    costBaseByCountry: {
      ...(h.costBaseByCountry ?? {}),
      [AU_PRE2027_KEY]: +(+preBase).toFixed(2),
      AU: +(h.marketValue ?? 0).toFixed(2),
    },
    acquisitionPriceLevel: auLevel,
  };
}

/**
 * The scalar CGT assets (design 132 phase 2a): a standalone collectible (bullion or a
 * true collectable — s112-155 reaches every non-pre-CGT asset) and a company stake.
 * Real property is phase 2b, because its deemed sale has to split the main-residence
 * days at 30 June 2027 (s102-6(4)).
 */
const SCALAR_KINDS = new Set(['collectible', 'company']);

/** Whether s112-155 reaches this scalar asset (same tests as a lot, on `value`). */
export function isDeemedSaleScalar(a) {
  if (!a || !SCALAR_KINDS.has(a.kind)) return false;
  if (!((a.value ?? 0) > 0)) return false;
  if (a.costBaseByCountry?.[AU_PRE2027_KEY] != null) return false;
  const acq = _auAcquisitionMs(a);
  return acq == null || acq < AU_DEEMED_SALE_MS;
}

/** The stamped scalar asset: the same three changes as a lot, measured on `value`. */
export function stampDeemedSaleScalar(a, auLevel) {
  const preBase = a.costBaseByCountry?.AU ?? a.costBasis ?? 0;
  return {
    ...a,
    costBaseByCountry: {
      ...(a.costBaseByCountry ?? {}),
      [AU_PRE2027_KEY]: +(+preBase).toFixed(2),
      AU: +(a.value ?? 0).toFixed(2),
    },
    acquisitionPriceLevel: auLevel,
  };
}

/** Whether an AU-resident individual owns the account (any owner, by attribution). */
function _ownedByAuResident(state, key) {
  const fractions = resolveAttributionFractions(state, { stateKey: key }, key);
  if (fractions != null && fractions.length > 0) {
    return fractions.some(({ personKey, fraction }) =>
      fraction > 0 && state.people?.[personKey]?.residency === 'AU');
  }
  const primary = primaryPersonKey(state);
  return primary != null && state.people?.[primary]?.residency === 'AU';
}

export class AuCgtDeemedSale2027Reducer extends Reducer {
  static type        = 'AuCgtDeemedSale2027Reducer';
  static description = 'On the AU period advance that opens FY2027 (1 July 2027), stamps every brokerage lot, standalone collectible and company stake an AU resident acquired before that date with the s112-155 deemed sale and reacquisition: the pre-2027 AU cost base is kept for the deferred gain, the market value becomes the AU cost base, and indexation starts at the July 2027 CPI level (design 132).';
  static actionType  = null;

  constructor() {
    // After InflationAdjustReducer (PRE_PROCESS + 2), which advances `cpiAccumulator`.
    super('AU CGT Deemed Sale 2027', PRIORITY.PRE_PROCESS + 3);
    this.reducedActionTypes = ['AU_PERIOD_ADVANCE'];
  }

  reduce(state, action) {
    if (action?.period?.startMs !== AU_DEEMED_SALE_MS) return this.newState(state);
    const auLevel = state.cpiAccumulator?.AU ?? state.inflationAccumulator?.AU ?? 1;
    const patch = {};
    for (const [key, a] of Object.entries(state)) {
      if (isDeemedSaleScalar(a)) {
        if (_ownedByAuResident(state, key)) patch[key] = stampDeemedSaleScalar(a, auLevel);
        continue;
      }
      if (a?.type !== ACCOUNT_TYPE.BROKERAGE || !Array.isArray(a.holdings)) continue;
      if (!a.holdings.some(isDeemedSaleLot)) continue;
      if (!_ownedByAuResident(state, key)) continue;
      patch[key] = { ...a, holdings: a.holdings.map(h => isDeemedSaleLot(h) ? stampDeemedSale(h, auLevel) : h) };
    }
    return this.newState(state, patch);
  }
}
