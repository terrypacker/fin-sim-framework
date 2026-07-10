/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { BaseScenario }       from './base-scenario.js';
import { ScenarioSerializer }  from './scenario-serializer.js';
import { ToolsetRegistry }     from './toolsets/toolset-registry.js';
import { ScenarioCompiler }    from './toolsets/scenario-compiler.js';
import { US_BANKING }          from './toolsets/us-banking-toolset.js';
import { US_TAX }              from './toolsets/us-tax-toolset.js';
import { US_STATE_TAX }        from './toolsets/us-state-tax-toolset.js';
import { US_RETIREMENT }       from './toolsets/us-retirement-toolset.js';
import { AU_BANKING }          from './toolsets/au-banking-toolset.js';
import { AU_TAX }              from './toolsets/au-tax-toolset.js';
import { AU_RETIREMENT }       from './toolsets/au-retirement-toolset.js';
import { US_AU_CROSS_BORDER }  from './toolsets/us-au-cross-border-toolset.js';
import { US_REAL_PROPERTY }    from './toolsets/us-real-property-toolset.js';
import { AU_REAL_PROPERTY }    from './toolsets/au-real-property-toolset.js';
import { US_COLLECTIBLES }     from './toolsets/us-collectibles-toolset.js';
import { US_ROTH_CONVERSION }  from './toolsets/us-roth-conversion-toolset.js';
import { US_EARLY_WITHDRAWAL } from './toolsets/us-early-withdrawal-toolset.js';
import { US_BROKERAGE }        from './toolsets/us-brokerage-toolset.js';
import { AU_BROKERAGE }        from './toolsets/au-brokerage-toolset.js';
import { US_INCOME }           from './toolsets/us-income-toolset.js';
import { US_COMPANY_SALE }     from './toolsets/us-company-sale-toolset.js';
import { AU_INCOME }           from './toolsets/au-income-toolset.js';
import { ECONOMIC_REGIMES }    from './toolsets/economic-regimes-toolset.js';
import { ServiceRegistry }     from '../services/service-registry.js';
import { USD, AUD }            from '../finance/assets/account.js';
import { ACCOUNT_ROLES }       from '../finance/state/account-roles.js';
import { Holding }             from '../finance/holdings/holding.js';
import { ALLOCATION }          from '../finance/holdings/allocation.js';
import { DEFAULT_AGE_BANDS }   from '../finance/spending/strategies/age-banded-spending-reducer.js';
import { RATE_KEYS }           from '../finance/economic-regimes/rate-keys.js';

/**
 * Cash band — savings/checking roles are ranked ahead of every investment role
 * (priority 0) in the built-in strategies, so idle cash is spent before any
 * growth asset is liquidated ("spend non-investment money first"). Two runtime
 * rules in AccountService.replenishSavings give cash its distinct behaviour:
 *   1. a cash source is drawn down only to its `minimumBalance` (keeps a buffer);
 *   2. cash is liquid everywhere — it bypasses the LOCAL_FIRST same-country gate,
 *      so idle cash in the non-residence country is repatriated (FX fee applies)
 *      instead of stranding while growth assets are sold.
 * Because the savings roles live in the maps, a user-authored strategy can rank
 * cash later to model preserving a cash buffer.
 */
const CASH_BAND = {
  [ACCOUNT_ROLES.US_SAVINGS]: 0, [ACCOUNT_ROLES.AU_SAVINGS]: 0,
};

/**
 * Named drawdown strategies — the order accounts are liquidated to cover a
 * spending shortfall. Values are per-role *base* priorities (lower = drawn
 * first). Every built-in strategy spreads in CASH_BAND so cash drains first;
 * investment roles follow. Within investments the per-country strategies use
 * overlapping US/AU ranks (sorted per-country under LOCAL_FIRST); TAX_EFFICIENT
 * uses a single distinct global rank per role.
 *
 * Applied by the `accountPriority` node cascade in ScenarioLoader: each
 * account's drawdownPriority becomes base + ownerRank * ownerStride, so the
 * primary's buckets drain before the spouse's same-role buckets.
 *
 * PROPORTIONAL reuses the TAXABLE_FIRST eligibility map only to keep accounts
 * non-null (eligible); its actual pro-rata behavior is driven at runtime by
 * state.drawdownMode (see us-retirement-toolset + AccountService.replenishSavings).
 */
export const DRAWDOWN_STRATEGIES = {
  TAXABLE_FIRST: {            // cash, then taxable brokerage/fixed-income, then tax-deferred, Roth last
    ...CASH_BAND,
    [ACCOUNT_ROLES.FIXED_INCOME]: 1, [ACCOUNT_ROLES.US_STOCK]: 2,
    [ACCOUNT_ROLES.IRA]: 3, [ACCOUNT_ROLES.K401]: 4, [ACCOUNT_ROLES.ROTH]: 5,
    [ACCOUNT_ROLES.AU_FIXED_INCOME]: 1, [ACCOUNT_ROLES.AU_STOCK]: 2, [ACCOUNT_ROLES.SUPER]: 3,
  },
  TAX_DEFERRED_FIRST: {       // cash, then drain IRA/401k/Super early (bracket-fill, lower future RMDs)
    ...CASH_BAND,
    [ACCOUNT_ROLES.IRA]: 1, [ACCOUNT_ROLES.K401]: 2,
    [ACCOUNT_ROLES.FIXED_INCOME]: 3, [ACCOUNT_ROLES.US_STOCK]: 4, [ACCOUNT_ROLES.ROTH]: 5,
    [ACCOUNT_ROLES.SUPER]: 1, [ACCOUNT_ROLES.AU_FIXED_INCOME]: 2, [ACCOUNT_ROLES.AU_STOCK]: 3,
  },
  ROTH_FIRST: {               // cash, then Roth/tax-free first (comparison baseline); AU mirrors taxable
    ...CASH_BAND,
    [ACCOUNT_ROLES.ROTH]: 1, [ACCOUNT_ROLES.FIXED_INCOME]: 2, [ACCOUNT_ROLES.US_STOCK]: 3,
    [ACCOUNT_ROLES.IRA]: 4, [ACCOUNT_ROLES.K401]: 5,
    [ACCOUNT_ROLES.AU_FIXED_INCOME]: 1, [ACCOUNT_ROLES.AU_STOCK]: 2, [ACCOUNT_ROLES.SUPER]: 3,
  },
  PROPORTIONAL: {             // pro-rata across eligible buckets (runtime mode; see above)
    ...CASH_BAND,
    [ACCOUNT_ROLES.FIXED_INCOME]: 1, [ACCOUNT_ROLES.US_STOCK]: 2,
    [ACCOUNT_ROLES.IRA]: 3, [ACCOUNT_ROLES.K401]: 4, [ACCOUNT_ROLES.ROTH]: 5,
    [ACCOUNT_ROLES.AU_FIXED_INCOME]: 1, [ACCOUNT_ROLES.AU_STOCK]: 2, [ACCOUNT_ROLES.SUPER]: 3,
  },
  TAX_EFFICIENT: {            // GLOBAL order across BOTH countries by tax treatment.
    // Cash first (CASH_BAND), then a single distinct rank per investment role so
    // US and AU accounts interleave into one global drawdown order. Unlike the
    // per-country strategies above (whose US/AU ranks deliberately overlap because
    // replenishSavings sorts each country separately), this pairs with
    // crossBorderDrawdown=GLOBAL (set by the us-retirement toolset when selected),
    // letting replenishSavings cross the currency border in priority order
    // instead of draining the residency country first.
    ...CASH_BAND,
    [ACCOUNT_ROLES.FIXED_INCOME]: 1, [ACCOUNT_ROLES.US_STOCK]: 2,        // taxable: only gains taxed
    [ACCOUNT_ROLES.AU_FIXED_INCOME]: 3, [ACCOUNT_ROLES.AU_STOCK]: 4,     //   (basis already taxed) → drain first
    [ACCOUNT_ROLES.IRA]: 5, [ACCOUNT_ROLES.K401]: 6,                     // tax-deferred: ordinary income on withdrawal
    [ACCOUNT_ROLES.SUPER]: 7, [ACCOUNT_ROLES.ROTH]: 8,                   // tax-free: preserve longest (super tax-free 60+, Roth)
  },
  // No mapping → the cascade is a no-op, so per-account drawdownPriority values
  // authored in buildDefaultConfig (or hand-edited via the account editor) remain
  // authoritative. Select this to hand-tune individual account ordering.
  CUSTOM: null,
};

