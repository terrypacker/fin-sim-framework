/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { ALLOCATION, isCollectibleAllocation } from './allocation.js';
import { buildHoldingsComparator } from './holdings-selection.js';

/**
 * Consume an account's holdings to satisfy a sale of `amount` dollars at
 * marketValue. Returns the realized cost basis and the new holdings array (with
 * consumed positions removed or reduced).
 *
 * Sort order (design 65): a pluggable **selection policy** decides which lots to
 * consume. When `selection` is null the lots are walked in ascending purchaseDate
 * order (FIFO) — byte-identical to the historic behavior — so every caller that
 * omits `selection` (and the golden) is unaffected. When a `selection` is supplied
 * the primitive walks the sleeve order (Lever A/C) then the lot strategy (Lever B),
 * with a purchaseDate tie-break; see holdings-selection.js. Every tally below is
 * computed from *whichever* lots are consumed, so the tax chain downstream is
 * untouched — only *which* lots get sold changes.
 *
 * Holdings with null purchaseDate sort first under FIFO (treated as oldest —
 * "carried in from scenario boot").
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
 * CGT 50%-discount split (design 62 §4): when an `indexation` (AU CGT) context is
 * supplied, `realizedDiscountableGainByCountry[country]` tallies the realized gain
 * from EQUITY/BOND lots held ≥12 months measured from the country's deemed-acquisition
 * date (`acquisitionDateByCountry[country]`, stamped at the resident's move) — falling
 * back to `purchaseDate` for lots never stepped up. The pre-2027 rates module discounts
 * only this portion; lots sold within 12 months of the move are excluded (the ATO clock
 * restarts at residency). `{}` when no indexation context is passed. `level` is optional
 * here: a caller that only needs the discount split (not indexation) may pass
 * `{ asOfMs, country }` with no `level` — the index factor then stays 1.
 *
 * @param {Object}  [opts={}]
 * @param {{ level?: number, asOfMs: number, country: string }|null} [opts.indexation=null]
 * @param {{ sleeveOrder?: string[], sleeveWeights?: Object<string,number>, sleeveScore?: Function, lotStrategy?: string }|null} [opts.selection=null]
 *   The design-65 selection policy; null ⇒ FIFO (identical to the historic behavior).
 * @returns {{ realizedBasis: number, realizedBasisByCountry: Object<string,number>, realizedIndexedBasisByCountry: Object<string,number>, realizedDiscountableGainByCountry: Object<string,number>, collectibleProceeds: number, collectibleBasis: number, collectibleBasisByCountry: Object<string,number>, collectibleIndexedBasisByCountry: Object<string,number>, newHoldings: Array, consumed: number }}
 *   `consumed` may be less than `amount` if the holdings total less.
 */
const TWELVE_MONTHS_MS = 365 * 24 * 60 * 60 * 1000;

