/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { ACCOUNT_ROLES } from '../state/account-roles.js';

/**
 * Rate keys — short strings categorizing every rate-bearing handler.
 * Used by RegimeApplyReducer to scope regime adjustments to the correct
 * effective-rate field, and by handlers as the lookup key into state.effective*Rates.
 *
 * Inflation uses country codes directly: 'US', 'AU'.
 * FX uses currency pairs:                'USD_AUD'.
 */
export const RATE_KEYS = Object.freeze({
  // Equity (forward returns)
  EQUITY_US:       'EQUITY_US',       // Roth, IRA, 401k earnings, US stock earnings
  EQUITY_AU:       'EQUITY_AU',       // AU stock, Super earnings

  // Fixed income
  FIXED_INCOME_US: 'FIXED_INCOME_US', // FixedIncomeInterestHandler (US)
  FIXED_INCOME_AU: 'FIXED_INCOME_AU', // AuFixedIncomeInterestMonthlyHandler

  // Savings interest
  SAVINGS_US:      'SAVINGS_US',
  SAVINGS_AU:      'SAVINGS_AU',

  // Real estate / collectibles
  REAL_ESTATE_US:  'REAL_ESTATE_US',
  REAL_ESTATE_AU:  'REAL_ESTATE_AU',
  COLLECTIBLE:     'COLLECTIBLE',
});

/**
 * Map from ACCOUNT_ROLES values to their corresponding RATE_KEYS entry.
 * Used by the ECONOMIC_REGIMES toolset to build rateKeyToStateKeys maps
 * from the scenario's registered accounts.
 */
export const ROLE_TO_RATE_KEY = Object.freeze({
  [ACCOUNT_ROLES.ROTH]:           RATE_KEYS.EQUITY_US,
  [ACCOUNT_ROLES.IRA]:            RATE_KEYS.EQUITY_US,
  [ACCOUNT_ROLES.K401]:           RATE_KEYS.EQUITY_US,
  [ACCOUNT_ROLES.US_STOCK]:       RATE_KEYS.EQUITY_US,
  [ACCOUNT_ROLES.AU_STOCK]:       RATE_KEYS.EQUITY_AU,
  [ACCOUNT_ROLES.SUPER]:          RATE_KEYS.EQUITY_AU,
  [ACCOUNT_ROLES.FIXED_INCOME]:   RATE_KEYS.FIXED_INCOME_US,
  [ACCOUNT_ROLES.AU_FIXED_INCOME]:RATE_KEYS.FIXED_INCOME_AU,
  [ACCOUNT_ROLES.US_SAVINGS]:     RATE_KEYS.SAVINGS_US,
  [ACCOUNT_ROLES.AU_SAVINGS]:     RATE_KEYS.SAVINGS_AU,
});