/**
 * Drawdown-eligible account roles — the union of roles that appear across the
 * built-in DRAWDOWN_STRATEGIES maps. Includes the cash/savings roles (CASH_BAND),
 * which are now first-class members of the drawdown order (spent first by default,
 * but rankable like any other role). Used to seed the DrawdownStrategyList editor's
 * role rows. The active savings *target* account is still never drained below its
 * minimum — that's enforced at runtime in replenishSavings, not by omission here.
 */
export const DRAWDOWN_ROLES = [...new Set(
  Object.values(DRAWDOWN_STRATEGIES)
    .filter(Boolean)
    .flatMap(map => Object.keys(map)),
)];

/**
 * Default parameters for the International Retirement scenario.
 * Any field can be overridden via the params argument to buildSim().
 */
export const INTL_RETIREMENT_DEFAULTS = {
  // People
  primaryBirthDate:     new Date(Date.UTC(1978, 3, 15)),
  spouseBirthDate:      new Date(Date.UTC(1983, 8, 22)),
  primaryMonthlyWage:   8_000,
  spouseMonthlyWage:    4_000,
  primaryRetirementDate: new Date(Date.UTC(2040, 0, 1)),
  spouseRetirementDate:  new Date(Date.UTC(2040, 0, 1)),
  moveYear:             2031,  // calendar year of US→AU move (Jul 1)

  // US Savings (primary USD cash pool)
  initialUsSavings:     30_000,
  usSavingsMinBalance:   3_000,
  usSavingsInterestRate: 0.03,
  // Fed policy ("Prime") rate (design 56). The prebuilt cash accounts auto-link to
  // Prime via a value-preserving primeSpread (usSavingsInterestRate − usPrimeRate),
  // so a Prime sweep moves them out of the box while the un-swept sim is unchanged.
  usPrimeRate:          0.045,

  // US investment accounts
  rothBalance:   80_000,  rothBasis:   60_000,
  iraBalance:   200_000,  iraBasis:   150_000,
  k401Balance:  300_000,  k401Basis:  200_000,
  stockBalance:    150_000,
  stockSplitRatio:    0.60,   // fraction of stockBalance → domestic holding
  stockBasisUS:   108_000,    // domestic cost basis — above market by default, triggers TLH
  stockBasisIntl:  42_000,    // international cost basis — below market (gain position)
  stockDividendRate:    0.02,
  stockDividendReinvest: false,
  fixedIncomeBalance:   80_000,
  fixedIncomeInterestRate: 0.04,

  // US state income tax (design 34) — null = no state configured (no state tax)
  residencyState:   null,
  // US state move (design 34 §9) — unset = no move; Jan-1 move to the destination
  stateMoveYear:        undefined,
  stateMoveDestination: null,

  // US investment growth rates (annual, separate from dividends)
  rothGrowthRate:   0.07,
  iraGrowthRate:    0.07,
  k401GrowthRate:   0.07,
  usStockGrowthRate: 0.05,
  // Gold commodity growth (design 56 §7) — seeds effectiveGrowthRates.GOLD; a GOLD
  // holding grows at this rate, decoupled from equity returns and Prime.
  goldGrowthRate:   0.05,

  // Spouse retirement accounts (US)
  spouseRothBalance:  40_000,  spouseRothBasis:  30_000,  spouseRothGrowthRate:  0.07,
  spouseIraBalance:  100_000,  spouseIraBasis:   75_000,  spouseIraGrowthRate:   0.07,
  spouseK401Balance: 150_000,  spouseK401Basis: 100_000,  spouseK401GrowthRate:  0.07,

  // Spouse retirement account (AU)
  spouseSuperBalance: 125_000,  spouseSuperBasis: 90_000,  spouseSuperGrowthRate: 0.07,

  // AU accounts
  auSavingsBalance:     50_000,
  auSavingsMinBalance:   3_000,  auSavingsInterestRate: 0.045,
  // RBA policy ("Prime") rate (design 56) — see usPrimeRate note.
  auPrimeRate:          0.0435,
  auFixedIncomeBalance:  1_000,  auFixedIncomeInterestRate: 0.04,
  superBalance:        250_000,  superBasis:           180_000,
  auStockBalance:       60_000,  auStockBasis:          40_000,
  auStockGrowthRate:   0.06,
  auStockDividendRate: 0.04,

  // International transfer
  exchangeRateUsdToAud: 1.55,  // 1 USD = 1.55 AUD
  intlTransferFeeUsd:   15,    // fixed fee per transfer in USD

  // Expenses (local currency: USD pre-move, AUD post-move)
  monthlyExpenses:       6_000,
  discretionarySharePct: 0.30,

  // Age-banded spending (design/33) — opt-in via spendingStrategy AGE_BANDED.
  spendingAgeBands:      DEFAULT_AGE_BANDS,
  ageBandSpendingSlice:  'discretionary',
  ageBandDeclineRate:    null,

  // Drawdown order (key of DRAWDOWN_STRATEGIES) used to liquidate accounts for shortfalls
  drawdownStrategy:      'TAXABLE_FIRST',
  // Per-owner drawdown banding within a strategy (design 35): PRIMARY_FIRST | SPOUSE_FIRST | POOLED
  drawdownOwnerOrdering: 'PRIMARY_FIRST',

  // Inflation rates (annual, per country)
  usInflationRate: 0.03,
  auInflationRate: 0.03,

  // Roth conversion strategy — bracket-fill policy
  rothConversionEnabled:    false,     // master switch
  rothConversionStartYear:  null,      // null = primary retirement year
  rothConversionEndYear:    null,      // null = year before primary turns 73 (RMD start)
  rothConversionMaxBracket: 0.22,      // fill up to top of this marginal bracket
  rothConversionOwner:      'primary', // 'primary' | 'spouse' | 'both'
  rothConversionMonth:      12,        // month of policy evaluation (1–12)
  rothConversionDay:        1,         // day of policy evaluation

  // US Retirement — Social Security
  primarySsClaimAge: 67,  // FRA; varying has no effect until TODO #292 is resolved

  // Real Property sale years (null = no planned sale; set to override property's own plannedSaleYear)
  usHouseSaleYear: null,
  auHouseSaleYear: null,

  // Company equity sale year (null = no planned sale)
  companySaleYear: 2033,
};

