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
  // Equity (forward returns).
  // EQUITY_US / EQUITY_AU are the asset-CLASS keys — used by shocks (which author
  // class-level effects), dividends, and revaluation grouping (ROLE_TO_RATE_KEY).
  // Each equity account TYPE also has its own member key below so it can carry an
  // independent base growth rate; RegimeApplyReducer fans a class-level return
  // shock out to all member keys (RATE_KEY_CLASS_MEMBERS), so a US-equity crash
  // still hits every US-equity account on top of its own baseline.
  EQUITY_US:       'EQUITY_US',       // class: Roth, IRA, 401k, US stock
  EQUITY_AU:       'EQUITY_AU',       // class: AU stock, Super

  // Per-account-type equity growth keys (members of the classes above).
  EQUITY_US_ROTH:      'EQUITY_US_ROTH',
  EQUITY_US_IRA:       'EQUITY_US_IRA',
  EQUITY_US_K401:      'EQUITY_US_K401',
  EQUITY_US_BROKERAGE: 'EQUITY_US_BROKERAGE',
  EQUITY_AU_STOCK:     'EQUITY_AU_STOCK',
  EQUITY_AU_SUPER:     'EQUITY_AU_SUPER',

  // Fixed income
  FIXED_INCOME_US: 'FIXED_INCOME_US', // FixedIncomeInterestHandler (US)
  FIXED_INCOME_AU: 'FIXED_INCOME_AU', // AuFixedIncomeInterestMonthlyHandler

  // Savings interest
  SAVINGS_US:      'SAVINGS_US',
  SAVINGS_AU:      'SAVINGS_AU',

  // Central-bank policy ("Prime") rates (design 56). Per-country, independent.
  // Cash accounts and variable loans derive their effective rate as
  // `Prime(country) + account.primeSpread`. These live in effectiveInterestRates.
  PRIME_US:        'PRIME_US',        // Fed policy rate
  PRIME_AU:        'PRIME_AU',        // RBA policy rate

  // Real estate / collectibles
  REAL_ESTATE_US:  'REAL_ESTATE_US',
  REAL_ESTATE_AU:  'REAL_ESTATE_AU',
  COLLECTIBLE:     'COLLECTIBLE',

  // Gold (design 56 §7) — a commodity return series on its own key, decoupled
  // from equity forward returns and central-bank Prime. Lives in
  // effectiveGrowthRates (seeded from the global `goldGrowthRate`), regime-
  // adjustable like equity but never fanned out from an equity-class shock.
  GOLD:            'GOLD',
});

/**
 * Per-rate-key metadata (design 28 §5). A sibling to RATE_KEYS (whose values
 * are bare strings and cannot carry metadata). Keys must match RATE_KEYS values.
 *
 * defaultDuration: modified duration in years, used by BondPriceAdjustReducer
 *   when a BOND holding has no explicit `holding.duration`. `?? 0` means the
 *   absence of defaultDuration is a safe no-op for non-bond rate keys.
 *   5.0 years = intermediate-Treasury proxy.
 */
export const RATE_KEY_META = Object.freeze({
  [RATE_KEYS.FIXED_INCOME_US]: { defaultDuration: 5.0 },
  [RATE_KEYS.FIXED_INCOME_AU]: { defaultDuration: 5.0 },
});

/**
 * Asset-class → member growth keys. RegimeApplyReducer uses this to fan a
 * class-level return adjustment (e.g. a shock's `{ EQUITY_US: -0.30 }`) out to
 * every member key in state.effectiveGrowthRates, so the class shock applies to
 * each account type on top of its own seeded base rate. Classes not listed here
 * (FIXED_INCOME_*, SAVINGS_*, …) have a single account type and need no fan-out.
 */
