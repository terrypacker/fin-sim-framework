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
import { US_RETIREMENT }       from './toolsets/us-retirement-toolset.js';
import { AU_BANKING }          from './toolsets/au-banking-toolset.js';
import { AU_TAX }              from './toolsets/au-tax-toolset.js';
import { AU_RETIREMENT }       from './toolsets/au-retirement-toolset.js';
import { US_AU_CROSS_BORDER }  from './toolsets/us-au-cross-border-toolset.js';
import { US_REAL_PROPERTY }    from './toolsets/us-real-property-toolset.js';
import { AU_REAL_PROPERTY }    from './toolsets/au-real-property-toolset.js';
import { US_COLLECTIBLES }     from './toolsets/us-collectibles-toolset.js';
import { US_ROTH_CONVERSION }  from './toolsets/us-roth-conversion-toolset.js';
import { US_BROKERAGE }        from './toolsets/us-brokerage-toolset.js';
import { AU_BROKERAGE }        from './toolsets/au-brokerage-toolset.js';
import { US_INCOME }           from './toolsets/us-income-toolset.js';
import { AU_INCOME }           from './toolsets/au-income-toolset.js';
import { ServiceRegistry }     from '../services/service-registry.js';
import { USD, AUD }            from '../finance/assets/account.js';
import { ACCOUNT_ROLES }       from '../finance/state/account-roles.js';

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

  // US investment accounts
  rothBalance:   80_000,  rothBasis:   60_000,
  iraBalance:   200_000,  iraBasis:   150_000,
  k401Balance:  300_000,  k401Basis:  200_000,
  stockBalance: 150_000,  stockBasis:  90_000,
  stockDividendRate:    0.02,
  stockDividendReinvest: false,
  fixedIncomeBalance:   80_000,
  fixedIncomeInterestRate: 0.04,

  // US investment growth rates (annual, separate from dividends)
  rothGrowthRate:   0.07,
  iraGrowthRate:    0.07,
  k401GrowthRate:   0.07,
  usStockGrowthRate: 0.05,

  // Spouse retirement accounts (US)
  spouseRothBalance:  40_000,  spouseRothBasis:  30_000,  spouseRothGrowthRate:  0.07,
  spouseIraBalance:  100_000,  spouseIraBasis:   75_000,  spouseIraGrowthRate:   0.07,
  spouseK401Balance: 150_000,  spouseK401Basis: 100_000,  spouseK401GrowthRate:  0.07,

  // Spouse retirement account (AU)
  spouseSuperBalance: 125_000,  spouseSuperBasis: 90_000,  spouseSuperGrowthRate: 0.07,

  // AU accounts
  auSavingsBalance:     50_000,
  auSavingsMinBalance:   3_000,  auSavingsInterestRate: 0.045,
  superBalance:        250_000,  superBasis:           180_000,
  auStockBalance:       60_000,  auStockBasis:          40_000,
  auStockGrowthRate:   0.06,
  auStockDividendRate: 0.04,

  // International transfer
  exchangeRateUsdToAud: 1.55,  // 1 USD = 1.55 AUD
  intlTransferFeeUsd:   15,    // fixed fee per transfer in USD

  // Expenses (local currency: USD pre-move, AUD post-move)
  monthlyExpenses: 6_000,

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
    key: 'primaryRetirementDate', label: 'Primary Retirement Date',
    type: 'Date', group: 'People', mc: false, opt: true,
    defaultValue: INTL_RETIREMENT_DEFAULTS.primaryRetirementDate.toISOString().slice(0, 10),
    description: 'Date primary person stops working',
    node: { type: 'person', id: 'primary', field: 'retirementDate' },
  },
  {
    key: 'spouseRetirementDate', label: 'Spouse Retirement Date',
    type: 'Date', group: 'People', mc: false, opt: true,
    defaultValue: INTL_RETIREMENT_DEFAULTS.spouseRetirementDate.toISOString().slice(0, 10),
    description: 'Date spouse stops working',
    node: { type: 'person', id: 'spouse', field: 'retirementDate' },
  },
  {
    key: 'primaryMonthlyWage', label: 'Primary Monthly Wage (USD)',
    type: 'Number', group: 'People', mc: true, opt: true,
    defaultValue: INTL_RETIREMENT_DEFAULTS.primaryMonthlyWage,
    description: 'Gross monthly wage for primary before retirement',
    node: { type: 'person', id: 'primary', field: 'monthlyWage' },
  },
  {
    key: 'spouseMonthlyWage', label: 'Spouse Monthly Wage (USD)',
    type: 'Number', group: 'People', mc: true, opt: true,
    defaultValue: INTL_RETIREMENT_DEFAULTS.spouseMonthlyWage,
    description: 'Gross monthly wage for spouse before retirement',
    node: { type: 'person', id: 'spouse', field: 'monthlyWage' },
  },
  {
    key: 'moveYear', label: 'US→AU Move Year',
    type: 'Number', group: 'People', mc: false, opt: true,
    defaultValue: INTL_RETIREMENT_DEFAULTS.moveYear,
    description: 'Calendar year of US→AU migration (Jul 1)',
  },
  {
    key: 'stockDividendReinvest', label: 'Reinvest US Stock Dividends',
    type: 'Boolean', group: 'People', mc: false, opt: true,
    defaultValue: INTL_RETIREMENT_DEFAULTS.stockDividendReinvest,
    description: 'If false, US stock dividends are taken as cash',
  },

  // ── US Account Balances ────────────────────────────────────────────────────
  {
    key: 'initialUsSavings', label: 'US Savings Initial Balance (USD)',
    type: 'Number', group: 'US Account Balances', mc: true, opt: false,
    defaultValue: INTL_RETIREMENT_DEFAULTS.initialUsSavings,
    description: 'Starting US cash savings balance',
    node: { type: 'account', stateKey: 'usSavingsAccount', field: 'initialValue' },
  },
  {
    key: 'rothBalance', label: 'Roth IRA Balance (USD)',
    type: 'Number', group: 'US Account Balances', mc: true, opt: false,
    defaultValue: INTL_RETIREMENT_DEFAULTS.rothBalance,
    description: 'Starting Roth IRA balance',
    node: { type: 'account', stateKey: 'rothAccount', field: 'initialValue' },
  },
  {
    key: 'iraBalance', label: 'Traditional IRA Balance (USD)',
    type: 'Number', group: 'US Account Balances', mc: true, opt: false,
    defaultValue: INTL_RETIREMENT_DEFAULTS.iraBalance,
    description: 'Starting Traditional IRA balance',
    node: { type: 'account', stateKey: 'iraAccount', field: 'initialValue' },
  },
  {
    key: 'k401Balance', label: '401(k) Balance (USD)',
    type: 'Number', group: 'US Account Balances', mc: true, opt: false,
    defaultValue: INTL_RETIREMENT_DEFAULTS.k401Balance,
    description: 'Starting 401(k) balance',
    node: { type: 'account', stateKey: 'k401Account', field: 'initialValue' },
  },
  {
    key: 'stockBalance', label: 'US Stock Balance (USD)',
    type: 'Number', group: 'US Account Balances', mc: true, opt: false,
    defaultValue: INTL_RETIREMENT_DEFAULTS.stockBalance,
    description: 'Starting US brokerage stock balance',
    node: { type: 'account', stateKey: 'usStockAccount', field: 'initialValue' },
  },
  {
    key: 'fixedIncomeBalance', label: 'Fixed Income Balance (USD)',
    type: 'Number', group: 'US Account Balances', mc: true, opt: false,
    defaultValue: INTL_RETIREMENT_DEFAULTS.fixedIncomeBalance,
    description: 'Starting fixed income account balance',
    node: { type: 'account', stateKey: 'fixedIncomeAccount', field: 'initialValue' },
  },

  // ── AU Account Balances ────────────────────────────────────────────────────
  {
    key: 'auSavingsBalance', label: 'AU Savings Initial Balance (AUD)',
    type: 'Number', group: 'AU Account Balances', mc: true, opt: false,
    defaultValue: INTL_RETIREMENT_DEFAULTS.auSavingsBalance,
    description: 'Starting AU cash savings balance',
    node: { type: 'account', stateKey: 'auSavingsAccount', field: 'initialValue' },
  },
  {
    key: 'superBalance', label: 'Superannuation Balance (AUD)',
    type: 'Number', group: 'AU Account Balances', mc: true, opt: false,
    defaultValue: INTL_RETIREMENT_DEFAULTS.superBalance,
    description: 'Starting superannuation balance',
    node: { type: 'account', stateKey: 'superAccount', field: 'initialValue' },
  },
  {
    key: 'auStockBalance', label: 'AU Stock Balance (AUD)',
    type: 'Number', group: 'AU Account Balances', mc: true, opt: false,
    defaultValue: INTL_RETIREMENT_DEFAULTS.auStockBalance,
    description: 'Starting AU brokerage stock balance',
    node: { type: 'account', stateKey: 'auStockAccount', field: 'initialValue' },
  },

  // ── Spouse Account Balances ────────────────────────────────────────────────
  {
    key: 'spouseRothBalance', label: 'Spouse Roth IRA Balance (USD)',
    type: 'Number', group: 'Spouse Account Balances', mc: true, opt: false,
    defaultValue: INTL_RETIREMENT_DEFAULTS.spouseRothBalance,
    description: 'Starting Roth IRA balance for spouse',
    node: { type: 'account', stateKey: 'spouseRothAccount', field: 'initialValue' },
  },
  {
    key: 'spouseIraBalance', label: 'Spouse Traditional IRA Balance (USD)',
    type: 'Number', group: 'Spouse Account Balances', mc: true, opt: false,
    defaultValue: INTL_RETIREMENT_DEFAULTS.spouseIraBalance,
    description: 'Starting Traditional IRA balance for spouse',
    node: { type: 'account', stateKey: 'spouseIraAccount', field: 'initialValue' },
  },
  {
    key: 'spouseK401Balance', label: 'Spouse 401(k) Balance (USD)',
    type: 'Number', group: 'Spouse Account Balances', mc: true, opt: false,
    defaultValue: INTL_RETIREMENT_DEFAULTS.spouseK401Balance,
    description: 'Starting 401(k) balance for spouse',
    node: { type: 'account', stateKey: 'spouseK401Account', field: 'initialValue' },
  },
  {
    key: 'spouseSuperBalance', label: 'Spouse Superannuation Balance (AUD)',
    type: 'Number', group: 'Spouse Account Balances', mc: true, opt: false,
    defaultValue: INTL_RETIREMENT_DEFAULTS.spouseSuperBalance,
    description: 'Starting superannuation balance for spouse',
    node: { type: 'account', stateKey: 'spouseSuperAccount', field: 'initialValue' },
  },

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

  // ── US Account Rates ───────────────────────────────────────────────────────
  {
    key: 'usSavingsInterestRate', label: 'US Savings Interest Rate',
    type: 'Number', group: 'US Account Rates', mc: true, opt: true,
    defaultValue: INTL_RETIREMENT_DEFAULTS.usSavingsInterestRate,
    description: 'Annual interest rate on US cash savings',
  },
  {
    key: 'rothGrowthRate', label: 'Roth IRA Growth Rate',
    type: 'Number', group: 'US Account Rates', mc: true, opt: false,
    defaultValue: INTL_RETIREMENT_DEFAULTS.rothGrowthRate,
    description: 'Annual growth rate for Roth IRA',
  },
  {
    key: 'iraGrowthRate', label: 'Traditional IRA Growth Rate',
    type: 'Number', group: 'US Account Rates', mc: true, opt: false,
    defaultValue: INTL_RETIREMENT_DEFAULTS.iraGrowthRate,
    description: 'Annual growth rate for Traditional IRA',
  },
  {
    key: 'k401GrowthRate', label: '401(k) Growth Rate',
    type: 'Number', group: 'US Account Rates', mc: true, opt: false,
    defaultValue: INTL_RETIREMENT_DEFAULTS.k401GrowthRate,
    description: 'Annual growth rate for 401(k)',
  },
  {
    key: 'usStockGrowthRate', label: 'US Stock Growth Rate',
    type: 'Number', group: 'US Account Rates', mc: true, opt: false,
    defaultValue: INTL_RETIREMENT_DEFAULTS.usStockGrowthRate,
    description: 'Annual capital growth rate for US brokerage stock',
  },
  {
    key: 'stockDividendRate', label: 'US Stock Dividend Rate',
    type: 'Number', group: 'US Account Rates', mc: true, opt: false,
    defaultValue: INTL_RETIREMENT_DEFAULTS.stockDividendRate,
    description: 'Annual dividend yield on US stock',
  },
  {
    key: 'fixedIncomeInterestRate', label: 'Fixed Income Interest Rate',
    type: 'Number', group: 'US Account Rates', mc: true, opt: true,
    defaultValue: INTL_RETIREMENT_DEFAULTS.fixedIncomeInterestRate,
    description: 'Annual interest rate on fixed income',
  },

  // ── AU Account Rates ───────────────────────────────────────────────────────
  {
    key: 'auSavingsInterestRate', label: 'AU Savings Interest Rate',
    type: 'Number', group: 'AU Account Rates', mc: true, opt: true,
    defaultValue: INTL_RETIREMENT_DEFAULTS.auSavingsInterestRate,
    description: 'Annual interest rate on AU cash savings',
  },
  {
    key: 'auStockGrowthRate', label: 'AU Stock Growth Rate',
    type: 'Number', group: 'AU Account Rates', mc: true, opt: false,
    defaultValue: INTL_RETIREMENT_DEFAULTS.auStockGrowthRate,
    description: 'Annual capital growth rate for AU stock',
  },
  {
    key: 'auStockDividendRate', label: 'AU Stock Dividend Rate',
    type: 'Number', group: 'AU Account Rates', mc: true, opt: false,
    defaultValue: INTL_RETIREMENT_DEFAULTS.auStockDividendRate,
    description: 'Annual dividend yield on AU stock',
  },

  // ── Min Balances ───────────────────────────────────────────────────────────
  {
    key: 'usSavingsMinBalance', label: 'US Savings Min Balance (USD)',
    type: 'Number', group: 'Min Balances', mc: false, opt: true,
    defaultValue: INTL_RETIREMENT_DEFAULTS.usSavingsMinBalance,
    description: 'Minimum US cash reserve before drawing investments',
    node: { type: 'account', stateKey: 'usSavingsAccount', field: 'minimumBalance' },
  },
  {
    key: 'auSavingsMinBalance', label: 'AU Savings Min Balance (AUD)',
    type: 'Number', group: 'Min Balances', mc: false, opt: true,
    defaultValue: INTL_RETIREMENT_DEFAULTS.auSavingsMinBalance,
    description: 'Minimum AU cash reserve before drawing investments',
    node: { type: 'account', stateKey: 'auSavingsAccount', field: 'minimumBalance' },
  },

  // ── Transfer & Expenses ────────────────────────────────────────────────────
  {
    key: 'exchangeRateUsdToAud', label: 'Exchange Rate USD→AUD',
    type: 'Number', group: 'Transfer & Expenses', mc: true, opt: false,
    defaultValue: INTL_RETIREMENT_DEFAULTS.exchangeRateUsdToAud,
    description: 'USD to AUD exchange rate applied on transfers',
  },
  {
    key: 'intlTransferFeeUsd', label: 'International Transfer Fee (USD)',
    type: 'Number', group: 'Transfer & Expenses', mc: true, opt: false,
    defaultValue: INTL_RETIREMENT_DEFAULTS.intlTransferFeeUsd,
    description: 'Fixed fee per international wire transfer',
  },
  {
    key: 'monthlyExpenses', label: 'Monthly Expenses',
    type: 'Number', group: 'Transfer & Expenses', mc: true, opt: true,
    defaultValue: INTL_RETIREMENT_DEFAULTS.monthlyExpenses,
    description: 'Monthly living expenses in local currency',
  },

  // ── Inflation ──────────────────────────────────────────────────────────────
  {
    key: 'usInflationRate', label: 'US Inflation Rate',
    type: 'Number', group: 'Inflation', mc: true, opt: false,
    defaultValue: INTL_RETIREMENT_DEFAULTS.usInflationRate,
    description: 'Annual US inflation rate applied to USD expenses',
  },
  {
    key: 'auInflationRate', label: 'AU Inflation Rate',
    type: 'Number', group: 'Inflation', mc: true, opt: false,
    defaultValue: INTL_RETIREMENT_DEFAULTS.auInflationRate,
    description: 'Annual AU inflation rate applied to AUD expenses',
  },

  // ── Roth Conversion ────────────────────────────────────────────────────────
  {
    key: 'rothConversionEnabled', label: 'Roth Conversion Enabled',
    type: 'Boolean', group: 'Roth Conversion', mc: false, opt: false,
    defaultValue: INTL_RETIREMENT_DEFAULTS.rothConversionEnabled,
    description: 'Enable bracket-fill Roth conversion policy',
  },
  {
    key: 'rothConversionStartYear', label: 'Roth Conversion Start Year',
    type: 'Number', group: 'Roth Conversion', mc: false, opt: true,
    defaultValue: INTL_RETIREMENT_DEFAULTS.rothConversionStartYear,
    description: 'First year to convert; null = primary retirement year',
  },
  {
    key: 'rothConversionEndYear', label: 'Roth Conversion End Year',
    type: 'Number', group: 'Roth Conversion', mc: false, opt: true,
    defaultValue: INTL_RETIREMENT_DEFAULTS.rothConversionEndYear,
    description: 'Last year to convert; null = year before RMD start at age 73',
  },
  {
    key: 'rothConversionMaxBracket', label: 'Roth Conversion Max Bracket Rate',
    type: 'Number', group: 'Roth Conversion', mc: false, opt: true,
    defaultValue: INTL_RETIREMENT_DEFAULTS.rothConversionMaxBracket,
    description: 'Fill ordinary income up to top of this marginal bracket',
  },
  {
    key: 'rothConversionOwner', label: 'Roth Conversion Owner',
    type: 'String', group: 'Roth Conversion', mc: false, opt: false,
    defaultValue: INTL_RETIREMENT_DEFAULTS.rothConversionOwner,
    description: "Whose IRA to convert: 'primary', 'spouse', or 'both'",
  },
  {
    key: 'rothConversionMonth', label: 'Roth Conversion Month',
    type: 'Number', group: 'Roth Conversion', mc: false, opt: false,
    defaultValue: INTL_RETIREMENT_DEFAULTS.rothConversionMonth,
    description: 'Month (1–12) when the policy fires each year',
  },
  {
    key: 'rothConversionDay', label: 'Roth Conversion Day',
    type: 'Number', group: 'Roth Conversion', mc: false, opt: false,
    defaultValue: INTL_RETIREMENT_DEFAULTS.rothConversionDay,
    description: 'Day of month when the policy fires each year',
  },
];