/**
 * Typed parameter schema for the International Retirement scenario.
 *
 * Describes every field from INTL_RETIREMENT_DEFAULTS that is meaningful to
 * vary across scenario saves, MonteCarlo runs, or optimization loops.
 * Fields excluded here (e.g. birthDates, basis values) are identity or
 * historical-cost data that should not be randomized.
 *
 * Each entry: { key, label, type, group, defaultValue, description }
 *   type: 'Number' | 'Date' | 'Boolean' | 'String'
 *   group: logical section used for UI grouping and MonteCarlo targeting
 */
export const INTL_RETIREMENT_PARAM_SCHEMA = [
  // ── People ─────────────────────────────────────────────────────────────────
  {
    // US state of residency (design 34). Household active state is the primary's;
    // '' / null = no state configured (no state income tax). The categorical
    // options make it an optimization/MC axis (design 34 §9).
    key: 'residencyState', label: 'US Residency State',
    type: 'Enum', options: ['', 'NE', 'HI', 'SD'], group: 'US Tax', mc: true, opt: true,
    defaultValue: INTL_RETIREMENT_DEFAULTS.residencyState ?? '',
    description: 'US state of residency for state income tax (NE, HI, SD). Blank = none.',
    node: { type: 'person', id: 'primary', field: 'residencyState' },
  },

  // ── US Account Balances ────────────────────────────────────────────────────
  // Per-record balance params (initialUsSavings, rothBalance, iraBalance,
  // k401Balance, stockBalance, fixedIncomeBalance) are now generated from the
  // account records (design 55); only the derived stock split/basis knobs remain.
  {
    key: 'stockSplitRatio', label: 'Stock Domestic Split (0–1)',
    type: 'Number', group: 'US Account Balances', mc: false, opt: true,
    defaultValue: INTL_RETIREMENT_DEFAULTS.stockSplitRatio,
    description: 'Fraction of US stock balance allocated to the domestic equity holding (remainder goes to international). Default 0.6 = 60/40.',
  },
  {
    key: 'stockBasisUS', label: 'Stock Basis — Domestic (USD)',
    type: 'Number', group: 'US Account Balances', mc: false, opt: true,
    defaultValue: INTL_RETIREMENT_DEFAULTS.stockBasisUS,
    description: 'Cost basis for the domestic equity holding. Default exceeds market value so TLH fires immediately when enabled.',
  },
  {
    key: 'stockBasisIntl', label: 'Stock Basis — International (USD)',
    type: 'Number', group: 'US Account Balances', mc: false, opt: true,
    defaultValue: INTL_RETIREMENT_DEFAULTS.stockBasisIntl,
    description: 'Cost basis for the international equity holding. Default is below market value (gain position, TaxGainHarvest candidate).',
  },

  // AU + Spouse per-record balances (auSavingsBalance, superBalance,
  // auStockBalance, spouse{Roth,Ira,K401,Super}Balance) are generated from their
  // account records (design 55). Their growth rates remain global params below.

  // ── Spouse Account Rates ───────────────────────────────────────────────────
  {
    key: 'spouseRothGrowthRate', label: 'Spouse Roth IRA Growth Rate',
    type: 'Number', group: 'Spouse Account Rates', mc: true, opt: false,
    defaultValue: INTL_RETIREMENT_DEFAULTS.spouseRothGrowthRate,
    description: 'Annual growth rate for spouse Roth IRA',
  },
  {
    key: 'spouseIraGrowthRate', label: 'Spouse Traditional IRA Growth Rate',
    type: 'Number', group: 'Spouse Account Rates', mc: true, opt: false,
    defaultValue: INTL_RETIREMENT_DEFAULTS.spouseIraGrowthRate,
    description: 'Annual growth rate for spouse Traditional IRA',
  },
  {
    key: 'spouseK401GrowthRate', label: 'Spouse 401(k) Growth Rate',
    type: 'Number', group: 'Spouse Account Rates', mc: true, opt: false,
    defaultValue: INTL_RETIREMENT_DEFAULTS.spouseK401GrowthRate,
    description: 'Annual growth rate for spouse 401(k)',
  },
  {
    key: 'spouseSuperGrowthRate', label: 'Spouse Super Growth Rate',
    type: 'Number', group: 'Spouse Account Rates', mc: true, opt: false,
    defaultValue: INTL_RETIREMENT_DEFAULTS.spouseSuperGrowthRate,
    description: 'Annual growth rate for spouse superannuation',
  },

  // ── US Retirement ─────────────────────────────────────────────────────────
  {
    key: 'primarySsClaimAge', label: 'Primary SS Claim Age',
    type: 'Number', group: 'US Retirement', mc: false, opt: true,
    defaultValue: INTL_RETIREMENT_DEFAULTS.primarySsClaimAge,
    description: 'Age at which primary claims Social Security (62–70). Note: only age 67 (FRA) is modelled until TODO #292 is resolved.',
  },

  // Min-balance (cash floor) params are generated per-account from the
  // SAVINGS/CHECKING template (design 55 §7/§13) so the floor travels with the
  // flagged transaction account. The old global usSavingsMinBalance /
  // auSavingsMinBalance keys retire behind aliases (see INTL_RETIREMENT_PARAM_ALIASES).

  // Real-property value / appreciation / sale-year params are generated from the
  // property records (design 55). companySaleYear stays static until the
  // company-equity template is populated (Phase 4).

  // ── Company Equity ───────────────────────────────────────────────────────
  {
    key: 'companySaleYear', label: 'Company Sale Year',
    type: 'Number', group: 'Company Equity', mc: false, opt: false,
    defaultValue: INTL_RETIREMENT_DEFAULTS.companySaleYear,
    description: 'Calendar year the company equity stake is sold (null = no planned sale)',
    node: { type: 'companyEquity', stateKey: 'companyEquityAccount', field: 'plannedSaleYear' },
  },

  // ── Spending ───────────────────────────────────────────────────────────────
  {
    key: 'drawdownStrategy', label: 'Drawdown Strategy',
    type: 'Enum', group: 'Spending', options: Object.keys(DRAWDOWN_STRATEGIES),
    // The selectable set is the built-in strategies plus any user-authored ones
    // in `customDrawdownStrategies`; the Scenario dropdown merges those names in
    // live (see scenario-tab-view Enum rendering).
    dynamicOptionsFrom: 'customDrawdownStrategies',
    mc: false, opt: true, defaultValue: INTL_RETIREMENT_DEFAULTS.drawdownStrategy,
    description: 'Order accounts are liquidated to cover spending shortfalls',
    // customStrategiesKey lets the cascade merge user-authored strategies (stored
    // in that param) into `strategies` before resolving the selected name.
    // ownerModeKey/ownerModes parameterize the per-owner banding (design 35): the
    // selected `drawdownOwnerOrdering` mode overrides ownerOrder/ownerStride. The
    // bare ownerOrder/ownerStride remain as PRIMARY_FIRST fallbacks.
    node: { type: 'accountPriority', strategies: DRAWDOWN_STRATEGIES,
            customStrategiesKey: 'customDrawdownStrategies',
            ownerOrder: ['primary', 'spouse'], ownerStride: 100,
            ownerModeKey: 'drawdownOwnerOrdering',
            ownerModes: {
              PRIMARY_FIRST: { ownerOrder: ['primary', 'spouse'], ownerStride: 100 },
              SPOUSE_FIRST:  { ownerOrder: ['spouse', 'primary'], ownerStride: 100 },
              POOLED:        { ownerStride: 0 },
            } },
  },
  {
    // Per-owner drawdown banding (design 35). Read by the drawdownStrategy node's
    // accountPriority cascade (ownerModeKey), so this param carries no node of its
    // own. PRIMARY_FIRST keeps the legacy behavior (primary's accounts drain fully
    // before the spouse's); POOLED treats same-role accounts across owners as one
    // tier so neither owner's bucket of a given role is starved.
    key: 'drawdownOwnerOrdering', label: 'Drawdown Owner Ordering',
    type: 'Enum', group: 'Spending',
    options: ['PRIMARY_FIRST', 'SPOUSE_FIRST', 'POOLED'],
    mc: false, opt: false, defaultValue: INTL_RETIREMENT_DEFAULTS.drawdownOwnerOrdering,
    description: 'How accounts owned by different people are ordered within a drawdown strategy. ' +
      'PRIMARY_FIRST: drain the primary\'s accounts entirely before the spouse\'s. ' +
      'SPOUSE_FIRST: the reverse. ' +
      'POOLED: same-role accounts across owners share one priority tier (e.g. both Roths drawn together in the strategy\'s role order).',
  },
  {
    // User-authored drawdown strategies (by role → rank). Each entry is
    // { name, roles: { <role>: <order> } } and becomes selectable as a
    // Drawdown Strategy (Scenario) and a sweep value (Optimize). `options`
    // carries the drawdown-eligible roles the editor renders a rank input for.
    key: 'customDrawdownStrategies', label: 'Custom Drawdown Strategies',
    type: 'DrawdownStrategyList', group: 'Spending',
    options: DRAWDOWN_ROLES, mc: false, opt: false, defaultValue: [],
    description: 'Define named by-role drawdown orderings, then select one above or sweep them in Optimize',
  },

  // ── Optimization planning targets (design 38 §5.2, Q5) ──────────────────────
  {
    // First-class scenario param so it round-trips (design 15) and is reusable
    // by the MPC terminal cost (design 39). Consumed by the DIE_WITH_TARGET
    // objective; inert otherwise.
    key: 'terminalWealthTarget', label: 'Terminal Wealth Target (today\'s USD)',
    type: 'Number', group: 'Optimization', mc: false, opt: false,
    defaultValue: 0,
    description: 'Net worth to land on at the end of plan ("die with zero, or with $XX"), in REAL base-year (today\'s) dollars. The Die With Target objective deflates the nominal terminal wealth by accumulated inflation before comparing, so this matches the real consumption it trades against.',
  },
  {
    key: 'terminalWealthTargetPenalty', label: 'Terminal Wealth Penalty (λ)',
    type: 'Number', group: 'Optimization', mc: false, opt: false,
    defaultValue: 10,
    description: 'Penalty weight on missing the terminal wealth target; larger makes the target binding (Die With Target objective).',
  },

  // ── After-tax re-pricing rates (design/40 — Option A configured effective
  //    rates). Consumed by the after-tax net-worth/liquidity metrics so the Roth
  //    conversion lever has a gradient; inert for nominal objectives. Phase 3
  //    replaces these with a liquidation-waterfall through the tax engine.
  {
    key: 'afterTaxOrdinaryRate', label: 'After-Tax Ordinary Rate (US)',
    type: 'Number', group: 'Optimization', mc: false, opt: false,
    defaultValue: 0.22,
    description: 'Assumed effective ordinary-income rate to liquidate a US pre-tax IRA/401(k) dollar (after-tax net-worth metric, design 40).',
  },
  {
    key: 'afterTaxOrdinaryRateAu', label: 'After-Tax Ordinary Rate (AU/super)',
    type: 'Number', group: 'Optimization', mc: false, opt: false,
    defaultValue: 0.15,
    description: 'Assumed effective rate to liquidate an AU pre-tax / superannuation dollar (after-tax net-worth metric, design 40).',
  },
  {
    key: 'afterTaxCapGainsRate', label: 'After-Tax Cap-Gains Rate',
    type: 'Number', group: 'Optimization', mc: false, opt: false,
    defaultValue: 0.15,
    description: 'Assumed effective long-term capital-gains rate on unrealized brokerage gains (after-tax net-worth metric, design 40).',
  },
  {
    key: 'assumedGainFraction', label: 'Assumed Gain Fraction',
    type: 'Number', group: 'Optimization', mc: false, opt: false,
    defaultValue: 0.5,
    description: 'Fraction of a taxable balance treated as unrealized gain when per-lot cost basis is unavailable (after-tax net-worth metric, design 40).',
  },
  {
    key: 'afterTaxRateMethod', label: 'After-Tax Rate Method',
    type: 'Enum', group: 'Optimization', mc: false, opt: false,
    options: ['configured', 'liquidation'],
    defaultValue: 'configured',
    description: 'How the after-tax metrics price the embedded liquidation tax: "configured" uses fixed effective rates; "liquidation" stacks the balance through the real tax engine for an effective rate (design 40 Phase 3, US accounts).',
  },

];

