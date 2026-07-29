/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { toBaseCurrency, currencyOf } from '../fx/to-base-currency.js';

/**
 * Compute total net worth from simulation state.
 *
 * Includes all asset categories, FX-converted to baseCurrency:
 *   - Accounts       — any state entry with a numeric `balance`
 *   - Real property  — state entries with kind === 'real-property'; contributes equity (value − mortgageBalance)
 *   - Collectibles   — state entries with kind === 'collectible'; contributes market value
 *   - Company equity — state entries with kind === 'company'; contributes market value
 *
 * @param {object} state
 * @param {string} [baseCurrency='USD']
 * @returns {number}
 */
export function computeNetWorth(state, baseCurrency = 'USD') {
  let total = 0;

  for (const val of Object.values(state)) {
    if (val == null || typeof val !== 'object') continue;

    const currency = currencyOf(val, baseCurrency);
    let contribution = 0;

    if (val.type === 'loan' && typeof val.balance === 'number') {
      // Liability (design 54): owed principal reduces net worth.
      contribution = -val.balance;
    } else if (typeof val.balance === 'number') {
      // Account (asset)
      contribution = val.balance;
    } else if (val.kind === 'real-property' && typeof val.value === 'number') {
      // RealProperty: equity only
      contribution = val.value - (val.mortgageBalance ?? 0);
    } else if (val.kind === 'collectible' && typeof val.value === 'number') {
      contribution = val.value;
    } else if (val.kind === 'company' && typeof val.value === 'number') {
      contribution = val.value;
    } else {
      continue;
    }

    // Shared with the allocation cube (design 82 §5.1a): the two are bound by the
    // invariant Σ cube rows === computeNetWorth, so they must not be able to hold
    // different opinions about what a dollar is.
    total += toBaseCurrency(contribution, currency, baseCurrency, state);
  }

  return total;
}

/**
 * DerivedMetrics function: writes state.metrics.netWorth.
 * Register with DerivedMetricsRegistry or pass as a standalone function.
 *
 * @param {object} state
 * @param {string} [baseCurrency='USD']
 */
export function deriveNetWorth(state, baseCurrency = 'USD') {
  if (typeof baseCurrency !== 'string') baseCurrency = 'USD'; // registry passes date as 2nd arg
  if (!state.metrics || typeof state.metrics !== 'object') state.metrics = {};
  state.metrics.netWorth = +computeNetWorth(state, baseCurrency).toFixed(2);
}
