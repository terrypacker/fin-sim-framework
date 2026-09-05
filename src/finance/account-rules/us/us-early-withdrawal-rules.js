/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { ACCOUNT_TYPE } from '../../assets/account.js';

/**
 * US early withdrawal penalty rules, keyed by account type.
 *
 * penaltyRate    — fraction applied to gross withdrawal (0.10 = 10% IRS penalty)
 * ageThreshold   — decimal years; penalty applies when person's decimal age < threshold
 *
 * Roth contributions have no age gate at all (handled separately in replenishSavings);
 * this entry governs the Roth *earnings* portion only.
 */
const US_EARLY_WITHDRAWAL_RULES = Object.freeze({
  [ACCOUNT_TYPE.ROTH]:            { penaltyRate: 0.10, ageThreshold: 59.5 },
  [ACCOUNT_TYPE.TRADITIONAL_IRA]: { penaltyRate: 0.10, ageThreshold: 60.0 },
  [ACCOUNT_TYPE.FOUR_OH_ONE_K]:   { penaltyRate: 0.10, ageThreshold: 59.5 },
});

/**
 * Returns the early withdrawal rules for a given US account type and year.
 * Returns null for account types that do not support early withdrawal.
 *
 * @param {string} accountType - ACCOUNT_TYPE value
 * @param {number} [_year]     - Tax year (reserved for future rule changes)
 * @returns {{ penaltyRate: number, ageThreshold: number } | null}
 */
export function getUsEarlyWithdrawalRules(accountType, _year) {
  return US_EARLY_WITHDRAWAL_RULES[accountType] ?? null;
}

/**
 * Is `allowsEarlyWithdrawal: true` MEANINGFUL on this account type? (design 97 §22.8.)
 *
 * The flag is read in two places that do not agree by construction, and the disagreement is
 * the reason this predicate is exported rather than each caller testing the table itself:
 *
 *  - `AccountService.replenishSavings` Phase 2 tests the flag and then looks the rules up,
 *    so a type with no entry reaches `if (!rules) continue` and **cannot be drawn early at
 *    any flag value**;
 *  - `net-liquidity.js#isAccessible` used to believe the flag unconditionally, ahead of any
 *    type or age test.
 *
 * So a `super` account carrying the flag would have moved `computeNetLiquidity` — the MPC /
 * optimizer CONTROL metric (design 88 §5) — while moving no dollar in any drawdown path: a
 * lever that changes the metric and not the money, in the metric whose scope is hardest to
 * check. Super's `false` is therefore STRUCTURAL, not authored: it is a statement about which
 * rules table has an entry.
 *
 * Real early release of Australian super (hardship, compassionate grounds, DASP) is not a
 * 10 % penalty — DASP is a punitive flat withholding — so modelling it means a rules ENTRY
 * with its own rate, at which point this predicate starts returning true for super on its
 * own. That is the intended way for the answer to change; flipping the boolean is not.
 *
 * @param {string} accountType - ACCOUNT_TYPE value
 * @returns {boolean}
 */
export function supportsEarlyWithdrawal(accountType) {
  return getUsEarlyWithdrawalRules(accountType) != null;
}