/**
 * Design 55 §11: map retired per-record param keys → their generated equivalents.
 * `ScenarioLoader._applyParamAliases` consults this so saved scenarios and MC/Opt
 * configs that still reference the old flat keys (`rothBalance`, `usHouseSaleYear`,
 * …) keep working after the static entries were removed above. The generated key's
 * `node` is byte-identical to the old one, so the param→record cascade is unchanged.
 * Aliases can be dropped after a deprecation window.
 */
export const INTL_RETIREMENT_PARAM_ALIASES = Object.freeze({
  // People
  primaryRetirementDate: 'person.primary.retirementDate',
  spouseRetirementDate:  'person.spouse.retirementDate',
  primaryMonthlyWage:    'person.primary.monthlyWage',
  spouseMonthlyWage:     'person.spouse.monthlyWage',
  // US account balances
  initialUsSavings:      'acct.usSavingsAccount.balance',
  rothBalance:           'acct.rothAccount.balance',
  iraBalance:            'acct.iraAccount.balance',
  k401Balance:           'acct.k401Account.balance',
  stockBalance:          'acct.usStockAccount.balance',
  fixedIncomeBalance:    'acct.fixedIncomeAccount.balance',
  // AU account balances
  auSavingsBalance:      'acct.auSavingsAccount.balance',
  superBalance:          'acct.superAccount.balance',
  auStockBalance:        'acct.auStockAccount.balance',
  // Spouse account balances
  spouseRothBalance:     'acct.spouseRothAccount.balance',
  spouseIraBalance:      'acct.spouseIraAccount.balance',
  spouseK401Balance:     'acct.spouseK401Account.balance',
  spouseSuperBalance:    'acct.spouseSuperAccount.balance',
  // Real property
  usHouseSaleYear:       'prop.usHouseProperty.plannedSaleYear',
  auHouseSaleYear:       'prop.auHouseProperty.plannedSaleYear',
  // Cash floors (design 55 §7/§13) — now per-account on the canonical savings accounts
  usSavingsMinBalance:   'acct.usSavingsAccount.minimumBalance',
  auSavingsMinBalance:   'acct.auSavingsAccount.minimumBalance',
});

