/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { DISTRIBUTION_TYPES } from '../../simulation-framework/distributions.js';
import { INTL_RETIREMENT_DEFAULTS } from '../../scenarios/intl-retirement-scenario.js';

const D = INTL_RETIREMENT_DEFAULTS;

/**
 * Default Monte Carlo variable configurations for the IntlRetirementScenario.
 *
 * Each entry maps a scenario parameter key to a distribution definition.
 * Only numeric parameters are included (Date, Boolean, and integer-step
 * params are handled separately in the UI).
 *
 * enabled:true  → perturbed by default when MC runs.
 * enabled:false → included in the UI for toggling; off by default.
 *
 * Distribution types reference DISTRIBUTION_TYPES constants.
 */
export const DEFAULT_MC_VARIABLE_CONFIGS = [

  // ── Equity growth rates (high uncertainty) ───────────────────────────────
  {
    paramKey: 'rothGrowthRate',        label: 'Roth IRA Growth Rate',
    type: DISTRIBUTION_TYPES.NORMAL,   mean: D.rothGrowthRate,   stdDev: 0.03,
    group: 'US Account Rates',         enabled: true,
  },
  {
    paramKey: 'iraGrowthRate',         label: 'Traditional IRA Growth Rate',
    type: DISTRIBUTION_TYPES.NORMAL,   mean: D.iraGrowthRate,    stdDev: 0.03,
    group: 'US Account Rates',         enabled: true,
  },
  {
    paramKey: 'k401GrowthRate',        label: '401(k) Growth Rate',
    type: DISTRIBUTION_TYPES.NORMAL,   mean: D.k401GrowthRate,   stdDev: 0.03,
    group: 'US Account Rates',         enabled: true,
  },
  {
    paramKey: 'usStockGrowthRate',     label: 'US Stock Growth Rate',
    type: DISTRIBUTION_TYPES.NORMAL,   mean: D.usStockGrowthRate, stdDev: 0.03,
    group: 'US Account Rates',         enabled: true,
  },
  {
    paramKey: 'stockDividendRate',     label: 'US Stock Dividend Rate',
    type: DISTRIBUTION_TYPES.NORMAL,   mean: D.stockDividendRate, stdDev: 0.005,
    group: 'US Account Rates',         enabled: true,
  },
  {
    paramKey: 'auStockGrowthRate',     label: 'AU Stock Growth Rate',
    type: DISTRIBUTION_TYPES.NORMAL,   mean: D.auStockGrowthRate, stdDev: 0.03,
    group: 'AU Account Rates',         enabled: true,
  },
  {
    paramKey: 'auStockDividendRate',   label: 'AU Stock Dividend Rate',
    type: DISTRIBUTION_TYPES.NORMAL,   mean: D.auStockDividendRate, stdDev: 0.005,
    group: 'AU Account Rates',         enabled: true,
  },

  // ── Spouse equity growth rates ────────────────────────────────────────────
  {
    paramKey: 'spouseRothGrowthRate',  label: 'Spouse Roth IRA Growth Rate',
    type: DISTRIBUTION_TYPES.NORMAL,   mean: D.spouseRothGrowthRate, stdDev: 0.03,
    group: 'Spouse Account Rates',     enabled: true,
  },
  {
    paramKey: 'spouseIraGrowthRate',   label: 'Spouse Traditional IRA Growth Rate',
    type: DISTRIBUTION_TYPES.NORMAL,   mean: D.spouseIraGrowthRate, stdDev: 0.03,
    group: 'Spouse Account Rates',     enabled: true,
  },
  {
    paramKey: 'spouseK401GrowthRate',  label: 'Spouse 401(k) Growth Rate',
    type: DISTRIBUTION_TYPES.NORMAL,   mean: D.spouseK401GrowthRate, stdDev: 0.03,
    group: 'Spouse Account Rates',     enabled: true,
  },
  {
    paramKey: 'spouseSuperGrowthRate', label: 'Spouse Super Growth Rate',
    type: DISTRIBUTION_TYPES.NORMAL,   mean: D.spouseSuperGrowthRate, stdDev: 0.03,
    group: 'Spouse Account Rates',     enabled: true,
  },

  // ── Cash / fixed income rates (lower uncertainty) ─────────────────────────
  {
    paramKey: 'usSavingsInterestRate', label: 'US Savings Interest Rate',
    type: DISTRIBUTION_TYPES.NORMAL,   mean: D.usSavingsInterestRate, stdDev: 0.01,
    group: 'US Account Rates',         enabled: true,
  },
  {
    paramKey: 'fixedIncomeInterestRate', label: 'Fixed Income Interest Rate',
    type: DISTRIBUTION_TYPES.NORMAL,   mean: D.fixedIncomeInterestRate, stdDev: 0.01,
    group: 'US Account Rates',         enabled: true,
  },
  {
    paramKey: 'auSavingsInterestRate', label: 'AU Savings Interest Rate',
    type: DISTRIBUTION_TYPES.NORMAL,   mean: D.auSavingsInterestRate, stdDev: 0.01,
    group: 'AU Account Rates',         enabled: true,
  },

  // ── Inflation rates ───────────────────────────────────────────────────────
  {
    paramKey: 'usInflationRate',       label: 'US Inflation Rate',
    type: DISTRIBUTION_TYPES.NORMAL,   mean: D.usInflationRate, stdDev: 0.01,
    group: 'Inflation',                enabled: true,
  },
  {
    paramKey: 'auInflationRate',       label: 'AU Inflation Rate',
    type: DISTRIBUTION_TYPES.NORMAL,   mean: D.auInflationRate, stdDev: 0.01,
    group: 'Inflation',                enabled: true,
  },

  // ── FX / transfer ─────────────────────────────────────────────────────────
  {
    paramKey: 'exchangeRateUsdToAud',  label: 'Exchange Rate USD→AUD',
    type: DISTRIBUTION_TYPES.NORMAL,   mean: D.exchangeRateUsdToAud, stdDev: 0.15,
    group: 'Transfer & Expenses',      enabled: true,
  },
  {
    paramKey: 'intlTransferFeeUsd',    label: 'International Transfer Fee (USD)',
    type: DISTRIBUTION_TYPES.CONSTANT, value: D.intlTransferFeeUsd,
    group: 'Transfer & Expenses',      enabled: false,
  },

  // ── Monthly expenses (disabled by default — users adjust for sensitivity) ──
  {
    paramKey: 'monthlyExpenses',       label: 'Monthly Expenses',
    type: DISTRIBUTION_TYPES.NORMAL,   mean: D.monthlyExpenses, stdDev: 200,
    group: 'Transfer & Expenses',      enabled: false,
  },

  // ── Wages (disabled by default) ───────────────────────────────────────────
  {
    paramKey: 'primaryMonthlyWage',    label: 'Primary Monthly Wage (USD)',
    type: DISTRIBUTION_TYPES.NORMAL,   mean: D.primaryMonthlyWage, stdDev: 500,
    group: 'People',                   enabled: false,
  },
  {
    paramKey: 'spouseMonthlyWage',     label: 'Spouse Monthly Wage (USD)',
    type: DISTRIBUTION_TYPES.NORMAL,   mean: D.spouseMonthlyWage, stdDev: 300,
    group: 'People',                   enabled: false,
  },

  // ── Account balances (disabled by default — starting values are known) ────
  {
    paramKey: 'initialUsSavings',      label: 'US Savings Initial Balance (USD)',
    type: DISTRIBUTION_TYPES.CONSTANT, value: D.initialUsSavings,
    group: 'US Account Balances',      enabled: false,
  },
  {
    paramKey: 'rothBalance',           label: 'Roth IRA Balance (USD)',
    type: DISTRIBUTION_TYPES.CONSTANT, value: D.rothBalance,
    group: 'US Account Balances',      enabled: false,
  },
  {
    paramKey: 'iraBalance',            label: 'Traditional IRA Balance (USD)',
    type: DISTRIBUTION_TYPES.CONSTANT, value: D.iraBalance,
    group: 'US Account Balances',      enabled: false,
  },
  {
    paramKey: 'k401Balance',           label: '401(k) Balance (USD)',
    type: DISTRIBUTION_TYPES.CONSTANT, value: D.k401Balance,
    group: 'US Account Balances',      enabled: false,
  },
  {
    paramKey: 'stockBalance',          label: 'US Stock Balance (USD)',
    type: DISTRIBUTION_TYPES.CONSTANT, value: D.stockBalance,
    group: 'US Account Balances',      enabled: false,
  },
  {
    paramKey: 'fixedIncomeBalance',    label: 'Fixed Income Balance (USD)',
    type: DISTRIBUTION_TYPES.CONSTANT, value: D.fixedIncomeBalance,
    group: 'US Account Balances',      enabled: false,
  },
  {
    paramKey: 'auSavingsBalance',      label: 'AU Savings Initial Balance (AUD)',
    type: DISTRIBUTION_TYPES.CONSTANT, value: D.auSavingsBalance,
    group: 'AU Account Balances',      enabled: false,
  },
  {
    paramKey: 'superBalance',          label: 'Superannuation Balance (AUD)',
    type: DISTRIBUTION_TYPES.CONSTANT, value: D.superBalance,
    group: 'AU Account Balances',      enabled: false,
  },
  {
    paramKey: 'auStockBalance',        label: 'AU Stock Balance (AUD)',
    type: DISTRIBUTION_TYPES.CONSTANT, value: D.auStockBalance,
    group: 'AU Account Balances',      enabled: false,
  },
  {
    paramKey: 'spouseRothBalance',     label: 'Spouse Roth IRA Balance (USD)',
    type: DISTRIBUTION_TYPES.CONSTANT, value: D.spouseRothBalance,
    group: 'Spouse Account Balances',  enabled: false,
  },
  {
    paramKey: 'spouseIraBalance',      label: 'Spouse Traditional IRA Balance (USD)',
    type: DISTRIBUTION_TYPES.CONSTANT, value: D.spouseIraBalance,
    group: 'Spouse Account Balances',  enabled: false,
  },
  {
    paramKey: 'spouseK401Balance',     label: 'Spouse 401(k) Balance (USD)',
    type: DISTRIBUTION_TYPES.CONSTANT, value: D.spouseK401Balance,
    group: 'Spouse Account Balances',  enabled: false,
  },
  {
    paramKey: 'spouseSuperBalance',    label: 'Spouse Superannuation Balance (AUD)',
    type: DISTRIBUTION_TYPES.CONSTANT, value: D.spouseSuperBalance,
    group: 'Spouse Account Balances',  enabled: false,
  },
];
