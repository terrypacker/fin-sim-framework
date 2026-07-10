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
 * ALLOCATION — the asset category a Holding represents.
 *
 * Drives rateKey resolution (see default-allocations.js#resolveRateKey) so a
 * Holding inherits its regime-adjusted return from state.effectiveGrowthRates,
 * and gates behavioral / rebalance handlers that act on a specific class
 * (EQUITY panic-sell, BOND duration-revalue, etc. — see design 28 / 29).
 */
export const ALLOCATION = Object.freeze({
  EQUITY: 'EQUITY',
  BOND:   'BOND',
  CASH:   'CASH',
  GOLD:   'GOLD',
  OTHER:  'OTHER',
});

/** Tuple of every legal ALLOCATION value — useful for schema validation. */
export const ALLOCATION_VALUES = Object.freeze(Object.values(ALLOCATION));

/**
 * Allocations whose disposal is taxed as a **collectible** (design 56 §7.2):
 * GOLD is a commodity holding that carries the US 28% collectibles CGT rate (and
 * AU ordinary CGT when resident). The disposal reducer and the after-tax metric
 * branch on this set rather than a separately-stored `taxClass` field — the
 * allocation is the single, unambiguous signal (GOLD is the only collectible
 * holding today) and can never drift from a redundant tag.
 */
export const COLLECTIBLE_ALLOCATIONS = Object.freeze(new Set([ALLOCATION.GOLD]));

/** True when a holding's ALLOCATION disposes as a collectible (US 28% CGT). */
export function isCollectibleAllocation(allocation) {
  return COLLECTIBLE_ALLOCATIONS.has(allocation);
}
