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
import { INTL_RETIREMENT_DEFAULTS, IntlRetirementScenario } from '../../scenarios/intl-retirement-scenario.js';
import { SHOCK_LIBRARY }            from '../economic-shocks/shock-library.js';
import { get }                      from './mc-param-paths.js';
import { lookupLifeTable }          from './life-tables.js';
import { indexParamSchema, resolveSweepVariables } from '../param-schema-utils.js';

const D = INTL_RETIREMENT_DEFAULTS;

// Lazily index the full param schema by key so MC variables can inherit identity
// (label / options / visibleWhen) from it rather than duplicating it here.
let _schemaByKey = null;
function schemaByKey() {
  if (!_schemaByKey) _schemaByKey = indexParamSchema(IntlRetirementScenario.buildFullParamSchema());
  return _schemaByKey;
}

/**
 * Static Monte Carlo variable configurations for the IntlRetirementScenario.
 *
 * Each entry maps a flat scenario parameter key to a distribution definition.
 * Shock variables are generated dynamically by buildShockMcConfigs() based on
 * the scenario's configured shocks array.
 *
 * enabled:true  → perturbed by default when MC runs.
 * enabled:false → included in the UI for toggling; off by default.
 *
 * `paramKey` MUST be the toolset parameter key the compiler reads (e.g.
 * `brokerageGrowthRate`, not the `usStockGrowthRate` scenario-default alias) —
 * the runner writes the sampled value to `cfg.parameters[paramKey]`, so a
 * non-toolset key is silently discarded. `label` may differ for clarity.
 *
 * Identity is the param schema's job: `visibleWhen` is always inherited from the
 * schema by paramKey (buildVariables → resolveSweepVariables), and `label` is
 * inherited when omitted here. A new entry needs only `paramKey` + distribution
 * metadata; add `label` only to override the schema's.
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
    paramKey: 'brokerageGrowthRate',   label: 'US Stock Growth Rate',
    type: DISTRIBUTION_TYPES.NORMAL,   mean: D.usStockGrowthRate, stdDev: 0.03,
    group: 'US Account Rates',         enabled: true,
  },
  {
    paramKey: 'brokerageDividendRate', label: 'US Stock Dividend Rate',
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
    paramKey: 'inflationRate',         label: 'US Inflation Rate',
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
 * Build MC variables for real property sale years.
 *
 * Only emits a variable when the param is non-null — a null sale year has no
 * meaningful distribution center, so there is nothing to perturb.
 * stdDev of 1.5 years covers realistic uncertainty about timing (roughly ±3 yr
 * at 2σ).  The runner rounds sampled values to integer before use.
 */
function buildRealPropertyMcConfigs(params) {
  const vars = [];
  if (params.usHouseSaleYear != null) {
    vars.push({
      paramKey: 'usHouseSaleYear', label: 'US House Sale Year',
      type: DISTRIBUTION_TYPES.NORMAL,
      mean:   params.usHouseSaleYear,
      stdDev: 1.5,
      group:  'Real Properties',
      enabled: false,
    });
  }
  if (params.auHouseSaleYear != null) {
    vars.push({
      paramKey: 'auHouseSaleYear', label: 'AU House Sale Year',
      type: DISTRIBUTION_TYPES.NORMAL,
      mean:   params.auHouseSaleYear,
      stdDev: 1.5,
      group:  'Real Properties',
      enabled: false,
    });
  }
  return vars;
}

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
 * Build one MC variable per person for actuarial lifespan draws (design/27 §5).
 *
 * Table is residency-keyed at registration time (boot-time residency only;
 * no mid-run redraw per §10 Q1 Path A).  Variables are enabled:false by default
 * so single runs are unaffected — MC opt-in only.
 *
 * Expects params.people to be a { [personKey]: { lifeExpectancy, residency, sex } } map,
 * as populated by buildDefaultConfig's people parameter patch.
 */
function buildMortalityMcConfigs(params) {
  const people = params.people ?? {};
  return Object.entries(people).flatMap(([personKey, person]) => {
    if (person == null) return [];
    const table      = lookupLifeTable(person.residency ?? 'US');
    const sex        = person.sex ?? 'M';
    const currentAge = person.currentAge ?? 0;
    return [{
      paramKey: `people.${personKey}.lifeExpectancy`,
      label:    `${person.name ?? personKey} lifespan (years)`,
      type:     DISTRIBUTION_TYPES.ACTUARIAL_LIFESPAN,
      table,
      sex,
      currentAge,
      group:    'Mortality',
      enabled:  false,
    }];
  });
}

/**
 * Build the MC variable for a configured state move (design 34 §9).
 *
 * Only emits when `stateMoveYear` is set — an unset move has no distribution
 * center to perturb. The destination state is categorical and intentionally NOT
 * an MC variable (the framework has no categorical distribution; it is an
 * optimization-only axis, mirroring moveYear/startingResidency). stdDev of 1.5
 * years covers realistic uncertainty about timing; the runner rounds to integer.
 */
function buildStateMoveMcConfigs(params) {
  if (params.stateMoveYear == null) return [];
  return [{
    paramKey: 'stateMoveYear', label: 'State Move Year',
    type:     DISTRIBUTION_TYPES.NORMAL,
    mean:     params.stateMoveYear,
    stdDev:   1.5,
    group:    'US Tax',
    enabled:  false,
  }];
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
    ({ params }) => buildRealPropertyMcConfigs(params),
    ({ params }) => buildStateMoveMcConfigs(params),
    ({ params }) => buildMortalityMcConfigs(params),
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
    const resolved = this.constructor.contributors
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

    // Inherit identity (label / options / visibleWhen) from the param schema and
    // drop variables hidden by an unsatisfied visibleWhen (e.g. a strategy knob
    // whose strategy isn't selected). Identity is maintained once, in the schema.
    return resolveSweepVariables(resolved, schemaByKey(), params);
  }

  /**
   * Create an IntlRetirementMcConfig with user states loaded from a flat
   * variableConfigs array (as produced by McConfigPanel).
   *
   * Rewrites legacy flat shock keys to nested paths:
   *   shockSeverity  → shocks[0].severity
   *   shockStartDate → shocks[0].startDate
   *
   * And legacy scenario-default aliases to the toolset keys the compiler reads
   * (these MC variables were silently no-ops under the old keys), so a saved MC
   * config keeps the user's enabled/distribution settings after the fix:
   *   usStockGrowthRate → brokerageGrowthRate
   *   stockDividendRate → brokerageDividendRate
   *   usInflationRate   → inflationRate
   */
  static fromVariableConfigs(variableConfigs) {
    const ALIASES = {
      shockSeverity:     'shocks[0].severity',
      shockStartDate:    'shocks[0].startDate',
      usStockGrowthRate: 'brokerageGrowthRate',
      stockDividendRate: 'brokerageDividendRate',
      usInflationRate:   'inflationRate',
    };
    const config = new IntlRetirementMcConfig();
    for (const v of variableConfigs) {
      const key = ALIASES[v.paramKey] ?? v.paramKey;
      config.applyOverride(key, v);
    }
    return config;
  }
}
