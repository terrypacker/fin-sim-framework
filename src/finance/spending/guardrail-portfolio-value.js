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
 * Compute the Guardrail drawdown portfolio value from simulation state.
 *
 * Sums the balance of every state entry that looks like an account with
 * drawdownPriority != null.  Account balances in non-base currencies are
 * FX-converted using state.effectiveExchangeRates before summing.
 *
 * ⚠ This was the one copy of the valuation convention that had already drifted
 * (design 82 §5.1a, converged): it read `val.currency` as a bare string, but a
 * runtime account carries `currency` as a `{code, symbol}` DESCRIPTOR. So the
 * base-currency short-circuit never matched, the pair id came out
 * `USD_[object Object]`, the missing-rate fallback returned 1 — and every
 * FOREIGN drawdown account was summed at its face value with no conversion at
 * all. USD accounts were right by accident, which is why nothing looked wrong.
 * The unit tests missed it because they build state with bare-string currencies,
 * which no real run produces. `currencyOf` is the fix and the reason it lives
 * next to the conversion it feeds.
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

    total += toBaseCurrency(val.balance, currencyOf(val, baseCurrency), baseCurrency, state);
  }
  return total;
}