export function consumeHoldings(holdings, amount, { indexation = null, selection = null } = {}) {
  if (!Array.isArray(holdings) || holdings.length === 0 || amount <= 0) {
    return { realizedBasis: 0, realizedBasisByCountry: {}, realizedIndexedBasisByCountry: {}, realizedDiscountableGainByCountry: {}, collectibleProceeds: 0, collectibleBasis: 0, collectibleBasisByCountry: {}, collectibleIndexedBasisByCountry: {}, newHoldings: holdings ?? [], consumed: 0 };
  }
  // Union of step-up countries present across the lots, so the per-country tally
  // covers every country even when only some lots were stepped up.
  const countries = new Set();
  for (const h of holdings) {
    if (h?.costBaseByCountry) for (const c of Object.keys(h.costBaseByCountry)) countries.add(c);
  }
  const sorted = [...holdings].sort(buildHoldingsComparator(selection));
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
  // CGT 50%-discount eligibility (design 62 §4): the portion of the realized gain
  // from lots held ≥12 months measured from the country's deemed-acquisition date.
  const realizedDiscountableGainByCountry = idxCountry ? { [idxCountry]: 0 } : {};
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
    // Design 87 §11 — CASH realizes NO capital gain. A unit of currency is disposed of
    // for exactly its face, so its basis equals its proceeds by definition; there is no
    // price to have moved. `rebalance-to-target-apply-reducer` has always known this
    // (`taxable && allocation !== ALLOCATION.CASH`), but this path — the brokerage
    // DRAWDOWN path — did not, so the same sleeve booked a phantom gain when it was
    // drawn instead of rebalanced. Whatever `costBasis` a CASH lot happens to carry is
    // meaningless for gain purposes; the §988 currency basis is a RATE and lives in
    // `fxBasisRate`, which is the whole point of design 87.
    const isCash     = h.allocation === ALLOCATION.CASH;
    const basisShare = isCash ? take : (h.costBasis ?? 0) * fraction;
    realizedBasis += basisShare;
    if (isCollectibleAllocation(h.allocation)) {
      collectibleProceeds += take;
      collectibleBasis    += basisShare;
    }
    for (const c of countries) {
      const cb = h.costBaseByCountry?.[c] ?? (h.costBasis ?? 0);
      realizedBasisByCountry[c] += isCash ? take : cb * fraction;
    }
    if (idxCountry) {
      const cb        = h.costBaseByCountry?.[idxCountry] ?? (h.costBasis ?? 0);
      const lotLevel  = h.acquisitionPriceLevel;
      // The ≥12-month CGT clock runs from the country's DEEMED-acquisition date when
      // the lot was stepped up on the resident's move (design 62 §4) — the ATO restarts
      // the clock at the residency date, not the original purchase. Falls back to the
      // purchase date for lots never stepped up.
      const acqTs     = h.acquisitionDateByCountry?.[idxCountry] ?? _purchaseTs(h);
      const held12mo  = (indexation.asOfMs - acqTs) >= TWELVE_MONTHS_MS;
      // CPI index factor ≥ 1 (indexation only ratchets the basis up; never a loss).
      const factor    = (held12mo && lotLevel != null && lotLevel > 0 && indexation.level > 0)
        ? Math.max(1, indexation.level / lotLevel)
        : 1;
      // Cash is never indexed either: ratcheting a currency balance's basis up would
      // manufacture a capital LOSS out of inflation on money that cannot have one.
      const idxBasisShare = isCash ? take : cb * fraction;
      realizedIndexedBasisByCountry[idxCountry] += isCash ? take : idxBasisShare * factor;
      // Discountable gain (design 62 §4): EQUITY/BOND (non-collectible) lots held
      // ≥12mo from the deemed-acquisition date are eligible for the pre-2027 Division
      // 115 50% discount. Sum each such lot's per-lot floored AU gain (proceeds share
      // − AU basis share). The rates module discounts only this portion. Collectibles/
      // gold are excluded (gold is indexed, not discounted, under the reform).
      if (held12mo && !isCollectibleAllocation(h.allocation)) {
        realizedDiscountableGainByCountry[idxCountry] += Math.max(0, take - idxBasisShare);
      }
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
        // A CASH remainder re-asserts the invariant rather than subtracting: a stale
        // basis minus full proceeds would otherwise leave a NEGATIVE basis behind.
        costBasis:   isCash ? +remainingMv.toFixed(2)
                            : +((h.costBasis ?? 0) - basisShare).toFixed(2),
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
    realizedDiscountableGainByCountry[idxCountry] = +realizedDiscountableGainByCountry[idxCountry].toFixed(2);
    collectibleBasisByCountry[idxCountry]        = +collectibleBasisByCountry[idxCountry].toFixed(2);
    collectibleIndexedBasisByCountry[idxCountry] = +collectibleIndexedBasisByCountry[idxCountry].toFixed(2);
  }
  return {
    realizedBasis: +realizedBasis.toFixed(2),
    realizedBasisByCountry,
    realizedIndexedBasisByCountry,
    realizedDiscountableGainByCountry,
    collectibleProceeds: +collectibleProceeds.toFixed(2),
    collectibleBasis:    +collectibleBasis.toFixed(2),
    collectibleBasisByCountry,
    collectibleIndexedBasisByCountry,
    newHoldings,
    consumed:      +consumed.toFixed(2),
  };
}

/**
 * FIFO consumption — the historic entry point, now a thin wrapper over
 * `consumeHoldings` with no selection policy (⇒ purchaseDate ascending). Kept so
 * every existing caller (engine drawdown, event withdrawals, design-61 rebalance,
 * inheritance, residency cost-base) is byte-identical until it opts into a policy.
 *
 * @param {Array}  holdings
 * @param {number} amount
 * @param {{ level?: number, asOfMs: number, country: string }|null} [indexation=null]
 */
export function consumeHoldingsFifo(holdings, amount, indexation = null) {
  return consumeHoldings(holdings, amount, { indexation });
}

function _purchaseTs(h) {
  if (!h?.purchaseDate) return 0;
  const t = h.purchaseDate instanceof Date
    ? h.purchaseDate.getTime()
    : new Date(h.purchaseDate).getTime();
  return Number.isNaN(t) ? 0 : t;
}
