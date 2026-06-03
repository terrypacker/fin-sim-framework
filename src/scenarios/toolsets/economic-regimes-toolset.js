/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { OneOffEvent }                    from '../../simulation-framework/events/one-off-event.js';
import { DateUtils }                      from '../../simulation-framework/date-utils.js';
import { ValueType }                      from '../../simulation-framework/type-registry.js';
import { RATE_KEYS, ROLE_TO_RATE_KEY }    from '../../finance/economic-regimes/rate-keys.js';
import { RegimeApplyReducer }             from '../../finance/economic-regimes/regime-apply-reducer.js';
import { AddRegimeReducer }               from '../../finance/economic-regimes/add-regime-reducer.js';
import { RemoveRegimeReducer }            from '../../finance/economic-regimes/remove-regime-reducer.js';
import { RevalueAssetReducer }            from '../../finance/economic-regimes/revalue-asset-reducer.js';
import { EconomicShockHandler }           from '../../finance/economic-regimes/economic-shock-handler.js';
import { EconomicRecoveryTickHandler }    from '../../finance/economic-regimes/economic-recovery-tick-handler.js';
import { SHOCK_LIBRARY, SHOCK_PRESET_OPTIONS } from '../../finance/economic-shocks/shock-library.js';

/**
 * Build a rateKey → [stateKey, ...] map from the scenario's registered accounts.
 */
function buildRateKeyToStateKeys(accounts) {
  const map = {};
  for (const acct of accounts) {
    const rateKey = ROLE_TO_RATE_KEY[acct.role];
    if (!rateKey || !acct.stateKey) continue;
    if (!map[rateKey]) map[rateKey] = [];
    map[rateKey].push(acct.stateKey);
  }
  return map;
}

/**
 * Collect base growth rates from scenario parameters.
 */
function collectBaseGrowthRates(p) {
  return {
    [RATE_KEYS.EQUITY_US]: p.rothGrowthRate ?? p.iraGrowthRate ?? 0.07,
    [RATE_KEYS.EQUITY_AU]: p.auStockGrowthRate ?? p.spouseSuperGrowthRate ?? 0.07,
  };
}

/**
 * Collect base interest rates from scenario parameters.
 */
function collectBaseInterestRates(p) {
  const rates = {};
  if (p.usSavingsInterestRate    != null) rates[RATE_KEYS.SAVINGS_US]      = p.usSavingsInterestRate;
  if (p.fixedIncomeInterestRate  != null) rates[RATE_KEYS.FIXED_INCOME_US] = p.fixedIncomeInterestRate;
  if (p.auSavingsInterestRate    != null) rates[RATE_KEYS.SAVINGS_AU]      = p.auSavingsInterestRate;
  if (p.auFixedIncomeInterestRate != null) rates[RATE_KEYS.FIXED_INCOME_AU] = p.auFixedIncomeInterestRate;
  return rates;
}

/**
 * Resolve a single shock array entry into a full FinancialShock object.
 *
 * Two forms are accepted:
 *   { preset: 'MARKET_CRASH_2008_LITE', startDate: '2030-01-01' }
 *     → looks up the template from SHOCK_LIBRARY and merges in startDate
 *   { shockId: '...', startDate: ..., levelEffects: ..., ... }
 *     → used as-is (custom / legacy full-object form)
 *
 * Returns null if the entry is empty or cannot be resolved.
 */
function resolveShockEntry(item) {
  if (!item) return null;

  // Library-reference form: { preset, startDate }
  if (item.preset && item.preset !== 'none') {
    const template = SHOCK_LIBRARY[item.preset];
    if (!template) return null;
    const startDate = item.startDate instanceof Date
      ? item.startDate
      : (item.startDate ? new Date(item.startDate) : null);
    if (!startDate || Number.isNaN(startDate.getTime())) return null;
    return { ...template, startDate };
  }

  // Full custom-object form: must have shockId and startDate
  if (item.shockId) return item;

  return null;
}

/**
 * Apply flat MC override parameters to a resolved FinancialShock.
 *
 * Flat keys `shockSeverity` and `shockStartDate` override the first
 * configured shock (shocks[0]).  The severity override rescales the
 * equityRevaluation multiplier; the startDate override shifts the entire
 * shock/recovery schedule.
 */
function applyShockOverrides(shock, p) {
  let s = shock;

  if (p.shockSeverity != null) {
    const severity = p.shockSeverity;
    const lv = s.levelEffects?.equityRevaluation;
    s = {
      ...s,
      severity,
      ...(lv && {
        levelEffects: {
          ...s.levelEffects,
          equityRevaluation: { ...lv, multiplier: -Math.abs(severity) },
        },
      }),
    };
  }

  if (p.shockStartDate != null) {
    const startDate = p.shockStartDate instanceof Date
      ? p.shockStartDate
      : new Date(p.shockStartDate);
    if (!Number.isNaN(startDate.getTime())) {
      s = { ...s, startDate };
    }
  }

  return s;
}

/**
 * Schedule ECONOMIC_SHOCK + ECONOMIC_RECOVERY_TICK events for one resolved shock.
 */