/**
 * IntlRetirementScenario — International two-person retirement simulation.
 *
 * Two people (primary + spouse), US→AU migration on Jul 1 of moveYear.
 * Wired entirely through the toolset compiler path (Path 2 in BaseApp):
 * getToolsets() declares all 11 toolsets; buildDefaultConfig() produces the
 * serialized persons/accounts/realProperties/collectibles for a fresh load.
 */
export class IntlRetirementScenario extends BaseScenario {
  static scenarioId()   { return 'intl-retirement'; }
  static scenarioName() { return 'International Retirement'; }

  static instantiate(params, simStart, simEnd) {
    return new IntlRetirementScenario({
      context: ServiceRegistry.getInstance().simulationContext,
      params,
      simStart,
      simEnd,
    });
  }

  static getParamSchema() { return INTL_RETIREMENT_PARAM_SCHEMA; }

  /** Design 55 §11: legacy param key → generated key, for back-compat migration. */
  static getParamAliases() { return INTL_RETIREMENT_PARAM_ALIASES; }

  /**
   * Full param schema: scenario-level params merged with all toolset paramSchema
   * entries (deduplicating by key). Use this when you need the complete set of
   * configurable params for UI pickers (e.g. Decision Graph, Optimization).
   */
  static buildFullParamSchema() {
    const scenarioKeys = new Set(INTL_RETIREMENT_PARAM_SCHEMA.map(e => e.key));
    const toolsets = [
      US_BANKING, US_TAX, US_STATE_TAX, US_BROKERAGE, US_INCOME, US_RETIREMENT,
      AU_BANKING, AU_TAX, AU_BROKERAGE, AU_INCOME, AU_RETIREMENT,
      US_AU_CROSS_BORDER, US_REAL_PROPERTY, AU_REAL_PROPERTY,
      US_COLLECTIBLES, US_ROTH_CONVERSION, US_EARLY_WITHDRAWAL, US_COMPANY_SALE, ECONOMIC_REGIMES,
    ];
    const toolsetParams = toolsets
      .flatMap(t => t.paramSchema?.({}) ?? [])
      .filter(e => e?.key && !scenarioKeys.has(e.key));
    return [...INTL_RETIREMENT_PARAM_SCHEMA, ...toolsetParams];
  }

  static getToolsets() {
    return [
      'US_BANKING', 'US_TAX', 'US_STATE_TAX', 'US_BROKERAGE', 'US_INCOME', 'US_RETIREMENT',
      'AU_BANKING', 'AU_TAX', 'AU_BROKERAGE', 'AU_INCOME', 'AU_RETIREMENT',
      'US_AU_CROSS_BORDER',
      'US_REAL_PROPERTY', 'AU_REAL_PROPERTY',
      'US_COLLECTIBLES', 'US_ROTH_CONVERSION', 'US_EARLY_WITHDRAWAL',
      'US_COMPANY_SALE',
      'ECONOMIC_REGIMES',
    ];
  }

