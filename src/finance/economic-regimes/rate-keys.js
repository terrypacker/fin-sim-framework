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
  // Equity (forward returns) — the MARKET axis (design 90 §7).
  //
  // These four keys name the market a holding tracks, and nothing else. That is a
  // change of axis, not an addition: until design 90 the only equity granularity was
  // the account WRAPPER (EQUITY_US_ROTH, EQUITY_US_BROKERAGE, EQUITY_AU_SUPER, …), so
  // a Roth holding a US total-market fund and a Roth holding an international fund were
  // the same sleeve, and a Super balance — in reality a diversified fund with a large
  // international allocation — could only be expressed as "AU equity at beta 0.7".
  // The account you keep something in does not determine what market it tracks.
  //
  // Per-ACCOUNT growth rates did not go away with the wrapper keys: every account is
  // still seeded as `<marketKey>::<stateKey>` (design 55 §8), which is where a
  // wrapper-specific rate now lives. It is a per-account override of a market rate
  // rather than an asset class of its own, which is what it always actually was.
  //
  // Two international sleeves, not one, because ex-US and ex-AU overlap heavily but are
  // not the same basket: ex-US contains Australia and ex-AU contains the United States,
  // roughly 60% of global market capitalisation. Collapsing them would make a US
  // investor's "international" allocation identical to an AU investor's.
  EQUITY_US:        'EQUITY_US',          // US market
  EQUITY_AU:        'EQUITY_AU',          // Australian market
  EQUITY_INTL_EX_US:'EQUITY_INTL_EX_US',  // developed + emerging ex-US
  EQUITY_INTL_EX_AU:'EQUITY_INTL_EX_AU',  // developed + emerging ex-Australia

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
 * Asset-class → sub-member growth keys, for `RegimeApplyReducer`'s shock fan-out.
 *
 * **Design 90 §7.2 — EMPTY, and deliberately kept rather than deleted.**
 *
 * This table existed to fan a class-level shock (`{ EQUITY_US: -0.30 }`) out to the
 * per-account-type member keys beneath it. With the market axis those member keys are
 * gone: a shock's key IS the sleeve, so `_addScaledExpandingClasses` falls through to
 * `[k]` and its `<leaf>::<stateKey>` sweep still reaches every seeded account. Shock
 * coverage is therefore unchanged — verified by the regime tests.
 *
 * It stays as an extension point because the fan-out logic reads it unconditionally,
 * and a future axis with genuine sub-members (sectors, factor tilts) would need exactly
 * this shape back. An empty object is a cheaper statement of "no sub-members today"
 * than deleting the mechanism and rebuilding it.
 */
export const RATE_KEY_CLASS_MEMBERS = Object.freeze({});

/**
 * Equity SLEEVES for stochastic return paths (design 74 §4) — one per MARKET since
 * design 90 §7.2. Each carries its own base growth rate and its own beta on the shared
 * market shock.
 *
 * ⚠️ **RNG-cursor ordering, restated because design 90 §1.4 found the received version
 * of this warning to be conditional.** `EquityReturnTickHandler` iterates this list, but
 * the market draw happens BEFORE the loop and the loop draws only when
 * `idioVol[sleeve] > 0` — skipping entirely, not drawing-and-multiplying-by-zero. So
 * while every sleeve's idio vol is 0 (the default) this list's membership and order are
 * RNG-irrelevant, which is what made re-shaping it safe. The moment any sleeve takes a
 * non-zero idio vol the warning becomes real again and order matters absolutely.
 * `equity-sleeve-rng-neutrality.test.mjs` pins the property this relies on.
 */
export const EQUITY_SLEEVES = Object.freeze([
  RATE_KEYS.EQUITY_AU,
  RATE_KEYS.EQUITY_INTL_EX_AU,
  RATE_KEYS.EQUITY_INTL_EX_US,
  RATE_KEYS.EQUITY_US,
]);

/**
 * Default per-MARKET beta on the shared market factor (design 74 §4 Option B, re-based
 * onto the market axis by design 90 §7.2). Overridable via the `equityReturnBeta` param;
 * a sleeve absent here defaults to 1.0.
 */
