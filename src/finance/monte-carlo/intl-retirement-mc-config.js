/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { DISTRIBUTION_TYPES }       from '../../simulation-framework/distributions.js';
import { INTL_RETIREMENT_DEFAULTS } from '../../scenarios/intl-retirement-scenario.js';
import { SHOCK_LIBRARY }            from '../economic-shocks/shock-library.js';
import { get }                      from './mc-param-paths.js';

const D = INTL_RETIREMENT_DEFAULTS;

/**
 * Static Monte Carlo variable configurations for the IntlRetirementScenario.
 *
 * Each entry maps a flat scenario parameter key to a distribution definition.
 * Shock variables are generated dynamically by buildShockMcConfigs() based on
 * the scenario's configured shocks array.
 *
 * enabled:true  → perturbed by default when MC runs.
 * enabled:false → included in the UI for toggling; off by default.
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

/**
 * Build one set of MC variables per configured shock.
 *
 * For preset-form entries ({ preset, startDate }), severity is read from the
 * library template so the distribution has a meaningful default center even
 * when the entry doesn't carry an explicit severity field.
 */
function buildShockMcConfigs(params) {
  const shocks = params.shocks ?? [];
  return shocks.flatMap((entry, i) => {
    if (!entry) return [];
    const label         = entry.preset ?? entry.shockId ?? `Shock ${i + 1}`;
    const libraryShock  = entry.preset ? (SHOCK_LIBRARY[entry.preset] ?? {}) : {};
    const severityDefault = entry.severity ?? libraryShock.severity ?? 0.4;
    return [
      {
        paramKey: `shocks[${i}].severity`,
        label:    `${label}: severity`,
        type:     DISTRIBUTION_TYPES.NORMAL,
        mean:     severityDefault,
        stdDev:   0.10,
        group:    'Economic Shocks',
        enabled:  false,
      },
      {
        paramKey: `shocks[${i}].startDate`,
        label:    `${label}: start date`,
        type:     DISTRIBUTION_TYPES.UNIFORM_DATE,
        min:      '2028-01-01',
        max:      '2035-01-01',
        group:    'Economic Shocks',
        enabled:  false,
      },
    ];
  });
}

/**
 * MC configuration for IntlRetirementScenario.
 *
 * Uses a contributor pattern so toolsets (design 26 healthcare, design 27
 * mortality) can register dynamic variable sets without changing the runner.
 *
 * buildVariables(params) produces the full variable list for a given param
 * snapshot, including dynamic per-shock variables from configured shocks[].
 */
export class IntlRetirementMcConfig {
  static contributors = [
    ()          => DEFAULT_MC_VARIABLE_CONFIGS,
    ({ params }) => buildShockMcConfigs(params),
  ];

  constructor() {
    // paramKey → user override object (enabled, mean, stdDev, etc.)
    this._overrides = new Map();
  }

  /** Store a user override for a specific variable by paramKey. */
  applyOverride(paramKey, override) {
    // Strip paramKey from the override — it must never clobber the resolved path.
    const { paramKey: _ignored, ...rest } = override;
    this._overrides.set(paramKey, { ...(this._overrides.get(paramKey) ?? {}), ...rest });
  }

  /**
   * Build the resolved variable list for a given param snapshot.
   *
   * - Runs all contributors with the params.
   * - Drops variables whose path doesn't resolve in the params tree
   *   (prevents stale shock[N] configs from poisoning a run).
   * - Fills `defaultValue` and resolves `mean` from the scenario value
   *   when the config omits it.
   * - Applies any user overrides stored via applyOverride().
   */
  buildVariables(params) {
    return this.constructor.contributors
      .flatMap(fn => fn({ params }))
      .filter(cfg => {
        // Non-array-indexed keys (flat or dot-separated): always keep.
        // Their cfg.value/cfg.mean acts as the reference when the key is absent
        // from params, so r.params stays complete even with sparse baseParams.
        if (!cfg.paramKey.includes('[')) return true;
        // Array-indexed paths (e.g. shocks[0].severity): keep only when the
        // parent array entry exists — drops stale shock[N] configs without error.
        const val = get(params, cfg.paramKey);
        if (val !== undefined) return true;
        const arrayMatch = cfg.paramKey.match(/^(\w+\[\d+\])/);
        if (arrayMatch) return get(params, arrayMatch[1]) !== undefined;
        console.warn(`[IntlRetirementMcConfig] dropping unresolvable MC variable: ${cfg.paramKey}`);
        return false;
      })
      .map(cfg => {
        const defaultValue = get(params, cfg.paramKey);
        const override     = this._overrides.get(cfg.paramKey) ?? {};
        return {
          ...cfg,
          defaultValue,
          mean: cfg.mean ?? defaultValue,
          ...override,
        };
      });
  }

  /**
   * Create an IntlRetirementMcConfig with user states loaded from a flat
   * variableConfigs array (as produced by McConfigPanel).
   *
   * Rewrites legacy flat shock keys to nested paths:
   *   shockSeverity  → shocks[0].severity
   *   shockStartDate → shocks[0].startDate
   */
  static fromVariableConfigs(variableConfigs) {
    const config = new IntlRetirementMcConfig();
    for (const v of variableConfigs) {
      let key = v.paramKey;
      if (key === 'shockSeverity')  key = 'shocks[0].severity';
      if (key === 'shockStartDate') key = 'shocks[0].startDate';
      config.applyOverride(key, v);
    }
    return config;
  }
}