  /**
   * Build a declarative config that ScenarioCompiler can consume for a fresh
   * prebuilt load.  Produces serialized persons/accounts/realProperties/collectibles
   * (with stable stateKeys) plus a parameters map aligned to toolset param keys.
   */
  static buildDefaultConfig(params = {}, simStart, simEnd) {
    const p = { ...INTL_RETIREMENT_DEFAULTS, ...params };
    const toDate = v => (v instanceof Date ? v : new Date(v));
    p.primaryBirthDate      = toDate(p.primaryBirthDate);
    p.spouseBirthDate       = toDate(p.spouseBirthDate);
    p.primaryRetirementDate = toDate(p.primaryRetirementDate);
    p.spouseRetirementDate  = toDate(p.spouseRetirementDate);

    // Design 15: emit full ISO 8601 strings for all dates. Deserializers
    // (`_makePerson`, etc.) wrap with `new Date(...)` which accepts both full
    // ISO and YYYY-MM-DD, so older payloads remain readable.
    const isoDate = d => ScenarioSerializer.toDateStr(d);

    return {
      toolsets: IntlRetirementScenario.getToolsets(),
      simStart:       ScenarioSerializer.toDateStr(simStart ?? new Date(Date.UTC(2026, 0, 1))),
      simEnd:         ScenarioSerializer.toDateStr(simEnd   ?? new Date(Date.UTC(2041, 0, 1))),

      // ── Parameters (toolset-key names) ──────────────────────────────────────
      parameters: {
        // US_STATE_TAX (design 34) — cascades onto the primary person's residencyState
        residencyState:           p.residencyState || null,
        // US_STATE_TAX state move (design 34 §9) — Jan-1 move to a destination state
        stateMoveYear:            p.stateMoveYear ?? undefined,
        stateMoveDestination:     p.stateMoveDestination || null,
        // US_BANKING
        usSavingsInterestRate:    p.usSavingsInterestRate,
        // ECONOMIC_REGIMES — central-bank Prime rates (design 56)
        usPrimeRate:              p.usPrimeRate,
        auPrimeRate:              p.auPrimeRate,
        // US_RETIREMENT / AU_RETIREMENT share 'inflationRate'; US_AU_CROSS_BORDER uses both
        inflationRate:            p.usInflationRate,
        auInflationRate:          p.auInflationRate,
        iraGrowthRate:            p.iraGrowthRate,
        rothGrowthRate:           p.rothGrowthRate,
        k401GrowthRate:           p.k401GrowthRate,
        brokerageGrowthRate:      p.usStockGrowthRate,
        goldGrowthRate:           p.goldGrowthRate,
        brokerageDividendRate:    p.stockDividendRate,
        dividendReinvest:         p.stockDividendReinvest,
        fixedIncomeInterestRate:  p.fixedIncomeInterestRate,
        monthlyExpenses:          p.monthlyExpenses,
        inflationAdjust:          true,
        // AU_BANKING
        auSavingsInterestRate:    p.auSavingsInterestRate,
        auFixedIncomeInterestRate: p.auFixedIncomeInterestRate,
        // AU_RETIREMENT
        superGrowthRate:          p.spouseSuperGrowthRate ?? 0.07,
        auStockGrowthRate:        p.auStockGrowthRate,
        auStockDividendRate:      p.auStockDividendRate,
        // Mortality — per-person lifespan seed for MC actuarial draws (design/27 Step 15).
        // The 'people' map mirrors context.people but lives in parameters so set()
        // can overwrite individual lifeExpectancy values per MC iteration.
        people: {
          primary: {
            name: 'Primary', residency: 'US', sex: 'M',
            residencyState: p.residencyState || null,
            lifeExpectancy: p.primaryLifeExpectancy ?? 90,
          },
          spouse: {
            name: 'Spouse', residency: 'US', sex: 'F',
            residencyState: p.residencyState || null,
            lifeExpectancy: p.spouseLifeExpectancy ?? 90,
          },
        },
        // US_AU_CROSS_BORDER
        moveYear:                 p.moveYear,
        exchangeRateUsdToAud:     p.exchangeRateUsdToAud,
        intlTransferFeeUsd:       p.intlTransferFeeUsd,
        startingResidency:        'US',
        // US_ROTH_CONVERSION
        rothConversionEnabled:    p.rothConversionEnabled,
        rothConversionStartYear:  p.rothConversionStartYear,
        rothConversionEndYear:    p.rothConversionEndYear,
        rothConversionMaxBracket: p.rothConversionMaxBracket,
        rothConversionOwner:      p.rothConversionOwner,
        rothConversionMonth:      p.rothConversionMonth,
        rothConversionDay:        p.rothConversionDay,
      },

      // ── Persons ─────────────────────────────────────────────────────────────
      persons: [
        {
          __type: 'Person', id: 'primary', name: 'Primary',
          birthDate:      isoDate(p.primaryBirthDate),
          citizen:        ['US'],
          residencyState: p.residencyState || null,
          monthlyWage:    p.primaryMonthlyWage,
          retirementDate: isoDate(p.primaryRetirementDate),
          lifeExpectancy: 90, socialSecurityMonthly: 2000,
        },
        {
          __type: 'Person', id: 'spouse', name: 'Spouse',
          birthDate:      isoDate(p.spouseBirthDate),
          citizen:        ['US'],
          residencyState: p.residencyState || null,   // spouse defaults to the primary's state (design 34 §4)
          monthlyWage:    p.spouseMonthlyWage,
          retirementDate: isoDate(p.spouseRetirementDate),
          lifeExpectancy: 90, socialSecurityMonthly: 1000,
        },
      ],

      // ── Accounts ─────────────────────────────────────────────────────────────
      // stateKey is included so deserializePersonsAccounts stamps it on the account
      // before ScenarioCompiler reads it from accountService.getAll().
      accounts: [
        {
          __type: 'SavingsAccount',       stateKey: 'usSavingsAccount',
          name: 'US Savings',             role: ACCOUNT_ROLES.US_SAVINGS,
          balance: p.initialUsSavings, ownershipType: 'joint', ownerId: 'primary',
          minimumBalance: p.usSavingsMinBalance, country: 'US', currency: USD,
          // Prime-linked (design 56 §11) — value-preserving spread so effective =
          // Prime + spread = usSavingsInterestRate today, but a Prime sweep moves it.
          primeSpread: p.usSavingsInterestRate - p.usPrimeRate,
          // Cash band: spent before investments (down to minimumBalance). The
          // active spending target is excluded as a source at runtime regardless.
          drawdownPriority: 0,
        },
        {
          __type: 'BrokerageAccount',              stateKey: 'fixedIncomeAccount',
          name: 'Fixed Income',           role: ACCOUNT_ROLES.FIXED_INCOME,
          balance: p.fixedIncomeBalance, ownerId: 'primary',
          drawdownPriority: 1,            contributionBasis: 0,
          country: 'US', currency: USD,
        },
        {
          __type: 'BrokerageAccount',     stateKey: 'usStockAccount',
          name: 'US Stock',               role: ACCOUNT_ROLES.US_STOCK,
          balance: p.stockBalance,
          contributionBasis: (p.stockBasisUS ?? 0) + (p.stockBasisIntl ?? 0),
          ownerId: 'primary',             drawdownPriority: 2,
          country: 'US', currency: USD,
          holdings: _stockHoldings(p),
        },
        {
          __type: 'TraditionalIRAAccount', stateKey: 'iraAccount',
          name: 'Traditional IRA',        role: ACCOUNT_ROLES.IRA,
          balance: p.iraBalance,     contributionBasis: p.iraBasis,
          ownerId: 'primary',             drawdownPriority: 3,
          country: 'US', currency: USD,
        },
        {
          __type: 'FourOhOneKAccount',    stateKey: 'k401Account',
          name: '401(k)',                 role: ACCOUNT_ROLES.K401,
          balance: p.k401Balance,    contributionBasis: p.k401Basis,
          ownerId: 'primary',             drawdownPriority: 4,
          country: 'US', currency: USD,
        },
        {
          __type: 'RothAccount',          stateKey: 'rothAccount',
          name: 'Roth IRA',              role: ACCOUNT_ROLES.ROTH,
          balance: p.rothBalance,    contributionBasis: p.rothBasis,
          ownerId: 'primary',             drawdownPriority: 5,
          country: 'US', currency: USD,
        },
        {
          __type: 'SavingsAccount',              stateKey: 'auSavingsAccount',
          name: 'AU Savings',             role: ACCOUNT_ROLES.AU_SAVINGS,
          balance: p.auSavingsBalance, ownershipType: 'joint', ownerId: 'primary',
          minimumBalance: p.auSavingsMinBalance, country: 'AU', currency: AUD,
          // Prime-linked (design 56 §11) — value-preserving spread (see US Savings).
          primeSpread: p.auSavingsInterestRate - p.auPrimeRate,
          // Cash band: spent before investments (down to minimumBalance), and
          // repatriated cross-border when it is the non-residence cash pool.
          drawdownPriority: 0,
        },
        {
          __type: 'BrokerageAccount',     stateKey: 'auFixedIncomeAccount',
          name: 'AU Fixed Income',        role: ACCOUNT_ROLES.AU_FIXED_INCOME,
          balance: p.auFixedIncomeBalance, ownerId: 'primary',
          drawdownPriority: 1,            contributionBasis: 0,
          country: 'AU', currency: AUD,
        },
        {
          __type: 'BrokerageAccount',     stateKey: 'auStockAccount',
          name: 'AU Stock',               role: ACCOUNT_ROLES.AU_STOCK,
          balance: p.auStockBalance, contributionBasis: p.auStockBasis,
          ownerId: 'primary',             drawdownPriority: 1,
          country: 'AU', currency: AUD,
        },
        {
          __type: 'SuperannuationAccount', stateKey: 'superAccount',
          name: 'Superannuation',          role: ACCOUNT_ROLES.SUPER,
          balance: p.superBalance,   contributionBasis: p.superBasis,
          ownerId: 'primary',             drawdownPriority: 2,
          minimumAge: 60,                 country: 'AU', currency: AUD,
        },
        // Spouse accounts
        {
          __type: 'RothAccount',           stateKey: 'spouseRothAccount',
          name: 'Roth IRA (Spouse)',       role: ACCOUNT_ROLES.ROTH,
          balance: p.spouseRothBalance, contributionBasis: p.spouseRothBasis,
          ownerId: 'spouse',               drawdownPriority: 8,
          country: 'US', currency: USD,
        },
        {
          __type: 'TraditionalIRAAccount', stateKey: 'spouseIraAccount',
          name: 'Traditional IRA (Spouse)', role: ACCOUNT_ROLES.IRA,
          balance: p.spouseIraBalance, contributionBasis: p.spouseIraBasis,
          ownerId: 'spouse',               drawdownPriority: 6,
          country: 'US', currency: USD,
        },
        {
          __type: 'FourOhOneKAccount',     stateKey: 'spouseK401Account',
          name: '401(k) (Spouse)',         role: ACCOUNT_ROLES.K401,
          balance: p.spouseK401Balance, contributionBasis: p.spouseK401Basis,
          ownerId: 'spouse',               drawdownPriority: 7,
          country: 'US', currency: USD,
        },
        {
          __type: 'SuperannuationAccount', stateKey: 'spouseSuperAccount',
          name: 'Superannuation (Spouse)', role: ACCOUNT_ROLES.SUPER,
          balance: p.spouseSuperBalance, contributionBasis: p.spouseSuperBasis,
          ownerId: 'spouse',               drawdownPriority: 3,
          minimumAge: 60,                  country: 'AU', currency: AUD,
        },
      ],

      // ── Real Properties ──────────────────────────────────────────────────────
      realProperties: [
        {
          __type: 'RealProperty', name: 'US House', stateKey: 'usHouseProperty',
          value: 1_000_000, costBasis: 800_000, appreciationRate: 0.04,
          isPrimaryResidence: true, ownershipType: 'joint', ownerId: 'primary',
          country: 'US',
          ...(p.usHouseSaleYear != null ? { plannedSaleYear: p.usHouseSaleYear } : {}),
        },
        {
          __type: 'RealProperty', name: 'AU House', stateKey: 'auHouseProperty',
          value: 1_000_000, costBasis: 900_000, appreciationRate: 0.04,
          isPrimaryResidence: true, ownershipType: 'joint', ownerId: 'primary',
          country: 'AU',
          ...(p.auHouseSaleYear != null ? { plannedSaleYear: p.auHouseSaleYear } : {}),
        },
      ],

      // ── Collectibles ─────────────────────────────────────────────────────────
      collectibles: [
        {
          __type: 'Collectible', name: 'Gold', stateKey: 'collectibleAccount',
          value: 100_000, costBasis: 60_000, appreciationRate: 0.03,
          ownershipType: 'sole', ownerId: 'primary', country: 'US',
        },
      ],

      // ── Company Equity ───────────────────────────────────────────────────────
      companyEquities: [
        {
          __type: 'CompanyEquity', name: 'Startup Equity', stateKey: 'companyEquityAccount',
          value: 500_000, costBasis: 50_000, appreciationRate: 0.08,
          ownershipType: 'sole', ownerId: 'primary', country: 'US',
          saleDestinationAccount: 'usSavingsAccount',
          ...(p.companySaleYear != null ? { plannedSaleYear: p.companySaleYear } : {}),
        },
      ],
    };
  }

