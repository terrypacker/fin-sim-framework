/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { ALLOCATION }       from './allocation.js';
import { ACCOUNT_TYPE }     from '../assets/account.js';
import { ACCOUNT_ROLES }    from '../state/account-roles.js';
import { RATE_KEYS, ROLE_TO_RATE_KEY } from '../economic-regimes/rate-keys.js';

/**
 * Default ALLOCATION per account ROLE. Role is the more granular signal —
 * the same Account class (BrokerageAccount) backs both EQUITY (US_STOCK)
 * and BOND (FIXED_INCOME) positions in the current codebase, so role-based
 * lookup picks the right sleeve where type alone cannot.
 *
 * Falls through to DEFAULT_ALLOCATION_BY_TYPE when an account has no role.
 */
export const DEFAULT_ALLOCATION_BY_ROLE = Object.freeze({
  [ACCOUNT_ROLES.US_SAVINGS]:      ALLOCATION.CASH,
  [ACCOUNT_ROLES.AU_SAVINGS]:      ALLOCATION.CASH,
  [ACCOUNT_ROLES.US_OFFSET]:       ALLOCATION.CASH,
  [ACCOUNT_ROLES.AU_OFFSET]:       ALLOCATION.CASH,
  [ACCOUNT_ROLES.FIXED_INCOME]:    ALLOCATION.BOND,
  [ACCOUNT_ROLES.AU_FIXED_INCOME]: ALLOCATION.BOND,
  [ACCOUNT_ROLES.US_STOCK]:        ALLOCATION.EQUITY,
  [ACCOUNT_ROLES.AU_STOCK]:        ALLOCATION.EQUITY,
  [ACCOUNT_ROLES.ROTH]:            ALLOCATION.EQUITY,
  [ACCOUNT_ROLES.IRA]:             ALLOCATION.EQUITY,
  [ACCOUNT_ROLES.K401]:            ALLOCATION.EQUITY,
  [ACCOUNT_ROLES.SUPER]:           ALLOCATION.EQUITY,
});

/**
 * Default ALLOCATION per account TYPE (the ACCOUNT_TYPE discriminator).
 * Used as the fallback when an account has no role stamped.
 */
export const DEFAULT_ALLOCATION_BY_TYPE = Object.freeze({
  [ACCOUNT_TYPE.CHECKING]:        ALLOCATION.CASH,
  [ACCOUNT_TYPE.SAVINGS]:         ALLOCATION.CASH,
  [ACCOUNT_TYPE.OFFSET]:          ALLOCATION.CASH,
  [ACCOUNT_TYPE.BROKERAGE]:       ALLOCATION.EQUITY,
  [ACCOUNT_TYPE.FOUR_OH_ONE_K]:   ALLOCATION.EQUITY,
  [ACCOUNT_TYPE.ROTH]:            ALLOCATION.EQUITY,
  [ACCOUNT_TYPE.TRADITIONAL_IRA]: ALLOCATION.EQUITY,
  [ACCOUNT_TYPE.SUPER]:           ALLOCATION.EQUITY,
});

/**
 * Country × allocation → rateKey fallback table (design 25 §4.3).
 * OTHER falls through to caller-supplied keys (REAL_ESTATE_*, COLLECTIBLE, …).
 */
const RATE_KEY_BY_COUNTRY_ALLOCATION = Object.freeze({
  US: Object.freeze({
    [ALLOCATION.EQUITY]: RATE_KEYS.EQUITY_US,
    [ALLOCATION.BOND]:   RATE_KEYS.FIXED_INCOME_US,
    [ALLOCATION.CASH]:   RATE_KEYS.SAVINGS_US,
  }),
  AU: Object.freeze({
    [ALLOCATION.EQUITY]: RATE_KEYS.EQUITY_AU,
    [ALLOCATION.BOND]:   RATE_KEYS.FIXED_INCOME_AU,
    [ALLOCATION.CASH]:   RATE_KEYS.SAVINGS_AU,
  }),
});

/**
 * Resolve a Holding's default ALLOCATION from an Account.
 * Role wins when present; falls through to type. Returns OTHER for accounts
 * with neither — the caller (toolset) is expected to override.
 */
export function resolveDefaultAllocation(account) {
  if (account?.role && DEFAULT_ALLOCATION_BY_ROLE[account.role]) {
    return DEFAULT_ALLOCATION_BY_ROLE[account.role];
  }
  if (account?.type && DEFAULT_ALLOCATION_BY_TYPE[account.type]) {
    return DEFAULT_ALLOCATION_BY_TYPE[account.type];
  }
  return ALLOCATION.OTHER;
}

/**
 * Resolve a Holding's rateKey.
 *
 * Lookup order:
 *   1. Role-keyed (ROLE_TO_RATE_KEY) — preferred, encodes both jurisdiction and asset class.
 *   2. (country, allocation) table — fallback for accounts without a role.
 *   3. null — caller must supply a rateKey explicitly (e.g. OTHER / collectible / real-estate).
 *
 * @param {string|null} country   - ISO country code (e.g. 'US', 'AU')
 * @param {string}      allocation - ALLOCATION value
 * @param {string|null} [role]    - ACCOUNT_ROLES value (preferred when available)
 * @returns {string|null}
 */
export function resolveRateKey(country, allocation, role = null) {
  // CASH always earns a cash rate (design 56 §6): a cash sleeve in a non-cash account
  // (e.g. a BROKERAGE holding some CASH) must resolve to SAVINGS_{country}, NOT the
  // account role's equity/bond key. So the allocation wins over the role for CASH.
  // (Behavioral panic-sell cash passes rateKey:null and bypasses this resolver.)
  if (allocation === ALLOCATION.CASH) {
    return RATE_KEY_BY_COUNTRY_ALLOCATION[country]?.[ALLOCATION.CASH] ?? null;
  }
  if (role && ROLE_TO_RATE_KEY[role]) return ROLE_TO_RATE_KEY[role];
  return RATE_KEY_BY_COUNTRY_ALLOCATION[country]?.[allocation] ?? null;
}