export const DEFAULT_EQUITY_BETA = Object.freeze({
  // The market factor is defined as the US market's, so EQUITY_US rides it 1:1 by
  // construction. The other three load below 1 in USD terms: a broad ex-US basket is
  // more diversified across economies than the US alone, and the Australian market is
  // narrower but far less correlated with US mega-cap technology than its own size
  // suggests. These are the same shape as the betas they replace, re-expressed on the
  // axis that actually generates the correlation.
  //
  // ⚠️ These are the CO-MOVEMENT parameter, not the dispersion one. With `idioVol` at
  // its default of 0 every sleeve is still a deterministic multiple of one draw, so
  // sleeves cannot cross — design 90 §7.4. Betas alone do not make losses possible.
  [RATE_KEYS.EQUITY_US]:         1.0,
  [RATE_KEYS.EQUITY_INTL_EX_US]: 0.85,
  [RATE_KEYS.EQUITY_INTL_EX_AU]: 0.95,
  [RATE_KEYS.EQUITY_AU]:         0.8,
});

/**
 * Real-property return-path sleeves (design 75 §4). Each real property loads on the shared
 * market factor through one of these keys, selected by country. Frozen in **stable, sorted**
 * order for the same RNG-cursor reason as EQUITY_SLEEVES: PropertyReturnTickHandler iterates
 * this list to draw optional idiosyncratic terms, so the order must never change (design 74
 * §4 ⚠️). AssetAppreciationHandler reads `state.propertyReturnDev[<sleeve>]` per property.
 */
export const PROPERTY_SLEEVES = Object.freeze([
  RATE_KEYS.REAL_ESTATE_AU,
  RATE_KEYS.REAL_ESTATE_US,
]);

/**
 * Default per-sleeve beta on the shared market factor (design 75 §4.1). Deliberately **near
 * zero**: the empirical contemporaneous house↔equity correlation is ≈ 0.04, so the standing
 * linear co-movement is tiny and the plan-breaking joint crash is authored via `shocks[]`
 * (owner decision, §8 Q7), not this beta. AU loads marginally higher — capital-city housing
 * is more credit/macro-sensitive. Overridable via the `propertyReturnBeta` param; a sleeve
 * absent here defaults to 1.0.
 */
export const DEFAULT_RE_BETA = Object.freeze({
  [RATE_KEYS.REAL_ESTATE_US]: 0.03,
  [RATE_KEYS.REAL_ESTATE_AU]: 0.05,
});

/**
 * Default per-sleeve idiosyncratic (property-specific) sd (design 75 §4.1). Housing is ~99%
 * idiosyncratic under the near-zero betas above — this is where a single home's price
 * variance actually comes from, giving the sale price real sequence/timing risk at the sale
 * date even at β = 0. Overridable via `propertyReturnIdioVol`; a sleeve absent here ⇒ 0.
 */
export const DEFAULT_RE_IDIO = Object.freeze({
  [RATE_KEYS.REAL_ESTATE_US]: 0.09,
  [RATE_KEYS.REAL_ESTATE_AU]: 0.10,
});

/**
 * Map from ACCOUNT_ROLES values to their corresponding RATE_KEYS entry.
 * Used by the ECONOMIC_REGIMES toolset to build rateKeyToStateKeys maps
 * from the scenario's registered accounts.
 */
export const ROLE_TO_RATE_KEY = Object.freeze({
  // Design 90 §7.2 — a role's DEFAULT market. It is only a default: a holding may name
  // any market in the EQUITY class, and after the sub-axis lands (§7.3) that is how a
  // Super balance expresses its international allocation instead of inheriting AU.
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
  // Design 90 §7.2 — equity roles now resolve to their MARKET key, and the two maps
  // above and below have converged for equity as a result. The wrapper-specific growth
  // rate survives as the per-account `<marketKey>::<stateKey>` seed, which is what
  // `seedPerAccountRates` writes for every account.
  [ACCOUNT_ROLES.ROTH]:            RATE_KEYS.EQUITY_US,
  [ACCOUNT_ROLES.IRA]:             RATE_KEYS.EQUITY_US,
  [ACCOUNT_ROLES.K401]:            RATE_KEYS.EQUITY_US,
  [ACCOUNT_ROLES.US_STOCK]:        RATE_KEYS.EQUITY_US,
  [ACCOUNT_ROLES.AU_STOCK]:        RATE_KEYS.EQUITY_AU,
  [ACCOUNT_ROLES.SUPER]:           RATE_KEYS.EQUITY_AU,
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
