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
 * Golden coverage manifest — which action types the golden scenarios actually
 * EXERCISE, and which are still unguarded at scenario level.
 *
 * The companion gate (tests/unit/golden-coverage-gate.test.mjs) runs every spec in
 * golden-specs.js, collects the action types that fired, and asserts this file is
 * an exact partition of the action-type universe. Add a feature and its action
 * type appears in neither list, so the gate fails until you either cover it with a
 * golden or waive it here on purpose. That is the whole point: the previous single
 * golden fell from covering most of the engine to covering 31% of it purely by
 * accretion, because nothing ever forced the question.
 *
 * "Universe" = the union, across all goldens, of the action types WIRED into the
 * compiled config (`cfg.reducers[].reducedActionTypes`) and those observed firing.
 * Wired-but-never-fired is exactly the interesting set.
 *
 * ── COVERED means "a golden reaches it end to end" ───────────────────────────
 *
 * It does NOT mean "well tested" — most KNOWN_GAPS entries below have solid
 * isolated reducer tests (see reducer-coverage-manifest.js, which tracks that
 * separately). What a golden adds is the interaction: ordering against other
 * events, the tax settle it chains into, the FX conversion on the way to a
 * metric, and the state it leaves behind for the next 20 years. The NaN this
 * harness found on its first run — EVT-27 writing NaN into
 * auStockAccount.contributionBasis for 24 straight years — had a green isolated
 * reducer test the whole time, because that test seeded the basis fields the real
 * scenario leaves undefined.
 *
 * ── Working the list down ────────────────────────────────────────────────────
 *
 * Move an entry from KNOWN_GAPS to COVERED by adding (or extending) a golden that
 * reaches it, never by deleting the line. Each block below is annotated with what
 * a golden would have to do; they are grouped so that one new scenario typically
 * clears a whole block.
 */

/** Action types at least one golden scenario actually fires. */
export const COVERED = [
  'ASSET_APPRECIATE_APPLY',
  'AU_DIVIDEND_FRANKED_NONRESIDENT_APPLY',
  'AU_DIVIDEND_FRANKED_NONRESIDENT_TAX',
  'AU_DIVIDEND_FRANKED_RESIDENT_APPLY',
  'AU_DIVIDEND_FRANKED_RESIDENT_TAX',
  'AU_FIXED_INCOME_EARNINGS_APPLY',
  'AU_FIXED_INCOME_EARNINGS_TAX',
  'AU_PERIOD_ADVANCE',
  'AU_SAVINGS_EARNINGS_APPLY',
  'AU_SAVINGS_EARNINGS_TAX',
  'AU_STOCK_EARNINGS_APPLY',
  'AU_TAX_PAYMENT_DEBIT',
  'AU_TAX_SETTLE_APPLY',
  'BOND_COUPON_CASH_APPLY',
  'BOND_COUPON_TAX',
  'BOND_SLEEVE_COUPON_APPLY',
  'CASH_SLEEVE_INTEREST_APPLY',
  'CHANGE_RESIDENCY_APPLY',
  'COMPANY_SALE_APPLY',
  'COMPANY_SALE_TAX',
  'EXPENSE_DEBIT',
  'FIXED_INCOME_EARNINGS_APPLY',
  'FIXED_INCOME_EARNINGS_TAX',
  'HOLDING_TRANSACT',
  'INTL_TRANSFER_RECORD',
  'IRA_EARNINGS_APPLY',
  'K401_EARNINGS_APPLY',
  'K401_TO_IRA_CONVERSION_APPLY',
  'RECORD_BALANCE',
  'RECORD_METRIC',
  'REPLENISH_SAVINGS',
  'ROTH_EARNINGS_APPLY',
  'SS_INCOME_APPLY',
  'SS_INCOME_TAX',
  'STOCK_DIVIDEND_CASH_APPLY',
  'STOCK_DIVIDEND_TAX',
  'STOCK_EARNINGS_APPLY',
  'SUPER_EARNINGS_APPLY',
  'SUPER_EARNINGS_TAX',
  'US_PERIOD_ADVANCE',
  'US_SAVINGS_INTEREST_CREDIT',
  'US_TAX_PAYMENT_DEBIT',
  'US_TAX_SETTLE_APPLY',
  'WAGES_INCOME_APPLY',
  'WAGES_INCOME_TAX',
];

/**
 * Wired into a golden's config but never reached by any golden run.
 *
 * Grouped by the scenario that would clear them. Do not delete a line to make the
 * gate pass — a deletion here is a silent coverage loss, which is the failure mode
 * this file exists to prevent.
 */
