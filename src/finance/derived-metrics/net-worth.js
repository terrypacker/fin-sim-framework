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

    const currency = val.currency?.code ?? val.currency ?? baseCurrency;
    let contribution = 0;

    if (typeof val.balance === 'number') {
      // Account
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

    if (currency === baseCurrency) {
      total += contribution;
    } else {
      const pairId = `${baseCurrency}_${currency}`;
      const rate   = state.effectiveExchangeRates?.[pairId] ?? 1;
      total += contribution / rate;
    }
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