  /**
   * Test / programmatic convenience: reset-proof builder that constructs a
   * scenario, derives a cfg from buildDefaultConfig(params), and runs the
   * toolset compilation path. Returns the scenario.
   *
   * Design 15: production Monte Carlo and Optimization paths NO LONGER call
   * this — they clone the active scenario cfg as a template so user edits to
   * non-param fields (planned sale years, life expectancy, drawdown priority,
   * custom graph nodes) are preserved across iterations. Use this only for
   * unit tests and one-off "give me a fresh reference scenario" callers.
   *
   * Callers must call ServiceRegistry.reset() before invoking this if they
   * want an isolated simulation.
   *
   * @param {{ params?, simStart?, simEnd? }} [opts]
   * @returns {IntlRetirementScenario}
   */
  static buildAndCompile({ params = {}, simStart, simEnd } = {}) {
    const registry = ServiceRegistry.getInstance();
    const scenario = new IntlRetirementScenario({
      context: registry.simulationContext,
      params,
      simStart,
      simEnd,
    });
    scenario.buildSim();

    const cfg = IntlRetirementScenario.buildDefaultConfig(params, scenario.simStart, scenario.simEnd);

    const hasPersonsOrAccounts = (cfg?.persons?.length > 0) || (cfg?.accounts?.length > 0);
    if (hasPersonsOrAccounts) {
      ScenarioSerializer.deserializePersonsAccounts(cfg, registry);
    }

    const toolsetRegistry = new ToolsetRegistry();
    toolsetRegistry.register(US_BANKING);
    toolsetRegistry.register(US_TAX);
    toolsetRegistry.register(US_STATE_TAX);
    toolsetRegistry.register(US_RETIREMENT);
    toolsetRegistry.register(AU_BANKING);
    toolsetRegistry.register(AU_TAX);
    toolsetRegistry.register(AU_RETIREMENT);
    toolsetRegistry.register(US_AU_CROSS_BORDER);
    toolsetRegistry.register(US_REAL_PROPERTY);
    toolsetRegistry.register(AU_REAL_PROPERTY);
    toolsetRegistry.register(US_COLLECTIBLES);
    toolsetRegistry.register(US_ROTH_CONVERSION);
    toolsetRegistry.register(US_EARLY_WITHDRAWAL);
    toolsetRegistry.register(US_BROKERAGE);
    toolsetRegistry.register(AU_BROKERAGE);
    toolsetRegistry.register(US_INCOME);
    toolsetRegistry.register(AU_INCOME);
    toolsetRegistry.register(US_COMPANY_SALE);
    toolsetRegistry.register(ECONOMIC_REGIMES);
    new ScenarioCompiler(toolsetRegistry).compile(cfg, registry);

    // Sync initialState with the compiled sim.state so serializers and round-trip
    // tests get the correct populated state (account balances, currentPeriods, etc.).
    scenario.initialState = { ...scenario.sim.state };

    return scenario;
  }