export const KNOWN_GAPS = [
  // ── Loans, mortgages and leveraged property (designs 54, 86)
  // One golden: a plan holding a mortgaged rental. Reaches the amortisation schedule,
  // the offset account, and the two interest-deduction regimes (AU s8-1 unquarantined
  // vs US §163(d) pooled) that design 86 G3 added.
  'AU_INVESTMENT_INTEREST_DEDUCTION',
  'AU_RENTAL_INCOME_TAX',
  'HOUSE_REPAIR_APPLY',
  'LOAN_PAYMENT_APPLY',
  'US_INVESTMENT_INTEREST_DEDUCTION',
  'US_RENTAL_INCOME_TAX',

  // ── Property disposal and the main-residence concessions (design 83 G7)
  // Same golden can sell the house at the end: §121 on the US side, the AU main-residence
  // exemption on the other, both prorated.
  'AU_HOUSE_SALE_APPLY',
  'AU_HOUSE_SALE_TAX',
  'US_HOUSE_SALE_APPLY',
  'US_HOUSE_SALE_TAX',

  // ── Retirement contributions, withdrawals and RMDs (design 53)
  // The reference golden accumulates but barely decumulates — it ends with $12M, so the
  // drawdown ladder never reaches the wrappers. Needs a DECUMULATION golden: a smaller
  // balance sheet spending into its wrappers, old enough to hit RMD age.
  'IRA_CONTRIBUTION_APPLY',
  'IRA_CONTRIBUTION_TAX',
  'IRA_RMD_APPLY',
  'IRA_RMD_TAX',
  'IRA_ROLLOVER_WITHDRAWAL_APPLY',
  'IRA_ROLLOVER_WITHDRAWAL_TAX',
  'IRA_WITHDRAWAL_CONTRIB_APPLY',
  'IRA_WITHDRAWAL_CONTRIB_TAX',
  'IRA_WITHDRAWAL_EARNINGS_APPLY',
  'IRA_WITHDRAWAL_EARNINGS_TAX',
  'K401_CONTRIBUTION_APPLY',
  'K401_CONTRIBUTION_TAX',
  'K401_RMD_APPLY',
  'K401_RMD_TAX',
  'K401_WITHDRAWAL_APPLY',
  'K401_WITHDRAWAL_TAX',
  'ROTH_CONTRIBUTION_APPLY',
  'ROTH_ROLLOVER_CONTRIBUTION_APPLY',
  'ROTH_ROLLOVER_EARNINGS_APPLY',
  'ROTH_ROLLOVER_WITHDRAWAL_CONTRIB_APPLY',
  'ROTH_ROLLOVER_WITHDRAWAL_CONTRIB_TAX',
  'ROTH_ROLLOVER_WITHDRAWAL_EARNINGS_APPLY',
  'ROTH_ROLLOVER_WITHDRAWAL_EARNINGS_TAX',
  'ROTH_WITHDRAWAL_CONTRIB_APPLY',
  'ROTH_WITHDRAWAL_EARNINGS_APPLY',
  'ROTH_WITHDRAWAL_EARNINGS_TAX',
  'SUPER_CONTRIBUTION_APPLY',
  'SUPER_CONTRIBUTION_TAX',
  'SUPER_WITHDRAWAL_CONTRIB_APPLY',
  'SUPER_WITHDRAWAL_EARNINGS_APPLY',
  'SUPER_WITHDRAWAL_EARNINGS_TAX',

  // ── Roth conversion and early-withdrawal decant (designs 45, 84)
  // Pairs naturally with the decumulation golden: a conversion ladder in the low-income
  // years between retirement and RMD age, priced across the residency change (84 G1).
  'ROTH_CONVERSION_APPLY',
  'ROTH_CONVERSION_TAX',
  'SCHEDULED_EARLY_WITHDRAWAL_APPLY',

  // ── Death, survivorship and bequest (designs 63, 68)
  // One short golden ending in a death year. Guards the terminal settle flush, the AU
  // per-person key drop, the survivor SS step, and inherited-account taxation.
  'INHERITED_RA_DISTRIBUTION_TAX',
  'NE_INHERITANCE_TAX',
  'PERSON_DIED_APPLY',
  'SOCIAL_SECURITY_SURVIVOR_APPLY',
  'SUPER_DEATH_BENEFIT_APPLY',
  'SUPER_DEATH_BENEFIT_TAX',

  // ── US state income tax and state residency change (design 71 §11.3)
  // Cheap to reach — set residencyState and move states mid-run. Measured to move the
  // reference golden's net worth by only -0.50%, i.e. inside the old ±1% band.
  'CHANGE_STATE_RESIDENCY_APPLY',
  'STATE_TAX_PAYMENT_DEBIT',
  'STATE_TAX_SETTLE_APPLY',

  // ── Foreign-currency basis pools and cross-border transfers (designs 51, 87)
  // §988 needs an authored fxBasisRate to come alive at all; until a golden does that,
  // every AUD account's currency-gain path is untested end to end.
  'FX_STEP_APPLY',
  'FX_TRANSFER_APPLY',
  'INTL_TRANSFER_APPLY',
  'SECTION_988_GAIN',

  // ── Stochastic paths, economic regimes and shocks (designs 67, 74, 75)
  // Off by default, so nothing exercises them. A seeded golden is still deterministic
  // (one RNG, fixed seed) and would guard the shock-revaluation and regime-fan paths.
  'ADD_REGIME_APPLY',
  'EQUITY_RETURN_STEP_APPLY',
  'PROPERTY_RETURN_STEP_APPLY',
  'RECOMPUTE_REGIMES',
  'REMOVE_REGIME_APPLY',
  'REVALUE_ASSET_APPLY',
  'YIELD_CURVE_STEP_APPLY',

  // ── Allocation, rebalancing, holdings surgery and bond mechanics (designs 61, 65, 66, 82)
  // The reference golden holds a static mix and never rebalances. A glidepath golden
  // would reach the drift bands, the ladder roll, accretion and the holding ops.
  'ACCOUNT_RETITLE_APPLY',
  'BOND_ACCRETION_APPLY',
  'BOND_COUPON_APPLY',
  'FIXED_INCOME_CONTRIBUTION_APPLY',
  'FIXED_INCOME_WITHDRAWAL_APPLY',
  'HOLDING_RETITLE',
  'HOLDING_REVALUE',
  'HOLDING_SET_BASIS',
  'HOLDING_SPLIT',
  'STOCK_CONTRIBUTION_APPLY',

  // ── Collectibles (design 57)
  // The reference golden holds a collectible but never sells or revalues it.
  'COLLECTIBLE_SALE_APPLY',
  'COLLECTIBLE_SALE_TAX',
  'COLLECTIBLE_VALUE_CHANGE_APPLY',

  // ── Taxable brokerage disposals and AU dividends
  // STOCK_WITHDRAWAL_TAX fires heavily in the live research plan while
  // STOCK_WITHDRAWAL_APPLY never fires there. That is NOT a dead parallel path: no
  // toolset schedules a STOCK_WITHDRAWAL event, because drawdown is demand-driven, so
  // nothing *plans* a stock sale. The handler/reducer pair is reachable by wiring one
  // in the ConfigBuilder (and is the deferred taxable branch of PanicSellReducer). A
  // golden needs an authored STOCK_WITHDRAWAL event, not an engine change.
  // AU_STOCK_WITHDRAWAL_* is absent for a third reason again: no AU-domiciled
  // brokerage account. See design/inconsistencies.md §4.11.
  'AU_DIVIDEND_UNFRANKED_NONRESIDENT_APPLY',
  'AU_DIVIDEND_UNFRANKED_NONRESIDENT_TAX',
  'AU_DIVIDEND_UNFRANKED_RESIDENT_APPLY',
  'AU_DIVIDEND_UNFRANKED_RESIDENT_TAX',
  'AU_SAVINGS_CONTRIBUTION_APPLY',
  'AU_SAVINGS_WITHDRAWAL_APPLY',
  'AU_STOCK_WITHDRAWAL_APPLY',
  'AU_STOCK_WITHDRAWAL_TAX',
  'STOCK_DIVIDEND_APPLY',
  'STOCK_WITHDRAWAL_APPLY',
  'STOCK_WITHDRAWAL_TAX',

  // ── Employment, self-employment and bonus income (designs 69, 73, 76)
  // The reference retiree has no wages after simStart. A pre-retirement golden with an
  // explicit workCountry would reach SECA, AU wages and NR withholding.
  'AU_SE_INCOME_TAX',
  'AU_WAGES_INCOME_APPLY',
  'AU_WAGES_INCOME_TAX',
  'BONUS_APPLY',
  'BONUS_TAX',
  'SE_INCOME_AU_APPLY',
  'SE_INCOME_US_APPLY',
  'SE_INCOME_US_TAX',
  'WAGES_WITHHELD_APPLY',

  // ── Insolvency, spending strategy and run termination
  // No golden ever runs out of money, so the whole failure path is unguarded — including
  // the escalation ladder that design 44 and the tax-path work rebuilt. A deliberately
  // under-funded short golden is the cheapest way to cover this block.
  'ACCUMULATE_DEFICIT',
  'OUT_OF_FUNDS',
  'SCENARIO_COMPLETE_CHECK',
  'SET_OUT_OF_FUNDS_DATE',
  'SPENDING_STRATEGY_APPLY',
];

/** Every action type this manifest accounts for. */
export const ALL_MANIFEST_ACTION_TYPES = [...COVERED, ...KNOWN_GAPS];
