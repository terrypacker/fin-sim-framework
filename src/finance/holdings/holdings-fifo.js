/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { isCollectibleAllocation } from './allocation.js';

/**
 * FIFO consumption of an account's holdings to satisfy a sale of `amount`
 * dollars at marketValue. Returns the realized cost basis and the new
 * holdings array (with consumed positions removed or reduced).
 *
 * Sort order: ascending purchaseDate (FIFO). Holdings with null purchaseDate
 * sort first (treated as oldest — "carried in from scenario boot").
 *
 * Each holding's basis share is computed pro-rata against its own
 * (consumed / marketValue) × costBasis. This matches the realized-gain
 * convention used by US/AU brokerage tax modules.
 *
 * Per-country cost bases (design 36 §12.2): when a lot carries a
 * `costBaseByCountry` map (a jurisdiction stepped up its basis on the resident's
 * move), the realized basis is also tallied per country into
 * `realizedBasisByCountry`. A lot with no entry for a country falls back to its
 * universal `costBasis`, so the per-country tally is complete across mixed lots.
 *
 * Collectible split (design 56 §7.2): the proceeds and realized basis attributable
 * to consumed **collectible** lots (`isCollectibleAllocation` — GOLD) are tallied
 * separately into `collectibleProceeds` / `collectibleBasis`, so the caller (the US
 * brokerage disposal reducer) can route the gold portion of the gain through the 28%
 * collectibles-CGT path while the rest keeps ordinary brokerage CGT. Both are 0 when
 * no consumed lot is collectible, so non-gold callers are unaffected.
 *
 * CGT cost-base indexation (design 57 §6.3): when `indexation = { level, asOfMs,
 * country }` is supplied, the realized cost base for that country is ALSO tallied
 * with each lot's basis scaled by a per-lot CPI index factor
 * `max(1, level / lot.acquisitionPriceLevel)`, but only for lots held at least 12
 * months (`asOfMs − purchaseDate`). Lots with no `acquisitionPriceLevel` (or held
 * <12 months) index at factor 1, so `realizedIndexedBasisByCountry[country]` then
 * equals the un-indexed `realizedBasisByCountry[country]`. The result is `{}` when
 * no indexation context is passed, so non-AU / pre-2027 callers are unaffected.
 *
 * @param {Array}  holdings - account.holdings (not mutated)
 * @param {number} amount   - market-value dollars to consume; must be > 0
 * Collectible per-country / indexed basis (design 57 §6.3, gold): when an
 * `indexation` context is supplied, the collectible (GOLD) slice's realized basis
 * is ALSO tallied for the reform country — both un-indexed (`collectibleBasisByCountry`)
 * and indexed (`collectibleIndexedBasisByCountry`) — so a cross-border caller can
 * measure the gold portion's AU gain from its stepped-up, CPI-indexed cost base
 * while true (non-gold) collectibles stay un-indexed. Both are `{}` when no
 * indexation context is passed.
 *
 * @param {{ level: number, asOfMs: number, country: string }|null} [indexation=null]
 * @returns {{ realizedBasis: number, realizedBasisByCountry: Object<string,number>, realizedIndexedBasisByCountry: Object<string,number>, collectibleProceeds: number, collectibleBasis: number, collectibleBasisByCountry: Object<string,number>, collectibleIndexedBasisByCountry: Object<string,number>, newHoldings: Array, consumed: number }}
 *   `consumed` may be less than `amount` if the holdings total less.
 */
const TWELVE_MONTHS_MS = 365 * 24 * 60 * 60 * 1000;

