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
import { INHERITANCE }         from './toolsets/inheritance-toolset.js';
import { ECONOMIC_REGIMES }    from './toolsets/economic-regimes-toolset.js';
import { ServiceRegistry }     from '../services/service-registry.js';
import { USD, AUD }            from '../finance/assets/account.js';
import { ACCOUNT_ROLES }       from '../finance/state/account-roles.js';
import { Holding }             from '../finance/holdings/holding.js';
import { ALLOCATION, totalizeMix } from '../finance/holdings/allocation.js';
import { SLEEVE_ORDER_MODES, LOT_STRATEGIES, DRAWDOWN_SLEEVE_CLASSES,
         SLEEVE_WEIGHT_MODE, sleeveWeightKey } from '../finance/holdings/holdings-selection.js';
import { DEFAULT_AGE_BANDS }   from '../finance/spending/strategies/age-banded-spending-reducer.js';
import { RATE_KEYS, ROLE_TO_RATE_KEY } from '../finance/economic-regimes/rate-keys.js';
import { EQUITY_MARKETS_BY_COUNTRY }  from '../finance/holdings/default-allocations.js';
import { toolsetParamKeys, forwardToolsetOverrides } from './toolset-param-forwarding.js';
import { US_STATE_CODES }      from '../finance/tax/state/us-states.js';

/*
 * Design 81 phase 2 — the drawdown-order (Lever B) and allocation-mix (Lever A) weight
 * vocabulary MOVED to `./params/lever-weights.js`, a leaf, and re-exported here so every
 * existing import site is unchanged. The move is not tidying: this module imports every
 * toolset, `us-retirement-toolset.js` imports `MpcDecisionScheduleReducer` →
 * `lever-schedule.js`, and design 81's `applyAt` hooks need these constants — so leaving
 * them here closed an import cycle that breaks four entry points with a TDZ error at
 * import time. See that file's header for the measurement.
 */
import {
  DRAWDOWN_STRATEGIES, DRAWDOWN_ROLES, DRAWDOWN_WEIGHT_MODE, DRAWDOWN_WEIGHT_PREFIX,
  DRAWDOWN_WEIGHT_SEP, drawdownWeightKey, DRAWDOWN_WEIGHT_ROLES, DRAWDOWN_CASH_ROLES,
  DRAWDOWN_ROLE_LABELS, presentDrawdownWeightRoles, drawdownWeightsFromStrategy,
  DEFAULT_DRAWDOWN_WEIGHTS, synthesizeWeightedPriorities, ALLOCATION_OPTIMIZED_MODE,
  ALLOC_WEIGHT_CLASSES, ALLOC_WEIGHT_PREFIX, ALLOC_WEIGHT_SEP, allocWeightKey,
  ALLOC_WEIGHT_CLASS_LABELS, ALLOCATION_PRESETS, DEFAULT_ALLOC_WEIGHTS,
  synthesizeTargetAllocation, allocWeightsFromMix, allocWeightsFromPreset, presentAllocations,
} from './params/lever-weights.js';

export {
  DRAWDOWN_STRATEGIES, DRAWDOWN_ROLES, DRAWDOWN_WEIGHT_MODE, DRAWDOWN_WEIGHT_PREFIX,
  DRAWDOWN_WEIGHT_SEP, drawdownWeightKey, DRAWDOWN_WEIGHT_ROLES, DRAWDOWN_CASH_ROLES,
  DRAWDOWN_ROLE_LABELS, presentDrawdownWeightRoles, drawdownWeightsFromStrategy,
  DEFAULT_DRAWDOWN_WEIGHTS, synthesizeWeightedPriorities, ALLOCATION_OPTIMIZED_MODE,
  ALLOC_WEIGHT_CLASSES, ALLOC_WEIGHT_PREFIX, ALLOC_WEIGHT_SEP, allocWeightKey,
  ALLOC_WEIGHT_CLASS_LABELS, ALLOCATION_PRESETS, DEFAULT_ALLOC_WEIGHTS,
  synthesizeTargetAllocation, allocWeightsFromMix, allocWeightsFromPreset, presentAllocations,
} from './params/lever-weights.js';


/**
 * Build the per-role `drawdownWeight.<role>` param-schema entries (design 58 §4-B).
 * Continuous [0,1] Number params, opt-swept, gated on `drawdownStrategy=WEIGHTED`.
 */
export function buildDrawdownWeightSchema() {
  return DRAWDOWN_WEIGHT_ROLES.map(role => ({
    key: drawdownWeightKey(role),
    label: `Drawdown Weight — ${DRAWDOWN_ROLE_LABELS[role] ?? role}`,
    type: 'Number', group: 'Spending',
    min: 0, max: 1, step: 0.05,
    mc: false, opt: true,
    defaultValue: DEFAULT_DRAWDOWN_WEIGHTS[role],
    // Only meaningful under the WEIGHTED strategy — hide/skip otherwise.
    visibleWhen: { param: 'drawdownStrategy', equals: DRAWDOWN_WEIGHT_MODE },
    description: `Drawdown weight for ${DRAWDOWN_ROLE_LABELS[role] ?? role} accounts ` +
      `(0–1; lower = drawn earlier). Active only when Drawdown Strategy is WEIGHTED; ` +
      `the draw order is the ascending sort of all role weights. Same-role siblings ` +
      `share this weight (one tier).`,
  }));
}

/** Flat map of the default `drawdownWeight::<role>` param key → value. */
export const DEFAULT_DRAWDOWN_WEIGHT_PARAMS = Object.fromEntries(
  Object.entries(DEFAULT_DRAWDOWN_WEIGHTS).map(
    ([role, w]) => [drawdownWeightKey(role), w]));

// ─── Design 65 — allocation-aware drawdown (which sleeve/lots to sell) ─────────
// The Lever-A weight-key helpers (SLEEVE_WEIGHT_PREFIX/SEP/MODE, sleeveWeightKey)
// live in holdings-selection.js so the toolset projection can import them without a
// circular scenario↔toolset dependency; the schema/defaults below stay here.

/**
 * Default per-class sleeve weights — seeded so that the WEIGHTED mode's ascending
 * sort reproduces the TAX_COST order (CASH→BOND→EQUITY→GOLD). Only consulted when
 * `drawdownSleeveOrder === 'WEIGHTED'`; the default is FIFO, so existing scenarios
 * are unaffected (byte-identical).
 */
export const DEFAULT_SLEEVE_WEIGHTS = Object.freeze({
  [ALLOCATION.CASH]:   0.2,
  [ALLOCATION.BOND]:   0.4,
  [ALLOCATION.EQUITY]: 0.6,
  [ALLOCATION.GOLD]:   0.8,
});

/**
 * Build the per-class `sleeveWeight::<CLASS>` param-schema entries (design 65 §4-A).
 * Continuous [0,1] Number params, opt-swept, gated on `drawdownSleeveOrder=WEIGHTED`.
 */