function scheduleShock(shock, events) {
  const startDate = shock.startDate instanceof Date ? shock.startDate : new Date(shock.startDate);
  const durationMonths = shock.recovery?.durationMonths ?? 12;

  events.push(new OneOffEvent({
    name:    shock.name ?? `Economic Shock (${shock.shockId})`,
    type:    'ECONOMIC_SHOCK',
    date:    startDate,
    data:    { shock },
    enabled: true,
    color:   '#B71C1C',
  }));

  for (let m = 1; m <= durationMonths; m++) {
    events.push(new OneOffEvent({
      name:    `Recovery Tick ${m}/${durationMonths} (${shock.shockId})`,
      type:    'ECONOMIC_RECOVERY_TICK',
      date:    DateUtils.addMonths(startDate, m),
      data:    { shockId: shock.shockId },
      enabled: true,
      color:   '#E57373',
    }));
  }
}

/**
 * ECONOMIC_REGIMES toolset — adds a shock-and-regime layer on top of the
 * existing pipeline.
 *
 * The `shocks` parameter accepts an array of shock entries. Each entry can be:
 *   - A library reference: `{ preset: 'MARKET_CRASH_2008_LITE', startDate: '2030-01-01' }`
 *   - A full FinancialShock object with `shockId`, `startDate`, etc.
 *
 * The param schema includes `options: SHOCK_PRESET_OPTIONS` so the UI can
 * render a ShockList editor with a preset dropdown per row.
 *
 * Capabilities: economic-regimes
 * Dependencies: (none; regime layer sits beneath everything)
 */
export const ECONOMIC_REGIMES = {
  id: 'ECONOMIC_REGIMES',
  capabilities: ['economic-regimes'],
  dependencies: [],

  types: {
    handlers: [EconomicShockHandler, EconomicRecoveryTickHandler],
    reducers: [RegimeApplyReducer, AddRegimeReducer, RemoveRegimeReducer, RevalueAssetReducer],
    actions: [
      { type: 'ADD_REGIME_APPLY',    fields: { regime: ValueType.any() } },
      { type: 'REMOVE_REGIME_APPLY', fields: { regimeId: ValueType.text() } },
      {
        type: 'REVALUE_ASSET_APPLY',
        fields: {
          rateKey:         ValueType.text(),
          multiplier:      ValueType.number(),
          targetStateKeys: ValueType.any(),
        },
      },
      { type: 'RECOMPUTE_REGIMES',   fields: {} },
    ],
  },

  paramSchema(_context) {
    return [
      {
        key:          'shocks',
        label:        'Economic Shocks',
        type:         'ShockList',
        group:        'Economic Shocks',
        mc:           false,
        opt:          false,
        options:      SHOCK_PRESET_OPTIONS,
        defaultValue: [],
        description:  'List of financial shocks to apply. Each entry can reference a library preset or define a custom shock.',
      },
      {
        key:          'shockSeverity',
        label:        'Shock Severity (shocks[0])',
        type:         'Number',
        group:        'Economic Shocks',
        mc:           true,
        opt:          true,
        hidden:       true,
        defaultValue: null,
        description:  'Overrides the severity of the first configured shock (0–1). Scales equityRevaluation multiplier. Null = use shock default.',
      },
      {
        key:          'shockStartDate',
        label:        'Shock Start Date (shocks[0])',
        type:         'Date',
        group:        'Economic Shocks',
        mc:           true,
        opt:          true,
        hidden:       true,
        defaultValue: null,
        description:  'Overrides the start date of the first configured shock. Shifts the entire shock and recovery schedule. Null = use shock default.',
      },
    ];
  },

  state(context) {
    const p = context.parameters;
    const baseGrowthRates    = collectBaseGrowthRates(p);
    const baseInterestRates  = collectBaseInterestRates(p);
    const baseInflationRates = {
      US: p.usInflationRate ?? p.inflationRate ?? 0.03,
      AU: p.auInflationRate ?? p.inflationRate ?? 0.03,
    };
    return {
      activeRegimes:              [],
      baseGrowthRates,
      baseInterestRates,
      baseInflationRates,
      baseAppreciationRates:      {},
      effectiveGrowthRates:       { ...baseGrowthRates },
      effectiveInterestRates:     { ...baseInterestRates },
      effectiveInflationRates:    { ...baseInflationRates },
      effectiveAppreciationRates: {},
    };
  },

  schedules(context) {
    const events = [];
    const shocks = context.parameters.shocks ?? [];
    for (let i = 0; i < shocks.length; i++) {
      let shock = resolveShockEntry(shocks[i]);
      if (!shock) continue;
      if (i === 0) shock = applyShockOverrides(shock, context.parameters);
      scheduleShock(shock, events);
    }
    return events;
  },

  handlers(context) {
    const rateKeyToStateKeys = buildRateKeyToStateKeys(context.accounts);
    return [
      new EconomicShockHandler({ rateKeyToStateKeys }),
      new EconomicRecoveryTickHandler(),
    ];
  },

  reducers(_context) {
    return [
      new RegimeApplyReducer(),
      new AddRegimeReducer(),
      new RemoveRegimeReducer(),
      new RevalueAssetReducer(),
    ];
  },
};
