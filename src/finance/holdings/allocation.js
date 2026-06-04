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
  OTHER:  'OTHER',
});

/** Tuple of every legal ALLOCATION value — useful for schema validation. */
export const ALLOCATION_VALUES = Object.freeze(Object.values(ALLOCATION));
