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
 * What an `EXPENSE_DEBIT` bought — design 89 §6.1(A) / §8 tier 1.
 *
 * **The defect this closes.** Four handlers emit `EXPENSE_DEBIT`, and until now the
 * payload could not tell them apart. `targetKey` cannot: all four resolve the same
 * residence-appropriate cash pool. Amount cannot, date cannot, and `section988`
 * cannot — a home's running costs and a month's groceries are both
 * `businessFraction: 0` (design 89 §6.0 item 3). So "monthly expenses" and "property
 * expenses", which the spending report has to draw as separate bands, were the same
 * row.
 *
 * **Emitted, never inferred.** Design 89 §6's hard rule, and design 82 §2's argument
 * applied to the flow side: emit the tuple, decide the grouping in the consumer. Every
 * consumer that reconstructs the category from `targetKey`, amount or cadence will
 * reconstruct it slightly differently, and will do so silently. The handler is the only
 * thing that knows.
 *
 * **Why `spendCategory` and not `category`.** `ExpenseEventHandler` emits
 * `EXPENSE_EVENT_APPLY` alongside its own `EXPENSE_DEBIT`, in the same tick, and that
 * action already carries a `category` — free text, authored in the scenario
 * (`'travel'`, `'other'`), declared `ValueType.text()` in both toolsets. Two fields
 * named `category` in one journal with two vocabularies is a join waiting to be made
 * by accident. Distinct names make the mistake impossible rather than merely unlikely.
 *
 * This is a sibling of `section988` and `priceLevel`, not a part of either: same four
 * emitters, different question, different consumers.
 */

/**
 * The closed vocabulary. Design 89 §8 tier 1, minus the categories that are not an
 * `EXPENSE_DEBIT` at all (`TAX_*`, `INTEREST`, `FX_COST` come from other action types
 * and are classified by the reporting layer, not stamped here).
 *
 * `CARE` is deliberately absent. `LATE_LIFE_CARE_APPLY` scales `state.monthlyExpenses`
 * *upstream* of the debit, so a care-inflated living expense is indistinguishable from
 * a large one at this point — recovering it needs a change in the care path, not a
 * stamp on an emitter (design 89 OQ2 / §11.1).
 */
export const SPEND_CATEGORY = Object.freeze({
  /** `MonthlyExpensesHandler` — household living costs. */
  LIVING:           'LIVING',
  /** `HouseRunningCostHandler` — rates, insurance, utilities, body corporate (design 75 §5.1). */
  HOUSING_RUNNING:  'HOUSING_RUNNING',
  /** `RealPropertyRepairTickHandler` — lumpy repairs (design 75 §5.2). */
  HOUSING_REPAIR:   'HOUSING_REPAIR',
  /** `ExpenseEventHandler` — one-off planned events. */
  DISCRETIONARY:    'DISCRETIONARY',
});

/** Every value `spendCategory` may take on an `EXPENSE_DEBIT`. */
export const SPEND_CATEGORIES = Object.freeze(Object.values(SPEND_CATEGORY));

/**
 * The share of a debit that was capitalized rather than consumed — design 89 §8.1.
 *
 * Money that lifts an asset's cost basis is wealth moved, not spending, and drawing it
 * in a consumption band overstates what the plan costs. Design 75 §5.2 already made
 * this split for repairs (`capitalizeRepairs` lifts `costBasis`, the rest is
 * maintenance) and design 86 G8 made it for events (`capitalize` lifts
 * `capitalizedImprovements`); this carries the same split onto the debit so the report
 * does not have to re-derive it from a different action.
 *
 * A fraction rather than a flag for the same reason `businessFraction` is: both
 * property handlers sum several properties into ONE debit, each with its own
 * `capitalizeRepairs`, so the honest combination is the debit-weighted mean. Shape
 * mirrors `blendExpenseBusinessFraction` on purpose.
 *
 * @param {number} capitalDebit  the part of the debit that lifted a cost basis
 * @param {number} totalDebit    the whole debit
 * @returns {number} 0..1, and 0 for a zero/absent debit
 */
export function blendCapitalFraction(capitalDebit, totalDebit) {
  if (!(totalDebit > 0)) return 0;
  return Math.min(1, Math.max(0, capitalDebit / totalDebit));
}
