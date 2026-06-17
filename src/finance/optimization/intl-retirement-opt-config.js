/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { OPT_PARAM_TYPES }            from './optimization-objectives.js';
import { INTL_RETIREMENT_DEFAULTS, DRAWDOWN_STRATEGIES, IntlRetirementScenario } from '../../scenarios/intl-retirement-scenario.js';
import { SHOCK_LIBRARY }              from '../economic-shocks/shock-library.js';
import { indexParamSchema, resolveSweepVariables } from '../param-schema-utils.js';

// Lazily index the full param schema by key so Opt variables can inherit identity
// (label / options / visibleWhen) from it rather than duplicating it here.
let _schemaByKey = null;
function schemaByKey() {
  if (!_schemaByKey) _schemaByKey = indexParamSchema(IntlRetirementScenario.buildFullParamSchema());
  return _schemaByKey;
}

const D = INTL_RETIREMENT_DEFAULTS;

// Valid US MFJ ordinary-income bracket marginal rates
const US_MFJ_BRACKET_RATES = [0.10, 0.12, 0.22, 0.24, 0.32, 0.35];

/**
 * Static optimization variable configurations for the IntlRetirementScenario.
 *
 * Economic shock variables are NOT listed here — they are generated dynamically
 * by buildOptVariables() based on the scenario's configured shocks array.
 *
 * enabled:true  → included in the search grid by default.
 * enabled:false → available in the UI for the user to toggle on.
 *
 * Config shapes by type:
 *   ENUM       — { values: [...] }
 *   INTEGER    — { min, max, step }
 *   CONTINUOUS — { min, max, step }   (discretised for grid search)
 *
 * Identity is the param schema's job: `visibleWhen` is always inherited from the
 * schema by paramKey (buildOptVariables → resolveSweepVariables), and `label` is
 * inherited when omitted here. A new entry needs only `paramKey` + sweep
 * metadata (type/range/group/enabled); add `label` only to override the schema's
 * or for orphan keys that have no schema entry.
 */