export function buildSleeveWeightSchema() {
  return DRAWDOWN_SLEEVE_CLASSES.map(cls => ({
    key: sleeveWeightKey(cls),
    label: `Sleeve Weight — ${cls}`,
    type: 'Number', group: 'Spending',
    min: 0, max: 1, step: 0.05,
    mc: false, opt: true,
    defaultValue: DEFAULT_SLEEVE_WEIGHTS[cls],
    visibleWhen: { param: 'drawdownSleeveOrder', equals: SLEEVE_WEIGHT_MODE },
    description: `Drawdown sleeve weight for the ${cls} allocation ` +
      `(0–1; lower = sold earlier for a spending debit). Active only when Drawdown ` +
      `Sleeve Order is WEIGHTED; the sell order is the ascending sort of all sleeve weights.`,
  }));
}

/** Flat map of the default `sleeveWeight::<CLASS>` param key → value. */
export const DEFAULT_SLEEVE_WEIGHT_PARAMS = Object.fromEntries(
  DRAWDOWN_SLEEVE_CLASSES.map(cls => [sleeveWeightKey(cls), DEFAULT_SLEEVE_WEIGHTS[cls]]));



/**
 * Build the per-class `allocWeight::<CLASS>` param-schema entries (design 61 §4-A).
 * Continuous [0,1] Number params, opt-swept, gated on `allocationStrategy=OPTIMIZED`
 * AND the `TARGET_ALLOCATION` behavioral strategy being selected. One entry per
 * NON-residual class (the last class in ALLOC_WEIGHT_CLASSES is the stick-breaking
 * residual and carries no param).
 */
export function buildAllocWeightSchema() {
  const warmStart = allocWeightsFromMix(DEFAULT_ALLOC_WEIGHTS);
  // Every class except the residual (last) gets a searchable weight.
  return ALLOC_WEIGHT_CLASSES.slice(0, -1).map(cls => ({
    key: allocWeightKey(cls),
    label: `Allocation Weight — ${ALLOC_WEIGHT_CLASS_LABELS[cls] ?? cls}`,
    type: 'Number', group: 'Allocation',
    min: 0, max: 1, step: 0.05,
    mc: false, opt: true,
    defaultValue: warmStart[allocWeightKey(cls)],
    // Only meaningful when the allocation lever is selected AND its strategy is
    // OPTIMIZED — hide otherwise (the second clause alone would leak into scenarios
    // that never selected TARGET_ALLOCATION if allocationStrategy were left OPTIMIZED).
    visibleWhen: [
      { param: 'behavioralStrategies', includes: 'TARGET_ALLOCATION' },
      { param: 'allocationStrategy',   equals:   ALLOCATION_OPTIMIZED_MODE },
    ],
    description: `Stick-breaking weight for the ${ALLOC_WEIGHT_CLASS_LABELS[cls] ?? cls} ` +
      `sleeve (0–1). Active only when Allocation Strategy is OPTIMIZED. The applied ` +
      `target mix is synthesized from all class weights and always sums to 1; ` +
      `${ALLOC_WEIGHT_CLASS_LABELS[ALLOC_WEIGHT_CLASSES.at(-1)]} is the residual.`,
  }));
}