export function consumeHoldingsFifo(holdings, amount, indexation = null) {
  if (!Array.isArray(holdings) || holdings.length === 0 || amount <= 0) {
    return { realizedBasis: 0, realizedBasisByCountry: {}, realizedIndexedBasisByCountry: {}, collectibleProceeds: 0, collectibleBasis: 0, collectibleBasisByCountry: {}, collectibleIndexedBasisByCountry: {}, newHoldings: holdings ?? [], consumed: 0 };
  }
  // Union of step-up countries present across the lots, so the per-country tally
  // covers every country even when only some lots were stepped up.
  const countries = new Set();
  for (const h of holdings) {
    if (h?.costBaseByCountry) for (const c of Object.keys(h.costBaseByCountry)) countries.add(c);
  }
  const sorted = [...holdings].sort((a, b) => _purchaseTs(a) - _purchaseTs(b));
  let remaining     = amount;
  let realizedBasis = 0;
  let consumed      = 0;
  let collectibleProceeds = 0;
  let collectibleBasis    = 0;
  const realizedBasisByCountry = {};
  for (const c of countries) realizedBasisByCountry[c] = 0;
  // Indexed cost base for the reform country (design 57): tallied only when an
  // indexation context is supplied. Seed the country key so it is present even if
  // no lot carries a per-country override.
  const idxCountry = indexation?.country ?? null;
  const realizedIndexedBasisByCountry = idxCountry ? { [idxCountry]: 0 } : {};
  // Collectible (gold) slice tallies for the reform country — un-indexed and indexed.
  const collectibleBasisByCountry        = idxCountry ? { [idxCountry]: 0 } : {};
  const collectibleIndexedBasisByCountry = idxCountry ? { [idxCountry]: 0 } : {};
  const newHoldings = [];

  for (const h of sorted) {
    if (!h) continue;
    const mv = h.marketValue ?? 0;
    if (remaining <= 0 || mv <= 0) {
      if (mv > 0) newHoldings.push(h);
      continue;
    }
    const take = Math.min(remaining, mv);
    const fraction   = take / mv;
    const basisShare = (h.costBasis ?? 0) * fraction;
    realizedBasis += basisShare;
    if (isCollectibleAllocation(h.allocation)) {
      collectibleProceeds += take;
      collectibleBasis    += basisShare;
    }
    for (const c of countries) {
      const cb = h.costBaseByCountry?.[c] ?? (h.costBasis ?? 0);
      realizedBasisByCountry[c] += cb * fraction;
    }
    if (idxCountry) {
      const cb        = h.costBaseByCountry?.[idxCountry] ?? (h.costBasis ?? 0);
      const lotLevel  = h.acquisitionPriceLevel;
      const held12mo  = (indexation.asOfMs - _purchaseTs(h)) >= TWELVE_MONTHS_MS;
      // CPI index factor ≥ 1 (indexation only ratchets the basis up; never a loss).
      const factor    = (held12mo && lotLevel != null && lotLevel > 0 && indexation.level > 0)
        ? Math.max(1, indexation.level / lotLevel)
        : 1;
      const idxBasisShare = cb * fraction;
      realizedIndexedBasisByCountry[idxCountry] += idxBasisShare * factor;
      // Split the gold (collectible) slice out so the caller can index gold while
      // leaving equity's own indexed basis intact (both already counted above).
      if (isCollectibleAllocation(h.allocation)) {
        collectibleBasisByCountry[idxCountry]        += idxBasisShare;
        collectibleIndexedBasisByCountry[idxCountry] += idxBasisShare * factor;
      }
    }
    consumed      += take;
    remaining     -= take;
    const remainingMv = mv - take;
    if (remainingMv > 0.001) {
      const partial = {
        ...h,
        marketValue: +remainingMv.toFixed(2),
        costBasis:   +((h.costBasis ?? 0) - basisShare).toFixed(2),
      };
      // Deplete each per-country cost base by the same consumed fraction.
      if (h.costBaseByCountry) {
        partial.costBaseByCountry = {};
        for (const c of Object.keys(h.costBaseByCountry)) {
          partial.costBaseByCountry[c] = +(h.costBaseByCountry[c] * (remainingMv / mv)).toFixed(2);
        }
      }
      newHoldings.push(partial);
    }
    // If fully consumed (remainingMv ≈ 0), the holding is dropped.
  }
  for (const c of countries) realizedBasisByCountry[c] = +realizedBasisByCountry[c].toFixed(2);
  if (idxCountry) {
    realizedIndexedBasisByCountry[idxCountry]    = +realizedIndexedBasisByCountry[idxCountry].toFixed(2);
    collectibleBasisByCountry[idxCountry]        = +collectibleBasisByCountry[idxCountry].toFixed(2);
    collectibleIndexedBasisByCountry[idxCountry] = +collectibleIndexedBasisByCountry[idxCountry].toFixed(2);
  }
  return {
    realizedBasis: +realizedBasis.toFixed(2),
    realizedBasisByCountry,
    realizedIndexedBasisByCountry,
    collectibleProceeds: +collectibleProceeds.toFixed(2),
    collectibleBasis:    +collectibleBasis.toFixed(2),
    collectibleBasisByCountry,
    collectibleIndexedBasisByCountry,
    newHoldings,
    consumed:      +consumed.toFixed(2),
  };
}

function _purchaseTs(h) {
  if (!h?.purchaseDate) return 0;
  const t = h.purchaseDate instanceof Date
    ? h.purchaseDate.getTime()
    : new Date(h.purchaseDate).getTime();
  return Number.isNaN(t) ? 0 : t;
}