export const RATE_KEY_CLASS_MEMBERS = Object.freeze({
  [RATE_KEYS.EQUITY_US]: [
    RATE_KEYS.EQUITY_US_ROTH, RATE_KEYS.EQUITY_US_IRA,
    RATE_KEYS.EQUITY_US_K401, RATE_KEYS.EQUITY_US_BROKERAGE,
  ],
  [RATE_KEYS.EQUITY_AU]: [
    RATE_KEYS.EQUITY_AU_STOCK, RATE_KEYS.EQUITY_AU_SUPER,
  ],
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

/**
 * Map from ACCOUNT_ROLES to the per-account-type *member* rate key — i.e. the
 * `static rateKey` its earnings/interest handler carries and looks up (design 55 §8).
 * This differs from ROLE_TO_RATE_KEY, which returns the class key a regime shock
 * *targets* (EQUITY_US): the member key is the leaf the class fans out to
 * (EQUITY_US_ROTH), and the one the ECONOMIC_REGIMES toolset extends with a
 * per-account entry `<memberKey>::<stateKey>`. Keeping this aligned with each
 * handler's `static rateKey` is what makes per-account seeding and the
 * `computeHoldingsGrowth` lookup agree.
 */
export const MEMBER_RATE_KEY_BY_ROLE = Object.freeze({
  [ACCOUNT_ROLES.ROTH]:            RATE_KEYS.EQUITY_US_ROTH,
  [ACCOUNT_ROLES.IRA]:             RATE_KEYS.EQUITY_US_IRA,
  [ACCOUNT_ROLES.K401]:            RATE_KEYS.EQUITY_US_K401,
  [ACCOUNT_ROLES.US_STOCK]:        RATE_KEYS.EQUITY_US_BROKERAGE,
  [ACCOUNT_ROLES.AU_STOCK]:        RATE_KEYS.EQUITY_AU_STOCK,
  [ACCOUNT_ROLES.SUPER]:           RATE_KEYS.EQUITY_AU_SUPER,
  [ACCOUNT_ROLES.FIXED_INCOME]:    RATE_KEYS.FIXED_INCOME_US,
  [ACCOUNT_ROLES.AU_FIXED_INCOME]: RATE_KEYS.FIXED_INCOME_AU,
  [ACCOUNT_ROLES.US_SAVINGS]:      RATE_KEYS.SAVINGS_US,
  [ACCOUNT_ROLES.AU_SAVINGS]:      RATE_KEYS.SAVINGS_AU,
});

/** RATE_KEYS entries that live in `effectiveInterestRates` (vs `effectiveGrowthRates`). */
export const INTEREST_RATE_KEYS = Object.freeze(new Set([
  RATE_KEYS.FIXED_INCOME_US, RATE_KEYS.FIXED_INCOME_AU,
  RATE_KEYS.SAVINGS_US,      RATE_KEYS.SAVINGS_AU,
  RATE_KEYS.PRIME_US,        RATE_KEYS.PRIME_AU,
]));

/**
 * Cash member rate keys that are Prime-relative (design 56 §4/§5) → their country's
 * Prime key. A cash account whose member key is here and which carries a `primeSpread`
 * derives its effective rate as `Prime + primeSpread`; keys absent here (FIXED_INCOME_*,
 * bonds) are never Prime-linked (Decision 3 excludes bonds). Offset accounts have no
 * member rate key at all (Decision 7 — they earn nothing), so they never reach this map.
 */
export const CASH_PRIME_KEY_BY_RATE_KEY = Object.freeze({
  [RATE_KEYS.SAVINGS_US]: RATE_KEYS.PRIME_US,
  [RATE_KEYS.SAVINGS_AU]: RATE_KEYS.PRIME_AU,
});

/**
 * Country → its cash (savings) rate key. Used to seed the cash-sleeve rate of a
 * non-cash account carrying a `primeSpread` (design 56 §6): a `CASH` holding in a
 * `BROKERAGE` resolves to `SAVINGS_{country}` and reads `SAVINGS_{country}::<stateKey>`.
 */
export const SAVINGS_KEY_BY_COUNTRY = Object.freeze({
  US: RATE_KEYS.SAVINGS_US,
  AU: RATE_KEYS.SAVINGS_AU,
});

/**
 * Country → its central-bank Prime key. Loans read Prime directly from
 * `state.effectiveInterestRates[PRIME_{country}]` (they are outside the earnings
 * substrate — design 56 §5 / Phase 3), deriving `Prime(country,t) + loan.primeSpread`.
 */
export const PRIME_KEY_BY_COUNTRY = Object.freeze({
  US: RATE_KEYS.PRIME_US,
  AU: RATE_KEYS.PRIME_AU,
});