/** Flat map of the default `allocWeight::<CLASS>` param key → value. */
export const DEFAULT_ALLOC_WEIGHT_PARAMS = allocWeightsFromMix(DEFAULT_ALLOC_WEIGHTS);

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
  stockBalance:    150_000,   // 60% equity / 40% bond (design 66 §G3)
  stockSplitRatio:    0.60,   // fraction of the EQUITY book → domestic holding
  stockBasisUS:    65_000,    // domestic cost basis — above market (loss position, triggers TLH)
  stockBasisIntl:  25_000,    // international cost basis — below market (gain position)
  stockDividendReinvest: false,
  fixedIncomeBalance:   80_000,
  fixedIncomeInterestRate: 0.04,

  // US state income tax (design 34) — null = no state configured (no state tax)
  residencyState:   null,
  // US state move (design 34 §9) — unset = no move; Jan-1 move to the destination
  stateMoveYear:        undefined,
  stateMoveDestination: null,

  // Equity growth: no per-account rates since design 99 P2 — every equity holding earns
  // its market's total return (the economic-regimes toolset's Market Rates).
  // Gold commodity growth (design 56 §7) — seeds effectiveGrowthRates.GOLD; a GOLD
  // holding grows at this rate, decoupled from equity returns and Prime.
  goldGrowthRate:   0.05,

  // Equity market MIX (design 90 §7.3) — the international share of every equity
  // account of that domicile, as a fraction. This is the sub-axis under
  // ALLOCATION.EQUITY: the four-value allocation enum is untouched, and this splits
  // whatever lands in EQUITY between the domestic market and the matching
  // international basket (ex-US for a US account, ex-AU for an AU one).
  //
  // **0 is the byte-identical default**, not a modelling claim: it reproduces the
  // single domestic sleeve every account bootstrapped before the axis existed. It is
  // deliberately NOT set to a realistic 30-40% here, because doing so would re-rate
  // every scenario in the same commit that introduced the mechanism and make the two
  // effects impossible to separate.
  //
  // SUPER is the exception (design 99 P5c): with no stamped mix it takes the APRA
  // MySuper split (DEFAULT_EQUITY_MARKET_MIX_BY_ROLE). A share > 0 here still stamps
  // every AU equity account, super included, and so overrides that default.
  usEquityIntlShare: 0,
  auEquityIntlShare: 0,

  // Spouse retirement accounts (US). No growth rates of their own: since design 99 an
  // account earns the markets its holdings track (MARKET_GROWTH_PARAMS), whoever owns it.
  // See the retired spouse*GrowthRate aliases below (design/inconsistencies §4.10).
  spouseRothBalance:  40_000,  spouseRothBasis:  30_000,
  spouseIraBalance:  100_000,  spouseIraBasis:   75_000,
  spouseK401Balance: 150_000,  spouseK401Basis: 100_000,

  // Spouse retirement account (AU) — earns the AU and ex-AU markets' totals, on super's
  // default APRA mix (design 99 P5c), like the primary's.
  spouseSuperBalance: 125_000,  spouseSuperBasis: 90_000,

  // AU accounts
  auSavingsBalance:     50_000,
  auSavingsMinBalance:   3_000,  auSavingsInterestRate: 0.045,
  // RBA policy ("Prime") rate (design 56) — see usPrimeRate note.
  auPrimeRate:          0.0435,
  auFixedIncomeBalance:  1_000,  auFixedIncomeInterestRate: 0.04,
  superBalance:        250_000,  superBasis:           180_000,
  auStockBalance:       60_000,  auStockBasis:          40_000,

  // International transfer
  exchangeRateUsdToAud: 1.55,  // 1 USD = 1.55 AUD
  intlTransferFeeUsd:   15,    // fixed fee per transfer in USD

  // FX process (design 92). This plan moves to Australia in `moveYear` and stays
  // there while the wealth remains USD-denominated, so the currency mismatch runs
  // the full horizon rather than ending at the house sale — see the fx-study
  // writeup. A pinned rate is therefore not a neutral default here, it is a
  // no-FX-risk assumption on the one scenario whose defining feature is FX risk.
  // Measured on this scenario over its 2026-2050 default window, 60 FX seeds:
  // MEAN_REVERTING widens the p10-p90 terminal wealth band from $0.00M to $1.22M
  // (p50 $12.3M), so the rate is now a risk the plan carries rather than one it
  // assumes away. Set 'NONE' to pin it — which the golden fixtures and the shared
  // test harnesses do, so they keep guarding tax mechanics and not an RNG path.
  // fxVolatility / fxReversionSpeed are deliberately left to the
  // US_AU_CROSS_BORDER schema, which already carries the post-float calibration
  // (sigma 0.1142, k 0.114 — the term-structure fit, not the lag-1 AR(1) one).
  fxProcessModel:       'MEAN_REVERTING',

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
  // Cross-border drawdown mode (design 58 Lever A): AUTO | LOCAL_FIRST | GLOBAL.
  // AUTO keeps the legacy coupling (TAX_EFFICIENT ⇒ GLOBAL, else LOCAL_FIRST).
  crossBorderDrawdown:   'AUTO',
  // Per-role drawdown weights (design 58 Lever B). Only consulted when
  // drawdownStrategy === 'WEIGHTED'; seeded from TAX_EFFICIENT's global order so
  // the default strategy (TAXABLE_FIRST) is unaffected. Keys: drawdownWeight.<role>.
  ...DEFAULT_DRAWDOWN_WEIGHT_PARAMS,
  // Within-tier draw policy (design 58 Lever C): SEQUENTIAL | EQUAL | PROPORTIONAL.
  // How accounts sharing one drawdown tier (equal effective priority) split a draw.
  // SEQUENTIAL (default) drains one fully before the next — byte-identical.
  withinTierDraw:        'SEQUENTIAL',
  // Allocation-aware drawdown (design 65). Which *sleeve* (asset class) and which
  // *lots* within the chosen account to sell for a spending debit. FIFO/FIFO is the
  // historic blind purchase-date order, so existing scenarios are byte-identical.
  drawdownSleeveOrder:   'FIFO',  // FIFO | TAX_COST | PRESERVE_GROWTH | WEIGHTED (Lever A)
  drawdownLotStrategy:   'FIFO',  // FIFO | HIFO | LOSS_FIRST | SPECIFIC | LADDER (Lever B; LADDER = design 66 §G8)
  // The security tier (design 94 step 6): ids to sell out of first, in order. Empty = no
  // security bias, and no state key at all — so every existing scenario is byte-identical.
  drawdownSecurityOrder: [],
  drawdownSequence:      null,   // design 97 — the ordered POOL list; null = drawdownPriority alone
  // Lever C (design 65 §4-C) rebalance-coupling weight (w_mix). 0 = off (default);
  // >0 biases the sleeve sell order toward the design-61 over-weight class so a debit
  // doubles as a rebalance. Inert unless a TARGET_ALLOCATION strategy stamps targets.
  drawdownRebalanceWeight: 0,
  // Per-class sleeve weights (design 65 Lever A). Only consulted when
  // drawdownSleeveOrder === 'WEIGHTED'. Keys: sleeveWeight::<CLASS>.
  ...DEFAULT_SLEEVE_WEIGHT_PARAMS,

  // Inflation rates (annual, per country)
  usInflationRate: 0.03,
  auInflationRate: 0.03,
  // AU CGT cost-base indexation (CPI) rate (design 57 Part 2, Item A). Unset =
  // track the AU inflation rate (byte-identical to the pre-Part-2 behaviour).
  auCpiRate: undefined,

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

  // Inheritance year for the example bequest (null = inert; design 63)
  inheritanceYear: null,
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
    type: 'Enum', options: ['', ...US_STATE_CODES], group: 'US Tax', mc: false, opt: true,
    defaultValue: INTL_RETIREMENT_DEFAULTS.residencyState ?? '',
    description: `US state of residency for state income tax (${US_STATE_CODES.join(', ')}). Blank = none.`,
    node: { type: 'person', id: 'primary', field: 'residencyState' },
  },

  // ── US Account Balances ────────────────────────────────────────────────────
  // Per-record balance params (initialUsSavings, rothBalance, iraBalance,
  // k401Balance, stockBalance, fixedIncomeBalance) are now generated from the
  // account records (design 55); only the derived stock split/basis knobs remain.
  {
    key: 'stockSplitRatio', label: 'Stock Domestic Split (0–1)',
    type: 'Number', group: 'US Account Balances', mc: false, opt: false,
    defaultValue: INTL_RETIREMENT_DEFAULTS.stockSplitRatio,
    description: 'Fraction of US stock balance allocated to the domestic equity holding (remainder goes to international). Default 0.6 = 60/40.',
  },
  {
    key: 'stockBasisUS', label: 'Stock Basis — Domestic (USD)',
    type: 'Number', group: 'US Account Balances', mc: false, opt: false,
    defaultValue: INTL_RETIREMENT_DEFAULTS.stockBasisUS,
    description: 'Cost basis for the domestic equity holding. Default exceeds market value so TLH fires immediately when enabled.',
  },
  {
    key: 'stockBasisIntl', label: 'Stock Basis — International (USD)',
    type: 'Number', group: 'US Account Balances', mc: false, opt: false,
    defaultValue: INTL_RETIREMENT_DEFAULTS.stockBasisIntl,
    description: 'Cost basis for the international equity holding. Default is below market value (gain position, TaxGainHarvest candidate).',
  },

  // AU + Spouse per-record balances (auSavingsBalance, superBalance,
  // auStockBalance, spouse{Roth,Ira,K401,Super}Balance) are generated from their
  // account records (design 55). Their growth comes from the markets they hold.

  // ── Spouse Account Rates ───────────────────────────────────────────────────
  // RETIRED (design/inconsistencies §4.10), and the per-wrapper rates they pointed at
  // have since gone too (design 99 P2): an account has no growth rate of its own and
  // earns the TOTAL return of each market its holdings track (`collectBaseGrowthRates`
  // → one key per market, from MARKET_GROWTH_PARAMS). The retired keys drop via
  // INTL_RETIREMENT_PARAM_ALIASES. A genuinely per-person return is a holdings question
  // — give that person's account a different market mix or security — not a param.

  // ── US Retirement ─────────────────────────────────────────────────────────
  {
    key: 'primarySsClaimAge', label: 'Primary SS Claim Age',
    // opt: false until TODO #292 — only FRA (67) is modelled, so an optimizer axis here
    // would spend budget on a lever that moves nothing (design 98 W3 follow-up).
    type: 'Number', group: 'US Retirement', mc: false, opt: false,
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

  // Inheritance (design 63): the inheritanceYear + per-inherited-RA drawdown knobs
  // are GENERATED per-record from the Bequest records (design 55 template path /
  // design 63 §12.3), so they are not hand-listed here.

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
            // Lever B (design 58 §4-B): the WEIGHTED sentinel makes the cascade
            // synthesize the role→rank map from the per-role drawdownWeight.<role>
            // params (ascending sort = draw order) instead of a fixed strategy
            // table. weightRoles are the investment roles searched; cashRoles
            // always rank 0 (drawn first). weightDefaults backstop a missing key.
            weightMode: DRAWDOWN_WEIGHT_MODE,
            weightKeyPrefix: DRAWDOWN_WEIGHT_PREFIX,
            weightKeySep: DRAWDOWN_WEIGHT_SEP,
            weightRoles: DRAWDOWN_WEIGHT_ROLES,
            cashRoles: DRAWDOWN_CASH_ROLES,
            weightDefaults: DEFAULT_DRAWDOWN_WEIGHTS,
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
    // Cross-border drawdown mode (design 58 Lever A). Feeds state.crossBorderDrawdown
    // (resolved in the US_RETIREMENT toolset) — no node cascade; the toolset reads it
    // directly. AUTO preserves the legacy TAX_EFFICIENT⇒GLOBAL coupling so existing
    // scenarios are byte-identical; GLOBAL lets CUSTOM (or any strategy) honor the
    // authored drawdownPriority order across the US↔AU border.
    key: 'crossBorderDrawdown', label: 'Cross-Border Drawdown',
    type: 'Enum', group: 'Spending',
    options: ['AUTO', 'LOCAL_FIRST', 'GLOBAL'],
    mc: false, opt: true, defaultValue: INTL_RETIREMENT_DEFAULTS.crossBorderDrawdown,
    description: 'How the non-residence country\'s accounts are ordered for drawdown. ' +
      'AUTO follows the strategy (TAX_EFFICIENT is global, others residence-first). ' +
      'LOCAL_FIRST drains the current residence country first. ' +
      'GLOBAL lets both countries\' accounts compete in one drawdownPriority order — pair with CUSTOM to force a hand-authored cross-border order.',
  },
  {
    // Within-tier draw policy (design 58 Lever C). Feeds state.withinTierDraw
    // (resolved in the US_RETIREMENT toolset) — no node cascade; AccountService
    // .replenishSavings reads it directly to decide how accounts sharing one
    // drawdown tier (e.g. two Roths under POOLED, or two roles tied by a Lever-B
    // weight) split a draw. SEQUENTIAL preserves the legacy per-tier drain so
    // existing scenarios are byte-identical.
    key: 'withinTierDraw', label: 'Within-Tier Draw',
    type: 'Enum', group: 'Spending',
    options: ['SEQUENTIAL', 'EQUAL', 'PROPORTIONAL'],
    mc: false, opt: true, defaultValue: INTL_RETIREMENT_DEFAULTS.withinTierDraw,
    description: 'How accounts sharing one drawdown tier (equal priority) split a withdrawal. ' +
      'SEQUENTIAL drains one member fully before the next (default). ' +
      'EQUAL splits the tier\'s draw evenly across members (residual redistributes when one is capped). ' +
      'PROPORTIONAL splits by each member\'s available balance — e.g. draw two Roths together pro-rata.',
  },
  {
    // Allocation-aware drawdown — sleeve order (design 65 Lever A). Feeds
    // state.drawdownSleeveOrder (resolved in the US_RETIREMENT toolset); the disposal
    // primitive reads it to choose which asset class to sell first for a spending
    // debit. FIFO preserves the historic blind purchase-date order (byte-identical).
    key: 'drawdownSleeveOrder', label: 'Drawdown Sleeve Order',
    type: 'Enum', group: 'Spending',
    options: SLEEVE_ORDER_MODES,
    mc: false, opt: true, defaultValue: INTL_RETIREMENT_DEFAULTS.drawdownSleeveOrder,
    description: 'Which asset class (sleeve) to sell first when raising cash for spending. ' +
      'FIFO ignores allocation (historic behavior). ' +
      'TAX_COST sells least-taxed first (CASH→BOND→EQUITY→GOLD). ' +
      'PRESERVE_GROWTH sells the safe sleeves first and lets equity compound (CASH→BOND→GOLD→EQUITY). ' +
      'WEIGHTED sorts sleeves by the per-class sleeveWeight params (optimizable).',
  },
  {
    // Allocation-aware drawdown — lot strategy (design 65 Lever B). Feeds
    // state.drawdownLotStrategy; the disposal primitive reads it to choose which lots
    // within the selected sleeve to consume. FIFO is the historic oldest-first order.
    key: 'drawdownLotStrategy', label: 'Drawdown Lot Strategy',
    type: 'Enum', group: 'Spending',
    options: LOT_STRATEGIES,
    mc: false, opt: true, defaultValue: INTL_RETIREMENT_DEFAULTS.drawdownLotStrategy,
    description: 'Which lots within a sleeve to sell for a spending debit. ' +
      'FIFO sells oldest first (maximizes AU 12-month CGT-discount eligibility). ' +
      'HIFO sells highest-cost-basis first (least realized gain per dollar). ' +
      'LOSS_FIRST realizes losing lots first (banks losses). ' +
      'SPECIFIC is a gain-minimizing pick (behaves as HIFO until bracket-awareness lands). ' +
      'LADDER draws a bond ladder the natural way — liquid cash first, then the ' +
      'nearest-maturity rung (≈ par, least mark-to-market deviation), sparing funds/equity (design 66 §G8).',
  },
  {
    // The SECURITY tier (design 94 step 6, §10 item 3). Feeds state.drawdownSecurityOrder;
    // the disposal primitive ranks lots by which security they name, between the ALLOCATION
    // class (Lever A) and the lot strategy (Lever B).
    //
    // `options` stays empty and `optionsFrom` supplies them instead. The ids are scenario
    // data — whatever `cfg.securities` holds, plus the four synthetic market securities
    // every migrated equity lot names (§9.1) — so the only honest FIXED list is no list.
    // Step 9 resolves them from the scenario record at render time
    // (`scenarioSecurityRegistry`), which is the same composition the run itself uses.
    //
    // `ordered: true` (design 94 step 10) routes this to the reorderable control rather
    // than the checkbox group. The group expressed order by CHECK ORDER — ticking appends
    // — which cannot express a re-order at all, and, worse, does not SHOW the order it is
    // storing. This param is a sequence, so it gets a control that says so.
    key: 'drawdownSecurityOrder', label: 'Drawdown Security Order',
    type: 'EnumMulti', group: 'Spending', ordered: true,
    options: [], optionsFrom: 'securities',
    mc: false, opt: false, defaultValue: INTL_RETIREMENT_DEFAULTS.drawdownSecurityOrder,
    description: 'Which SECURITIES to raise cash out of first, in order, before the ones not '
      + 'listed. Neither a class question nor a lot question: "sell the employer stock before '
      + 'the index fund" is a statement about which INSTRUMENT to sell, and it only became '
      + 'expressible once a position names one. An order, not a filter — once the listed '
      + 'securities are exhausted the draw carries on through the rest, exactly as the sleeve '
      + 'order does with an absent class. Empty = no security bias (the default).',
  },
  {
    // Design 97 — the POOL sequence. Feeds state.drawdownSequence; validated in the
    // US_RETIREMENT toolset (`normalizeDrawdownSequence`), which throws on an unknown key,
    // an overlapping sleeve set, or a sequence set beside PROPORTIONAL.
    //
    // `DrawdownSequence` — a reorderable (account, sleeves) row list. It WAS a JSON
    // textarea, on the reasoning that the param is an ORDER and a control that says so
    // honestly is real UI work. The missing piece was per-row reordering, which
    // `buildRowListEditor` gained for the design-95 lists; with that plus a sleeve
    // checkset the honest control is a composition of parts that already exist.
    key: 'drawdownSequence', label: 'Drawdown Sequence (pools)',
    type: 'DrawdownSequence', group: 'Spending',
    mc: false, opt: false, defaultValue: INTL_RETIREMENT_DEFAULTS.drawdownSequence,
    description: 'ORDERED list of pools to draw spending from, e.g. '
      + '[{"key":"auSavingsAccount"},{"key":"brokerageAccount","sleeves":["BOND"]},'
      + '{"key":"auOffsetAccount"},{"key":"brokerageAccount","sleeves":["EQUITY","GOLD"]}]. '
      + 'Each entry is an account, optionally narrowed to allocation sleeves; an account may '
      + 'appear more than once with disjoint sleeves. This is the only way to say "after bonds, '
      + 'before equity": account priority and within-account sleeve order are two separate '
      + 'orderings and that policy lives between them. Accounts not listed follow the sequence '
      + 'in their ordinary drawdownPriority order. Blank (the default) = drawdownPriority alone, '
      + 'byte-identical to before. Sleeves apply only to a BROKERAGE account (the only draw that '
      + 'runs through the holdings primitive).',
  },
  {
    // Lever C (design 65 §4-C) — rebalance coupling. Feeds state.drawdownRebalanceWeight;
    // the disposal primitive biases the sleeve sell order toward the design-61
    // over-weight class so a spending debit doubles as a rebalance (one CGT event, not
    // two). 0 = off (byte-identical). Requires a TARGET_ALLOCATION behavioral strategy
    // to stamp per-account targets; inert otherwise.
    key: 'drawdownRebalanceWeight', label: 'Drawdown Rebalance Coupling',
    type: 'Number', group: 'Spending',
    min: 0, max: 3, step: 0.25,
    mc: false, opt: true, defaultValue: INTL_RETIREMENT_DEFAULTS.drawdownRebalanceWeight,
    visibleWhen: { param: 'behavioralStrategies', includes: 'TARGET_ALLOCATION' },
    description: 'How strongly a spending drawdown is biased toward selling the over-weight ' +
      'asset class (per the design-61 target) so the sale also rebalances. 0 disables the ' +
      'coupling; higher values let mix-correction override the tax-cost sleeve order. ' +
      'Only meaningful with a TARGET_ALLOCATION strategy active.',
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
  // ── Drawdown weights (design 58 Lever B — optimizable role-weight order) ──────
  // One continuous [0,1] weight per investment role; the draw order is the
  // ascending sort of the weights. Read by the drawdownStrategy node's
  // accountPriority cascade (weightMode), active only when the WEIGHTED strategy is
  // selected — so these carry no node of their own and are byte-identical no-ops
  // under every other strategy. Generated from DRAWDOWN_WEIGHT_ROLES so the list
  // stays in sync with the roles the cascade synthesizes.
  ...buildDrawdownWeightSchema(),

  // ── Drawdown sleeve weights (design 65 Lever A — optimizable class-sell order) ─
  // One continuous [0,1] weight per asset class; the sell order is the ascending
  // sort of the weights. Read by the disposal primitive (via state.drawdownSleeveWeights)
  // only when drawdownSleeveOrder === 'WEIGHTED', so they are byte-identical no-ops
  // under FIFO/TAX_COST/PRESERVE_GROWTH.
  ...buildSleeveWeightSchema(),

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
 *
 * A `null` target means RETIRED rather than renamed: the key had no successor (it
 * was read by nothing), so the loader deletes it instead of leaving an orphan entry
 * in a saved scenario's params list — see §4.10.
 */
export const INTL_RETIREMENT_PARAM_ALIASES = Object.freeze({
  // People
  primaryRetirementDate: 'person.primary.retirementDate',
  spouseRetirementDate:  'person.spouse.retirementDate',
  primaryMonthlyWage:    'person.primary.monthlyWage',
  spouseMonthlyWage:     'person.spouse.monthlyWage',
  // Account balances (design 55 §13). Every account bootstraps a holding at compile time,
  // so its `balance` is derived from Σ holdings and is never a plain generated param. These
  // legacy flat keys — still the MC/Opt lever keys because saved MC configs carry them
  // (chosen when mc-param-paths `set()` dropped dotted generated keys; design 98 W0 fixed
  // that) — resolve to the generated, hidden compile-only
  // `acct.<stateKey>.balanceTarget`, whose loader cascade rescales holdings to the value
  // non-destructively. A pre-design-55 save carrying one of these keys therefore rescales
  // its (consistent) holdings to the stored balance — a no-op — rather than being ignored.
  initialUsSavings:      'acct.usSavingsAccount.balanceTarget',
  rothBalance:           'acct.rothAccount.balanceTarget',
  iraBalance:            'acct.iraAccount.balanceTarget',
  k401Balance:           'acct.k401Account.balanceTarget',
  stockBalance:          'acct.usStockAccount.balanceTarget',
  fixedIncomeBalance:    'acct.fixedIncomeAccount.balanceTarget',
  // AU account balances
  auSavingsBalance:      'acct.auSavingsAccount.balanceTarget',
  superBalance:          'acct.superAccount.balanceTarget',
  auStockBalance:        'acct.auStockAccount.balanceTarget',
  // Spouse account balances
  spouseRothBalance:     'acct.spouseRothAccount.balanceTarget',
  spouseIraBalance:      'acct.spouseIraAccount.balanceTarget',
  spouseK401Balance:     'acct.spouseK401Account.balanceTarget',
  spouseSuperBalance:    'acct.spouseSuperAccount.balanceTarget',
  // Real property
  usHouseSaleYear:       'prop.usHouseProperty.plannedSaleYear',
  auHouseSaleYear:       'prop.auHouseProperty.plannedSaleYear',
  // Cash floors (design 55 §7/§13) — now per-account on the canonical savings accounts
  usSavingsMinBalance:   'acct.usSavingsAccount.minimumBalance',
  auSavingsMinBalance:   'acct.auSavingsAccount.minimumBalance',
  // Spouse growth rates (design/inconsistencies §4.10). `spouseSuperGrowthRate` was
  // the only one the compiler ever read (it fed the type-level `superGrowthRate`), so it
  // still RENAMES — but `superGrowthRate` is itself retired now (design 99 P2): the
  // loader's `retireRateParams` runs after these aliases, drops it, and WARNS if the
  // saved value differs from the market total super now earns. So a saved value is
  // reported rather than silently lost. The other three were read by nothing; a `null`
  // target RETIRES a key — the loader deletes it instead of carrying a dead entry
  // forward into the params UI forever.
  spouseSuperGrowthRate: 'superGrowthRate',
  spouseRothGrowthRate:  null,
  spouseIraGrowthRate:   null,
  spouseK401GrowthRate:  null,
});

/**
 * Design 55 §13: resolve the live scenario value that each balance MC/Opt lever should
 * center on, keyed by the lever's legacy flat key (`stockBalance`, `rothBalance`, …).
 *
 * A holdings-bearing account's balance is derived from Σ holdings and is not a plain
 * param, so it can't be read from the flat `cfg.parameters` map the way a rate can. This
 * inverts the balance aliases (legacy key → `acct.<stateKey>.balanceTarget`) and reads the
 * matching account record's balance from the config. The result is merged into the MC
 * params snapshot so that (a) the panel presets and Copy-from-Scenario show the real
 * balance, and (b) a *disabled* balance lever no longer falls back to a hardcoded default
 * that would rescale the account's holdings when the runner writes it.
 *
 * @param {object} cfg - a serialized scenario config (needs cfg.accounts with balances)
 * @returns {Object<string, number>} legacy balance key → live account balance
 */
export function resolveBalanceCenters(cfg) {
  const centers = {};
  const accounts = Array.isArray(cfg?.accounts) ? cfg.accounts : [];
  for (const [legacy, target] of Object.entries(INTL_RETIREMENT_PARAM_ALIASES)) {
    const m = target ? /^acct\.(.+)\.balanceTarget$/.exec(target) : null;
    if (!m) continue;
    const acct = accounts.find(a => a?.stateKey === m[1]);
    if (acct && acct.balance != null) centers[legacy] = acct.balance;
  }
  return centers;
}

/**
 * IntlRetirementScenario — International two-person retirement simulation.
 *
 * Two people (primary + spouse), US→AU migration on Jul 1 of moveYear.
 * Wired entirely through the toolset compiler path (Path 2 in BaseApp):
 * getToolsets() declares all 11 toolsets; buildDefaultConfig() produces the
 * serialized persons/accounts/realProperties/collectibles for a fresh load.
 */
/**
 * Stamp `equityMarketMix` onto every equity account from the two international-share
 * params (design 90 §7.3).
 *
 * A post-pass over the finished account list rather than a field on each of the dozen
 * account literals above: the mix is a property of an account's DOMICILE and role, not
 * of any individual account, and threading it through every literal would be a dozen
 * chances to miss one — which is exactly how `auDiscountableGain` drifted across six
 * disposal emitters (design/inconsistencies §4.11).
 *
 * **A share of 0 stamps nothing at all.** That is what keeps the whole sub-axis inert
 * by default: no `equityMarketMix` on the account means `resolveEquityMarketMix` returns
 * the single domestic market, and `_bootstrapDefaultHolding` builds the one sleeve it
 * always built. Introducing the mechanism and re-rating every scenario in one commit
 * would make the two effects impossible to tell apart in the golden diff.
 *
 * Which accounts: those whose role has a default equity rate key. Cash, fixed-income and
 * loan accounts have no market axis and must not be given one — a `SAVINGS_US` sleeve
 * carrying an equity mix would resolve a market rate for money that earns interest.
 *
 * @param {object} cfg         the built config (mutated and returned)
 * @param {object} parameters  the resolved param bag
 */
function withEquityMarketMix(cfg, parameters) {
  const share = {
    US: parameters?.usEquityIntlShare ?? 0,
    AU: parameters?.auEquityIntlShare ?? 0,
  };
  if (!(share.US > 0) && !(share.AU > 0)) return cfg;

  for (const acct of cfg.accounts ?? []) {
    const markets = EQUITY_MARKETS_BY_COUNTRY[acct?.country];
    if (!markets) continue;
    // Only accounts that actually hold equity. ROLE_TO_RATE_KEY is the same table
    // `resolveRateKey` consults, so this cannot drift from what the holdings resolve to.
    if (ROLE_TO_RATE_KEY[acct.role] !== markets.domestic) continue;
    const intl = share[acct.country];
    if (!(intl > 0)) continue;
    acct.equityMarketMix = {
      [markets.domestic]:      1 - intl,
      [markets.international]: intl,
    };
  }
  return cfg;
}

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
   * The toolset objects whose paramSchema() contributes configurable params.
   * Shared by buildFullParamSchema() and _toolsetParamKeys() so the two agree on
   * exactly which keys count as "toolset-contributed".
   */
  static _paramToolsets() {
    return [
      US_BANKING, US_TAX, US_STATE_TAX, US_BROKERAGE, US_INCOME, US_RETIREMENT,
      AU_BANKING, AU_TAX, AU_BROKERAGE, AU_INCOME, AU_RETIREMENT,
      US_AU_CROSS_BORDER, US_REAL_PROPERTY, AU_REAL_PROPERTY,
      US_COLLECTIBLES, US_ROTH_CONVERSION, US_EARLY_WITHDRAWAL, US_COMPANY_SALE, INHERITANCE, ECONOMIC_REGIMES,
    ];
  }

  /**
   * Full param schema: scenario-level params merged with all toolset paramSchema
   * entries (deduplicating by key). Use this when you need the complete set of
   * configurable params for UI pickers (e.g. Decision Graph, Optimization).
   *
   * Scenario entries win, then the FIRST toolset copy of a shared key (US_RETIREMENT
   * and AU_RETIREMENT both contribute the spending/mortality family) — the same rule
   * as ScenarioLoader._mergeParamSchema, so the schema the MC/Opt overlays index and
   * the schema the loader materializes agree (design 98 W2).
   */
  static buildFullParamSchema() {
    const seen = new Set(INTL_RETIREMENT_PARAM_SCHEMA.map(e => e.key));
    const toolsetParams = IntlRetirementScenario._paramToolsets()
      .flatMap(t => t.paramSchema?.({}) ?? [])
      .filter(e => e?.key && !seen.has(e.key) && seen.add(e.key));
    return [...INTL_RETIREMENT_PARAM_SCHEMA, ...toolsetParams];
  }

  /**
   * The set of param keys contributed by toolsets (i.e. not named by the
   * scenario-level schema). buildDefaultConfig() forwards explicit overrides for
   * these so they aren't silently dropped. Memoized — the toolset schemas are
   * static (behavioralStrategyKeys etc. don't depend on runtime context).
   */
  static _toolsetParamKeys() {
    return (IntlRetirementScenario.__toolsetParamKeys ??= toolsetParamKeys(
      IntlRetirementScenario._paramToolsets(), INTL_RETIREMENT_PARAM_SCHEMA));
  }

  static getToolsets() {
    return [
      'US_BANKING', 'US_TAX', 'US_STATE_TAX', 'US_BROKERAGE', 'US_INCOME', 'US_RETIREMENT',
      'AU_BANKING', 'AU_TAX', 'AU_BROKERAGE', 'AU_INCOME', 'AU_RETIREMENT',
      'US_AU_CROSS_BORDER',
      'US_REAL_PROPERTY', 'AU_REAL_PROPERTY',
      'US_COLLECTIBLES', 'US_ROTH_CONVERSION', 'US_EARLY_WITHDRAWAL',
      'US_COMPANY_SALE',
      'INHERITANCE',
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

    // ── Parameters (toolset-key names) ────────────────────────────────────────
    const parameters = {
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
      // AU_TAX — dedicated ATO CPI indexation rate (design 57 Part 2, Item A).
      // Only forwarded when set; unset ⇒ tracks AU inflation.
      ...(p.auCpiRate != null ? { auCpiRate: p.auCpiRate } : {}),
      goldGrowthRate:           p.goldGrowthRate,
      // Design 90 §7.3 — the equity market sub-axis lever. 0 ⇒ no mix is stamped and
      // every equity account bootstraps its single domestic sleeve, as before.
      usEquityIntlShare:        p.usEquityIntlShare,
      auEquityIntlShare:        p.auEquityIntlShare,
      dividendReinvest:         p.stockDividendReinvest,
      fixedIncomeInterestRate:  p.fixedIncomeInterestRate,
      monthlyExpenses:          p.monthlyExpenses,
      inflationAdjust:          true,
      // Allocation-aware drawdown (design 65 Levers A/B/C) and the design 94 step 6
      // SECURITY tier. These are scenario-schema keys, and the toolset-forwarding loop at
      // the bottom of this method deliberately skips those — so before this line a headless
      // caller passing `drawdownLotStrategy: 'HIFO'` silently got FIFO. The UI path worked
      // (the editor writes the value straight into a saved scenario's `parameters`), which
      // is exactly why it went unnoticed: two param stores, one of them fed only by a
      // human. Every default here is the historic no-op, so naming them changes nothing
      // for a caller that does not pass them.
      drawdownSleeveOrder:      p.drawdownSleeveOrder ?? undefined,
      drawdownLotStrategy:      p.drawdownLotStrategy ?? undefined,
      drawdownRebalanceWeight:  p.drawdownRebalanceWeight ?? undefined,
      drawdownSecurityOrder:    p.drawdownSecurityOrder ?? undefined,
      drawdownSequence:         p.drawdownSequence ?? undefined,
      // US_RETIREMENT — cross-border drawdown mode (design 58 Lever A). AUTO
      // default preserves the legacy TAX_EFFICIENT⇒GLOBAL coupling.
      crossBorderDrawdown:      p.crossBorderDrawdown ?? 'AUTO',
      // US_RETIREMENT — within-tier draw policy (design 58 Lever C). SEQUENTIAL
      // default preserves the legacy per-tier drain.
      withinTierDraw:           p.withinTierDraw ?? 'SEQUENTIAL',
      // AU_BANKING
      auSavingsInterestRate:    p.auSavingsInterestRate,
      auFixedIncomeInterestRate: p.auFixedIncomeInterestRate,
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
      fxProcessModel:           p.fxProcessModel,
      startingResidency:        'US',
      // US_ROTH_CONVERSION
      rothConversionEnabled:    p.rothConversionEnabled,
      rothConversionStartYear:  p.rothConversionStartYear,
      rothConversionEndYear:    p.rothConversionEndYear,
      rothConversionMaxBracket: p.rothConversionMaxBracket,
      rothConversionOwner:      p.rothConversionOwner,
      rothConversionMonth:      p.rothConversionMonth,
      rothConversionDay:        p.rothConversionDay,
    };

    // Faithfully forward toolset-contributed params that the enumerated block
    // above does not name (design 29 behavioralStrategies/bondLadderRungs,
    // economic `shocks`/`primeSchedule`, …). Before this, such keys were silently
    // dropped, so a headless caller doing
    // buildDefaultConfig({ behavioralStrategies: ['BOND_LADDER'] }) got a no-op.
    // Only explicit overrides are forwarded — a toolset param the caller didn't
    // pass keeps its own schema default, so the reference scenario is unchanged.
    forwardToolsetOverrides(params, parameters, IntlRetirementScenario._toolsetParamKeys());

    return withEquityMarketMix({
      toolsets: IntlRetirementScenario.getToolsets(),
      simStart:       ScenarioSerializer.toDateStr(simStart ?? new Date(Date.UTC(2026, 0, 1))),
      simEnd:         ScenarioSerializer.toDateStr(simEnd   ?? new Date(Date.UTC(2041, 0, 1))),
      parameters,

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
          // Equity bases + the bond leg (basis = market, §5.3.4) — design 66 §G3.
          contributionBasis: (p.stockBasisUS ?? 0) + (p.stockBasisIntl ?? 0)
                           + +((p.stockBalance ?? 0) * STOCK_BOND_FRACTION).toFixed(2),
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
          holdings: _k401Holdings(p),     // 60/40 equity/bond (design 66 §G3)
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
          // Investment bullion: an ordinary AU CGT asset → AU gain is cost-base
          // indexed under the FY2027 reform (design 57 Part 2, Item C).
          isGold: true,
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

      // ── Inheritance (design 63) ───────────────────────────────────────────────
      // An example external-decedent bequest. Inert until inheritanceYear is set
      // (null default ⇒ contributes nothing, so the reference golden is unmoved).
      // Set the year to fund the inherited assets + arm the SECURE 10-year IRA
      // drawdown, the AU super lump-sum, and any NE inheritance tax.
      bequests: [
        {
          __type: 'Bequest', name: "Parent's Estate", stateKey: 'estateBequest',
          decedentName: 'Parent', relationship: 'immediate', decedentState: null,
          heirId: 'primary', paidViaEstate: false,
          ...(p.inheritanceYear != null ? { inheritanceYear: p.inheritanceYear } : {}),
          assets: [
            { __type: 'BrokerageAccount',      name: 'Inherited Brokerage', country: 'US',
              stateKey: 'inheritedBrokerageAccount', inheritedValue: 400_000, deceasedCostBase: 150_000 },
            { __type: 'TraditionalIRAAccount', name: 'Inherited IRA',       country: 'US',
              stateKey: 'inheritedIraAccount',       inheritedValue: 300_000, distributionMode: 'bracketFill' },
            { __type: 'RealProperty',          name: 'Inherited Home',      country: 'US',
              stateKey: 'inheritedHomeProperty',     inheritedValue: 600_000, deceasedCostBase: 200_000 },
          ],
        },
      ],
    }, parameters);
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
    toolsetRegistry.register(INHERITANCE);
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
 * The default brokerage book is 60% equity / 40% bond (a representative balanced
 * split, design 66 §G3). The bond leg makes the golden exercise the whole bond
 * path — coupon income, duration mark-to-market and the Treasury/muni tax splits —
 * which was previously dead (an all-equity default). Users can re-weight in the UI.
 */
const STOCK_EQUITY_FRACTION = 0.60;
const STOCK_BOND_FRACTION    = 0.40;
/** Coupon + duration for the default bond sleeves: matches the fixed-income rate / 5y modified duration. */
const DEFAULT_BOND_COUPON    = 0.04;
const DEFAULT_BOND_DURATION  = 5;
/** Maturity year for the default brokerage's individual Treasury bond (design 66 §G4). */
const DEFAULT_BOND_MATURITY_YEAR = 2035;

/**
 * Build the seed holdings for usStockAccount (design 66 §G3): a 60/40 equity/bond book.
 *
 * Equity (60% of stockBalance): a Domestic + International EQUITY_US pair split by
 * stockSplitRatio. Both use EQUITY_US so the TLH substitute-selection algorithm
 * auto-selects the sibling; by default the domestic sleeve is above basis (loss
 * position) and the international sleeve is below basis (gain position), so TLH
 * fires immediately when enabled — the bases scale with the (now-smaller) equity
 * book so that intent is preserved.
 *
 * Bond (40% of stockBalance): a Treasury sleeve (`taxExemption: 'state'` — coupon
 * federally taxable, US-state-exempt per 31 U.S.C. § 3124), a corporate sleeve
 * (`'none'` — fully taxable) and a municipal sleeve (`'federal'` — federally exempt,
 * issuingState 'CA'). Being in a TAXABLE account, all three exercise the design-59/66
 * BOND_COUPON_TAX splits. Bond basis = market value (§5.3.4); a fixed contractual
 * couponRate is stamped (these are declared holdings, not the design-61 establish path).
 *
 * The Treasury sleeve is an *individual bond* (design 66 §G4): it carries a
 * `maturityDate` (mid-sim) + `faceValue` = its par book, so it pulls to par over its
 * life (its duration decays and any rate-driven markdown recovers) and is redeemed at
 * par to cash by BondMaturityReducer when it matures — exercising the whole maturity
 * path in the golden. The corporate + muni sleeves stay perpetual *funds*
 * (maturityDate null), so both identities are represented.
 */
function _stockHoldings(p) {
  const ratio   = Math.min(1, Math.max(0, p.stockSplitRatio ?? 0.60));
  const total   = p.stockBalance ?? 0;
  const equity  = +((total * STOCK_EQUITY_FRACTION).toFixed(2));
  const bond    = +((total - equity).toFixed(2));
  const usMv    = +((equity * ratio).toFixed(2));
  const intlMv  = +((equity - usMv).toFixed(2));
  // Split the bond leg across the three tax treatments (Σ = bond total).
  const treasuryMv = +((bond * 0.40).toFixed(2));
  const muniMv     = +((bond * 0.25).toFixed(2));
  const corpMv     = +((bond - treasuryMv - muniMv).toFixed(2));
  // par-reviewed: CONSTRUCTS a Holding; the spread is an `extra` overrides bag, not an
  // existing position.
  const bondSleeve = (id, label, mv, taxExemption, issuingState = null, extra = {}) => new Holding({
    id, label, allocation: ALLOCATION.BOND, rateKey: RATE_KEYS.FIXED_INCOME_US,
    marketValue: mv, costBasis: mv,                    // bond basis = market (§5.3.4)
    couponRate: DEFAULT_BOND_COUPON, duration: DEFAULT_BOND_DURATION,
    taxExemption, issuingState, ...extra,
  });
  return [
    new Holding({
      id:          'h-us-equity',
      label:       'US Equity (Domestic)',
      allocation:  ALLOCATION.EQUITY,
      rateKey:     RATE_KEYS.EQUITY_US,
      marketValue: usMv,
      costBasis:   p.stockBasisUS   ?? 65_000,
    }),
    new Holding({
      id:          'h-intl-equity',
      label:       'International Equity (ex-US)',
      allocation:  ALLOCATION.EQUITY,
      // Design 90 §7.3 — this sleeve has been called "International" since it was
      // authored, and tracked `EQUITY_US` the whole time. There was no other key to give
      // it: before the market axis, EQUITY_US was the only US-domiciled equity series,
      // so `stockSplitRatio` split the brokerage into two sleeves with identical
      // returns. It was §7.1's defect in miniature, sitting in the reference scenario
      // with a label that said so.
      //
      // This is the one place step 6 changes a number rather than adding a capability:
      // the ex-US sleeve now earns the ex-US rate and takes the ex-US beta.
      rateKey:     RATE_KEYS.EQUITY_INTL_EX_US,
      marketValue: intlMv,
      costBasis:   p.stockBasisIntl ?? 25_000,
    }),
    // Individual bond: par faceValue, matures 1 Jan 2035 → redeemed to cash mid-sim.
    bondSleeve('h-us-treasury', 'US Treasury', treasuryMv, 'state', null, {
      maturityDate: new Date(Date.UTC(DEFAULT_BOND_MATURITY_YEAR, 0, 1)),
      faceValue:    treasuryMv,
    }),
    bondSleeve('h-us-corp-bond', 'Corporate Bond', corpMv,   'none'),
    bondSleeve('h-ca-muni',     'CA Municipal',   muniMv,    'federal', 'CA'),
  ];
}

/**
 * Build the seed holdings for the 401(k) — a 60/40 equity/bond book (design 66 §G3),
 * the "some in Retirement" half of the default bond seeding. The bond sleeve is inside
 * a tax-DEFERRED wrapper, so its coupon (via BOND_SLEEVE_COUPON) grows the balance and
 * is taxed on withdrawal, not currently — hence `taxExemption: 'none'` is moot here. It
 * exercises the design-61 BondSleeveCouponHandler path that the all-equity default never
 * hit. Basis = market (deferred wrappers tax on contributions/earnings, not CGT).
 */
function _k401Holdings(p) {
  const total  = p.k401Balance ?? 0;
  const equity = +((total * STOCK_EQUITY_FRACTION).toFixed(2));
  const bond   = +((total - equity).toFixed(2));
  return [
    new Holding({
      id: 'h-401k-equity', label: '401(k) Equity', allocation: ALLOCATION.EQUITY,
      rateKey: RATE_KEYS.EQUITY_US, marketValue: equity, costBasis: equity,
    }),
    new Holding({
      id: 'h-401k-bond', label: '401(k) Bond', allocation: ALLOCATION.BOND,
      rateKey: RATE_KEYS.FIXED_INCOME_US, marketValue: bond, costBasis: bond,
      couponRate: DEFAULT_BOND_COUPON, duration: DEFAULT_BOND_DURATION, taxExemption: 'none',
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
