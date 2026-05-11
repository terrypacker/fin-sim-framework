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
