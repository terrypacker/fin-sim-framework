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
 * Compute the Guardrail drawdown portfolio value from simulation state.
 *
 * Sums the balance of every state entry that looks like an account with
 * drawdownPriority != null.  Account balances in non-base currencies are
 * FX-converted using state.effectiveExchangeRates before summing.
 *
 * @param {object} state        — current simulation state
 * @param {string} [baseCurrency='USD']
 * @returns {number}  Total portfolio value in baseCurrency
 */
export function computeGuardrailPortfolioValue(state, baseCurrency = 'USD') {
  let total = 0;
  for (const val of Object.values(state)) {
    if (val == null || typeof val !== 'object') continue;
    if (val.drawdownPriority == null) continue;
    if (typeof val.balance !== 'number') continue;

    const currency = val.currency ?? baseCurrency;
    if (currency === baseCurrency) {
      total += val.balance;
    } else {
      // Convert to baseCurrency using the stored exchange rate.
      // Example: baseCurrency=USD, account currency=AUD.
      // effectiveExchangeRates['USD_AUD'] = AUD per 1 USD → AUD / rate = USD.
      const pairId = `${baseCurrency}_${currency}`;
      const rate   = state.effectiveExchangeRates?.[pairId] ?? 1;
      total += val.balance / rate;
    }
  }
  return total;
}