/**
 * IntlRetirementScenario — International two-person retirement simulation.
 *
 * Two people (primary + spouse), US→AU migration on Jul 1 of moveYear.
 * Wired entirely through the toolset compiler path (Path 2 in BaseApp):
 * getToolsets() declares all 11 toolsets; buildDefaultConfig() produces the
 * serialized persons/accounts/realProperties/collectibles for a fresh load.
 */
export class IntlRetirementScenario extends BaseScenario {
  static getParamSchema() { return INTL_RETIREMENT_PARAM_SCHEMA; }

  static getToolsets() {
    return [
      'US_BANKING', 'US_TAX', 'US_BROKERAGE', 'US_INCOME', 'US_RETIREMENT',
      'AU_BANKING', 'AU_TAX', 'AU_BROKERAGE', 'AU_INCOME', 'AU_RETIREMENT',
      'US_AU_CROSS_BORDER',
      'US_REAL_PROPERTY', 'AU_REAL_PROPERTY',
      'US_COLLECTIBLES', 'US_ROTH_CONVERSION',
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

    const isoDate = d => d.toISOString().slice(0, 10);

    return {
      toolsets: IntlRetirementScenario.getToolsets(),
      simStart:       (simStart ?? isoDate(new Date(Date.UTC(2026, 0, 1)))),
      simEnd:         (simEnd   ?? isoDate(new Date(Date.UTC(2041, 0, 1)))),

      // ── Parameters (toolset-key names) ──────────────────────────────────────
      parameters: {
        // US_BANKING
        usSavingsInterestRate:    p.usSavingsInterestRate,
        // US_RETIREMENT / AU_RETIREMENT share 'inflationRate'; US_AU_CROSS_BORDER uses both
        inflationRate:            p.usInflationRate,
        auInflationRate:          p.auInflationRate,
        iraGrowthRate:            p.iraGrowthRate,
        rothGrowthRate:           p.rothGrowthRate,
        k401GrowthRate:           p.k401GrowthRate,
        brokerageGrowthRate:      p.usStockGrowthRate,
        brokerageDividendRate:    p.stockDividendRate,
        dividendReinvest:         p.stockDividendReinvest,
        fixedIncomeInterestRate:  p.fixedIncomeInterestRate,
        monthlyExpenses:          p.monthlyExpenses,
        inflationAdjust:          true,
        // AU_BANKING
        auSavingsInterestRate:    p.auSavingsInterestRate,
        // AU_RETIREMENT
        superGrowthRate:          p.spouseSuperGrowthRate ?? 0.07,
        auStockGrowthRate:        p.auStockGrowthRate,
        auStockDividendRate:      p.auStockDividendRate,
        // US_AU_CROSS_BORDER
        moveYear:                 p.moveYear,
        exchangeRateUsdToAud:     p.exchangeRateUsdToAud,
        intlTransferFeeUsd:       p.intlTransferFeeUsd,
        isAuResident:             false,
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
          monthlyWage:    p.primaryMonthlyWage,
          retirementDate: isoDate(p.primaryRetirementDate),
          lifeExpectancy: 90, socialSecurityMonthly: 2000,
        },
        {
          __type: 'Person', id: 'spouse', name: 'Spouse',
          birthDate:      isoDate(p.spouseBirthDate),
          citizen:        ['US'],
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
          __type: 'Account',              stateKey: 'usSavingsAccount',
          name: 'US Savings',             role: ACCOUNT_ROLES.US_SAVINGS,
          initialValue: p.initialUsSavings, ownershipType: 'joint', ownerId: 'primary',
          minimumBalance: p.usSavingsMinBalance, country: 'US', currency: USD,
        },
        {
          __type: 'Account',              stateKey: 'fixedIncomeAccount',
          name: 'Fixed Income',           role: ACCOUNT_ROLES.FIXED_INCOME,
          initialValue: p.fixedIncomeBalance, ownerId: 'primary',
          drawdownPriority: 1,            contributionBasis: 0,
          country: 'US', currency: USD,
        },
        {
          __type: 'BrokerageAccount',     stateKey: 'usStockAccount',
          name: 'US Stock',               role: ACCOUNT_ROLES.US_STOCK,
          initialValue: p.stockBalance,   contributionBasis: p.stockBasis,
          ownerId: 'primary',             drawdownPriority: 2,
          country: 'US', currency: USD,
        },
        {
          __type: 'TraditionalIRAAccount', stateKey: 'iraAccount',
          name: 'Traditional IRA',        role: ACCOUNT_ROLES.IRA,
          initialValue: p.iraBalance,     contributionBasis: p.iraBasis,
          ownerId: 'primary',             drawdownPriority: 3,
          country: 'US', currency: USD,
        },
        {
          __type: 'FourOhOneKAccount',    stateKey: 'k401Account',
          name: '401(k)',                 role: ACCOUNT_ROLES.K401,
          initialValue: p.k401Balance,    contributionBasis: p.k401Basis,
          ownerId: 'primary',             drawdownPriority: 4,
          country: 'US', currency: USD,
        },
        {
          __type: 'RothAccount',          stateKey: 'rothAccount',
          name: 'Roth IRA',              role: ACCOUNT_ROLES.ROTH,
          initialValue: p.rothBalance,    contributionBasis: p.rothBasis,
          ownerId: 'primary',             drawdownPriority: 5,
          country: 'US', currency: USD,
        },
        {
          __type: 'Account',              stateKey: 'auSavingsAccount',
          name: 'AU Savings',             role: ACCOUNT_ROLES.AU_SAVINGS,
          initialValue: p.auSavingsBalance, ownershipType: 'joint', ownerId: 'primary',
          minimumBalance: p.auSavingsMinBalance, country: 'AU', currency: AUD,
        },
        {
          __type: 'BrokerageAccount',     stateKey: 'auStockAccount',
          name: 'AU Stock',               role: ACCOUNT_ROLES.AU_STOCK,
          initialValue: p.auStockBalance, contributionBasis: p.auStockBasis,
          ownerId: 'primary',             drawdownPriority: 1,
          country: 'AU', currency: AUD,
        },
        {
          __type: 'SuperannuationAccount', stateKey: 'superAccount',
          name: 'Superannuation',          role: ACCOUNT_ROLES.SUPER,
          initialValue: p.superBalance,   contributionBasis: p.superBasis,
          ownerId: 'primary',             drawdownPriority: 2,
          minimumAge: 60,                 country: 'AU', currency: AUD,
        },
        // Spouse accounts
        {
          __type: 'RothAccount',           stateKey: 'spouseRothAccount',
          name: 'Roth IRA (Spouse)',       role: ACCOUNT_ROLES.ROTH,
          initialValue: p.spouseRothBalance, contributionBasis: p.spouseRothBasis,
          ownerId: 'spouse',               drawdownPriority: 8,
          country: 'US', currency: USD,
        },
        {
          __type: 'TraditionalIRAAccount', stateKey: 'spouseIraAccount',
          name: 'Traditional IRA (Spouse)', role: ACCOUNT_ROLES.IRA,
          initialValue: p.spouseIraBalance, contributionBasis: p.spouseIraBasis,
          ownerId: 'spouse',               drawdownPriority: 6,
          country: 'US', currency: USD,
        },
        {
          __type: 'FourOhOneKAccount',     stateKey: 'spouseK401Account',
          name: '401(k) (Spouse)',         role: ACCOUNT_ROLES.K401,
          initialValue: p.spouseK401Balance, contributionBasis: p.spouseK401Basis,
          ownerId: 'spouse',               drawdownPriority: 7,
          country: 'US', currency: USD,
        },
        {
          __type: 'SuperannuationAccount', stateKey: 'spouseSuperAccount',
          name: 'Superannuation (Spouse)', role: ACCOUNT_ROLES.SUPER,
          initialValue: p.spouseSuperBalance, contributionBasis: p.spouseSuperBasis,
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
        },
        {
          __type: 'RealProperty', name: 'AU House', stateKey: 'auHouseProperty',
          value: 1_000_000, costBasis: 900_000, appreciationRate: 0.04,
          isPrimaryResidence: true, ownershipType: 'joint', ownerId: 'primary',
          country: 'AU',
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
    };
  }

  /**
   * Convenience factory: reset-proof builder that creates the scenario, runs
   * the full toolset compilation path, and returns the scenario.
   *
   * Callers must call ServiceRegistry.reset() before invoking this if they
   * want an isolated simulation (e.g. MC runner, optimizer, unit tests).
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
    toolsetRegistry.register(US_RETIREMENT);
    toolsetRegistry.register(AU_BANKING);
    toolsetRegistry.register(AU_TAX);
    toolsetRegistry.register(AU_RETIREMENT);
    toolsetRegistry.register(US_AU_CROSS_BORDER);
    toolsetRegistry.register(US_REAL_PROPERTY);
    toolsetRegistry.register(AU_REAL_PROPERTY);
    toolsetRegistry.register(US_COLLECTIBLES);
    toolsetRegistry.register(US_ROTH_CONVERSION);
    toolsetRegistry.register(US_BROKERAGE);
    toolsetRegistry.register(AU_BROKERAGE);
    toolsetRegistry.register(US_INCOME);
    toolsetRegistry.register(AU_INCOME);
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
