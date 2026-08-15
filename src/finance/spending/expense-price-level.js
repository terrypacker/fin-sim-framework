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
 * The price level an `EXPENSE_DEBIT` was incurred at — design 89 §5.6 (step E).
 *
 * **The defect this closes.** `AccumulateConsumptionReducer` and its CRRA companion
 * deflate nominal spending to base-year dollars, and both used to pick the price
 * index from the **debited account's currency**:
 *
 *     const cc = currency === 'AUD' ? 'AU' : 'US';   // wrong axis
 *
 * Currency is not the axis. The right divisor is the price level of the economy the
 * money was spent in, and the emitter is the only thing that knows it:
 *
 *   · `MonthlyExpensesHandler` — `state.monthlyExpenses` is inflated by
 *     `InflationAdjustReducer` at the **residence** country's rate, explicitly and
 *     deliberately (it drives expenses off the always-annual US advance at the
 *     residence rate so a mid-year move cannot drop an increment).
 *   · the two property handlers — each property's costs are indexed at
 *     **`prop.country`**'s accumulator, and several properties are summed into ONE
 *     debit, so a single tick can carry two different price levels at once.
 *
 * That last case is why this is a stamped field rather than a better guess. No
 * inference from the account, the residence or the action can recover a blend, and
 * design 87 hit the identical wall with §988(e)(3)'s "to the extent" fraction and
 * answered it the same way — see `blendExpenseBusinessFraction`, whose shape this
 * mirrors on purpose.
 *
 * **Why it was inert, and why that is not reassuring.** Measured on the reference
 * plan the old and new deflators agree to 0.00%, even with AU inflation forced to a
 * different rate. Not because currency is a good proxy, but because
 * `MonthlyExpensesHandler` picks the target account BY residence — so the account's
 * currency happened to equal the residence currency. The result was correct through
 * an agreement between two handlers rather than by construction, which is exactly
 * the arrangement that breaks silently when one of them changes.
 */

/**
 * Blend per-component price levels into the ONE level a combined debit can carry.
 *
 * The accumulators compute `debit / priceLevel`, so the level that makes a blended
 * debit exact is the **debit-weighted harmonic mean** — the value satisfying
 *
 *     totalDebit / blend  ===  Σ (debitᵢ / priceLevelᵢ)
 *
 * An arithmetic mean would be close but wrong, and wrong in a way no test on a
 * single-property tick could see. Callers accumulate the right-hand side as they
 * already accumulate `businessDebit`, and pass it here.
 *
 * @param {number} deflatedDebit  Σ (debitᵢ / priceLevelᵢ) — the real-terms total
 * @param {number} totalDebit     Σ debitᵢ — the nominal total on the action
 * @returns {number} the equivalent single price level; 1 when either side is absent,
 *                   which makes an un-indexed debit a no-op rather than a divide-by-zero
 */
export function blendExpensePriceLevel(deflatedDebit, totalDebit) {
  if (!(totalDebit > 0) || !(deflatedDebit > 0)) return 1;
  return totalDebit / deflatedDebit;
}

/**
 * The price level governing the household's own living costs: the **residence**
 * country's, matching the index `InflationAdjustReducer` inflates
 * `state.monthlyExpenses` by.
 *
 * @param {object} state
 * @param {?string} [primaryPersonKey]  the emitter's configured primary, if any
 * @returns {number} the accumulator value, or 1 when none is recorded
 */
export function residencePriceLevel(state, primaryPersonKey = null) {
  const personKey = primaryPersonKey ?? Object.keys(state?.people ?? {})[0];
  const cc        = state?.people?.[personKey]?.residency === 'AU' ? 'AU' : 'US';
  return state?.inflationAccumulator?.[cc] ?? 1;
}