export const DEFAULT_OPTIMIZATION_CONFIGS = [

  // ── Roth Conversion (primary optimization levers) ─────────────────────────
  {
    paramKey: 'rothConversionMaxBracket',
    label:    'Roth Conversion Max Bracket Rate',
    type:     OPT_PARAM_TYPES.ENUM,
    values:   US_MFJ_BRACKET_RATES,
    group:    'Roth Conversion',
    enabled:  true,
  },
  {
    paramKey: 'rothConversionStartYear',
    label:    'Roth Conversion Start Year',
    type:     OPT_PARAM_TYPES.INTEGER,
    min: 2026, max: 2036, step: 1,
    group:    'Roth Conversion',
    enabled:  false,
  },
  {
    paramKey: 'rothConversionEndYear',
    label:    'Roth Conversion End Year',
    type:     OPT_PARAM_TYPES.INTEGER,
    min: 2032, max: 2046, step: 1,
    group:    'Roth Conversion',
    enabled:  false,
  },

  // ── Monthly expenses (sensitivity / what-if) ──────────────────────────────
  {
    paramKey: 'monthlyExpenses',
    label:    'Monthly Expenses',
    type:     OPT_PARAM_TYPES.INTEGER,
    min: 3_000, max: 8_000, step: 500,
    group:    'Transfer & Expenses',
    enabled:  false,
  },

  // ── Cash buffer thresholds ────────────────────────────────────────────────
  {
    paramKey: 'usSavingsMinBalance',
    label:    'US Savings Min Balance (USD)',
    type:     OPT_PARAM_TYPES.INTEGER,
    min: 10_000, max: 100_000, step: 10_000,
    group:    'Min Balances',
    enabled:  false,
  },
  {
    paramKey: 'auSavingsMinBalance',
    label:    'AU Savings Min Balance (AUD)',
    type:     OPT_PARAM_TYPES.INTEGER,
    min: 10_000, max: 100_000, step: 10_000,
    group:    'Min Balances',
    enabled:  false,
  },

  // ── Migration timing ──────────────────────────────────────────────────────
  {
    paramKey: 'moveYear',
    label:    'US→AU Move Year',
    type:     OPT_PARAM_TYPES.INTEGER,
    min: 2026, max: 2035, step: 1,
    group:    'People',
    enabled:  false,
  },

  // ── Real Property sale timing ─────────────────────────────────────────────
  {
    paramKey: 'usHouseSaleYear',
    label:    'US House Sale Year',
    type:     OPT_PARAM_TYPES.INTEGER,
    min: 2027, max: 2045, step: 1,
    group:    'Real Properties',
    enabled:  false,
  },
  {
    paramKey: 'auHouseSaleYear',
    label:    'AU House Sale Year',
    type:     OPT_PARAM_TYPES.INTEGER,
    min: 2030, max: 2045, step: 1,
    group:    'Real Properties',
    enabled:  false,
  },

  // ── Drawdown order (decision lever) ───────────────────────────────────────
  {
    paramKey: 'drawdownStrategy',
    label:    'Drawdown Strategy',
    type:     OPT_PARAM_TYPES.ENUM,
    values:   Object.keys(DRAWDOWN_STRATEGIES),
    group:    'Spending',
    enabled:  false,
  },

  // ── Spending Strategies ────────────────────────────────────────────────────
  // Each ENUM value is an array — matches the EnumMulti param type.
  {
    paramKey: 'spendingStrategy',
    label:    'Spending Strategy',
    type:     OPT_PARAM_TYPES.ENUM,
    values:   [['FIXED'], ['REGIME_AWARE'], ['GUARDRAIL'], ['FIXED', 'REGIME_AWARE'], ['GUARDRAIL', 'REGIME_AWARE']],
    group:    'Spending Strategies',
    enabled:  false,
  },
  {
    paramKey: 'regimeAwareCutPct',
    label:    'Regime-Aware Spending Cut',
    type:     OPT_PARAM_TYPES.CONTINUOUS,
    min: 0.05, max: 0.40, step: 0.05,
    group:    'Spending Strategies',
    enabled:  false,
  },
  {
    paramKey: 'guardrailCutThreshold',
    label:    'Guardrail Cut Threshold',
    type:     OPT_PARAM_TYPES.CONTINUOUS,
    min: 0.10, max: 0.40, step: 0.05,
    group:    'Spending Strategies',
    enabled:  false,
  },
  {
    paramKey: 'guardrailRaiseThreshold',
    label:    'Guardrail Raise Threshold',
    type:     OPT_PARAM_TYPES.CONTINUOUS,
    min: 0.10, max: 0.40, step: 0.05,
    group:    'Spending Strategies',
    enabled:  false,
  },
  {
    paramKey: 'guardrailCutPct',
    label:    'Guardrail Cut %',
    type:     OPT_PARAM_TYPES.CONTINUOUS,
    min: 0.05, max: 0.25, step: 0.05,
    group:    'Spending Strategies',
    enabled:  false,
  },
  {
    paramKey: 'guardrailRaisePct',
    label:    'Guardrail Raise %',
    type:     OPT_PARAM_TYPES.CONTINUOUS,
    min: 0.05, max: 0.25, step: 0.05,
    group:    'Spending Strategies',
    enabled:  false,
  },

  // ── Behavioral Strategies ─────────────────────────────────────────────────
  {
    paramKey: 'behavioralStrategies',
    label:    'Behavioral Strategies',
    type:     OPT_PARAM_TYPES.ENUM,
    values:   [
      [],
      ['PANIC_SELL'],
      ['TAX_LOSS_HARVEST'],
      ['CONTRIBUTION_SUSPENSION'],
      ['OPPORTUNISTIC_REBALANCE'],
      ['DOWNTURN_ROTH_CONVERSION'],
      ['TAX_GAIN_HARVEST'],
      ['PANIC_SELL', 'TAX_LOSS_HARVEST'],
      ['PANIC_SELL', 'TAX_LOSS_HARVEST', 'CONTRIBUTION_SUSPENSION'],
    ],
    group:    'Behavioral Strategies',
    enabled:  false,
  },
  {
    paramKey: 'panicFraction',
    label:    'Panic Sell Fraction',
    type:     OPT_PARAM_TYPES.CONTINUOUS,
    min: 0.10, max: 0.60, step: 0.05,
    group:    'Behavioral Strategies',
    enabled:  false,
  },
  {
    paramKey: 'taxLossHarvestCap',
    label:    'TLH Cap ($/yr)',
    type:     OPT_PARAM_TYPES.INTEGER,
    min: 1_000, max: 10_000, step: 1_000,
    group:    'Behavioral Strategies',
    enabled:  false,
  },
  {
    paramKey: 'rebalanceDriftBand',
    label:    'Rebalance Drift Band',
    type:     OPT_PARAM_TYPES.CONTINUOUS,
    min: 0.02, max: 0.15, step: 0.01,
    group:    'Behavioral Strategies',
    enabled:  false,
  },
  {
    paramKey: 'downturnConversionAmount',
    label:    'Downturn Roth Conversion ($)',
    type:     OPT_PARAM_TYPES.INTEGER,
    min: 5_000, max: 50_000, step: 5_000,
    group:    'Behavioral Strategies',
    enabled:  false,
  },
  {
    paramKey: 'taxGainHarvestBracketCeiling',
    label:    'Tax-Gain Harvest Ceiling ($)',
    type:     OPT_PARAM_TYPES.INTEGER,
    min: 0, max: 100_000, step: 10_000,
    group:    'Behavioral Strategies',
    enabled:  false,
  },
];

/**
 * Build one optimization severity variable per configured shock.
 * The search range is centred on the shock's configured severity.
 */
function buildShockOptConfigs(params) {
  const shocks = params.shocks ?? [];
  return shocks.flatMap((entry, i) => {
    if (!entry) return [];
    const label         = entry.preset ?? entry.shockId ?? `Shock ${i + 1}`;
    const libraryShock  = entry.preset ? (SHOCK_LIBRARY[entry.preset] ?? {}) : {};
    const severityBase  = entry.severity ?? libraryShock.severity ?? 0.4;
    return [
      {
        paramKey: `shocks[${i}].severity`,
        label:    `${label}: severity`,
        type:     OPT_PARAM_TYPES.CONTINUOUS,
        min:      Math.max(0.05, parseFloat((severityBase - 0.30).toFixed(2))),
        max:      Math.min(0.95, parseFloat((severityBase + 0.30).toFixed(2))),
        step:     0.05,
        group:    'Economic Shocks',
        enabled:  false,
      },
    ];
  });
}

/**
 * Build the full optimization variable list for a given param snapshot.
 *
 * Returns DEFAULT_OPTIMIZATION_CONFIGS plus one severity entry per configured
 * shock.  Shock entries only appear when the scenario actually has shocks,
 * preventing stale rows for scenarios without ECONOMIC_REGIMES.
 */
export function buildOptVariables(params) {
  const list = [
    ...DEFAULT_OPTIMIZATION_CONFIGS,
    ...buildShockOptConfigs(params),
  ];
  // Inherit identity (label / options / visibleWhen) from the param schema and
  // drop variables hidden by an unsatisfied visibleWhen (e.g. a strategy knob
  // whose strategy isn't selected). Identity is maintained once, in the schema.
  return resolveSweepVariables(list, schemaByKey(), params);
}
