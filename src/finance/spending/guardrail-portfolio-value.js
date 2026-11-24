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
 * Scope note (design 88 §5.4 / D4): requiring BOTH a numeric `balance` and a
 * non-null `drawdownPriority` is most of the lever-reachability test in another
 * spelling — it omits net-liquidity's age gate, but it already excludes every
 * `Asset` kind, speculative or not. So the guardrail needs no change for design 88,
 * and that exclusion is intent rather than coincidence: a guardrail that flexed
 * spending against a house it cannot sell would be steering on a phantom.
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

/**
 * Convert a USD amount (at spot) into the units `state.expenses` / `state.monthlyExpenses`
 * are denominated in, so a spending-to-portfolio ratio compares like with like.
 *
 * Mirrors MonthlyExpensesHandler: under RESIDENCE the authored figure is base-currency USD
 * that the handler re-bases into the residence currency at the ANCHOR rate
 * (`expenseRebaseRates` / `baseExchangeRates`), never spot. So a dollar of portfolio buys
 *   USD resident:  1 expense unit;
 *   AU resident:   spot / anchor expense units (convert to AUD at spot, re-base at anchor).
 * An explicit USD or AUD expense currency is plain spot conversion. Without the rates (a
 * single-country plan) nothing is converted.
 */
export function usdToExpenseUnits(usd, state, expensesCurrency = 'RESIDENCE', primaryPersonKey = null) {
  const spot   = state.effectiveExchangeRates?.USD_AUD;
  const anchor = state.expenseRebaseRates?.USD_AUD ?? state.baseExchangeRates?.USD_AUD;
  if (expensesCurrency === 'AUD') return Number.isFinite(spot) ? usd * spot : usd;
  if (expensesCurrency === 'USD') return usd;
  const key  = primaryPersonKey ?? Object.keys(state.people ?? {})[0];
  const isAu = state.people?.[key]?.residency === 'AU';
  if (!isAu || !Number.isFinite(spot) || !Number.isFinite(anchor) || anchor <= 0) return usd;
  return usd * spot / anchor;
}

/**
 * The guardrail portfolio in the expense figure's units: the denominator of every guardrail
 * withdrawal rate (baseline and annual check alike).
 *
 * Dividing `monthlyExpenses` by a spot-USD portfolio mixed units once an AU resident's expense
 * figure was re-based at the anchor: the rate then moved with the exchange rate though nothing
 * real had changed, so a currency swing alone could cut or raise spending. Here the ratio is
 * currency-free, so `guardrailBaseCurrency` no longer affects it.
 */
export function guardrailPortfolioInExpenseUnits(state, expensesCurrency = 'RESIDENCE') {
  return usdToExpenseUnits(computeGuardrailPortfolioValue(state, 'USD'), state, expensesCurrency);
}
