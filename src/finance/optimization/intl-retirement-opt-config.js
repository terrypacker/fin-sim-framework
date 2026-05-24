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
import { INTL_RETIREMENT_DEFAULTS }   from '../../scenarios/intl-retirement-scenario.js';

const D = INTL_RETIREMENT_DEFAULTS;

// Valid US MFJ ordinary-income bracket marginal rates
const US_MFJ_BRACKET_RATES = [0.10, 0.12, 0.22, 0.24, 0.32, 0.35];

/**
 * Default optimization variable configurations for the IntlRetirementScenario.
 *
 * Each entry maps a scenario parameter key to a search-space definition.
 * Only params marked opt:true in INTL_RETIREMENT_PARAM_SCHEMA should appear here.
 *
 * enabled:true  → included in the search grid by default.
 * enabled:false → available in the UI for the user to toggle on.
 *
 * Config shapes by type:
 *   ENUM       — { values: [...] }
 *   INTEGER    — { min, max, step }
 *   CONTINUOUS — { min, max, step }   (discretised for grid search)
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
];
