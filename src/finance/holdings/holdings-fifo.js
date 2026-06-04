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
 * @param {Array}  holdings - account.holdings (not mutated)
 * @param {number} amount   - market-value dollars to consume; must be > 0
 * @returns {{ realizedBasis: number, newHoldings: Array, consumed: number }}
 *   `consumed` may be less than `amount` if the holdings total less.
 */
export function consumeHoldingsFifo(holdings, amount) {
  if (!Array.isArray(holdings) || holdings.length === 0 || amount <= 0) {
    return { realizedBasis: 0, newHoldings: holdings ?? [], consumed: 0 };
  }
  const sorted = [...holdings].sort((a, b) => _purchaseTs(a) - _purchaseTs(b));
  let remaining     = amount;
  let realizedBasis = 0;
  let consumed      = 0;
  const newHoldings = [];

  for (const h of sorted) {
    if (!h) continue;
    const mv = h.marketValue ?? 0;
    if (remaining <= 0 || mv <= 0) {
      if (mv > 0) newHoldings.push(h);
      continue;
    }
    const take = Math.min(remaining, mv);
    const basisShare = (h.costBasis ?? 0) * (take / mv);
    realizedBasis += basisShare;
    consumed      += take;
    remaining     -= take;
    const remainingMv = mv - take;
    if (remainingMv > 0.001) {
      newHoldings.push({
        ...h,
        marketValue: +remainingMv.toFixed(2),
        costBasis:   +((h.costBasis ?? 0) - basisShare).toFixed(2),
      });
    }
    // If fully consumed (remainingMv ≈ 0), the holding is dropped.
  }
  return {
    realizedBasis: +realizedBasis.toFixed(2),
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