  constructor({ context, params, simStart, simEnd } = {}) {
    super({
      context,
      params,
      simStart: simStart ?? new Date(Date.UTC(2026, 0, 1)),
      simEnd:   simEnd ?? new Date(Date.UTC(2041, 0, 1)),
    });
  }
}

/**
 * Patch real property sale year params into a serialized scenario cfg.
 *
 * When MC or OPT perturbs usHouseSaleYear / auHouseSaleYear, the perturbed
 * value lives in params but the toolsets read from cfg.realProperties[i].plannedSaleYear.
 * This function bridges that gap: it finds each property by stateKey and
 * overwrites its plannedSaleYear when the corresponding param is non-null.
 *
 * Rounding to integer guards against floating-point samples from NORMAL distributions.
 *
 * @param {object} cfg    - Mutable clone of the serialized scenario config.
 * @param {object} params - Perturbed parameter map.
 */
/**
 * Build the two-holding seed for usStockAccount.
 *
 * Domestic holding (rateKey EQUITY_US): stockSplitRatio × stockBalance, basis = stockBasisUS.
 * International holding (rateKey EQUITY_US): remainder, basis = stockBasisIntl.
 *
 * Both use EQUITY_US so the TLH substitute-selection algorithm auto-selects the
 * other holding (first sibling with the same rateKey). By default the domestic
 * holding is above basis (loss position) and the international holding is below
 * basis (gain position), so TLH fires immediately when enabled.
 */
function _stockHoldings(p) {
  const ratio   = Math.min(1, Math.max(0, p.stockSplitRatio ?? 0.60));
  const total   = p.stockBalance ?? 0;
  const usMv    = +((total * ratio).toFixed(2));
  const intlMv  = +((total - usMv).toFixed(2));
  return [
    new Holding({
      id:          'h-us-equity',
      label:       'US Equity (Domestic)',
      allocation:  ALLOCATION.EQUITY,
      rateKey:     RATE_KEYS.EQUITY_US,
      marketValue: usMv,
      costBasis:   p.stockBasisUS   ?? 108_000,
    }),
    new Holding({
      id:          'h-intl-equity',
      label:       'US Equity (International)',
      allocation:  ALLOCATION.EQUITY,
      rateKey:     RATE_KEYS.EQUITY_US,
      marketValue: intlMv,
      costBasis:   p.stockBasisIntl ?? 42_000,
    }),
  ];
}

export function applyRealPropertySaleYearParams(cfg, params) {
  if (!Array.isArray(cfg.realProperties)) return;
  for (const prop of cfg.realProperties) {
    if (prop.stateKey === 'usHouseProperty' && params.usHouseSaleYear != null) {
      prop.plannedSaleYear = Math.round(params.usHouseSaleYear);
    } else if (prop.stateKey === 'auHouseProperty' && params.auHouseSaleYear != null) {
      prop.plannedSaleYear = Math.round(params.auHouseSaleYear);
    }
  }
}
