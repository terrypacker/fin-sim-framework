/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import {
  IntlRetirementMcConfig,
  DEFAULT_MC_VARIABLE_CONFIGS,
} from '../../src/finance/monte-carlo/intl-retirement-mc-config.js';
import { DISTRIBUTION_TYPES } from '../../src/simulation-framework/distributions.js';
import { INTL_RETIREMENT_DEFAULTS, resolveBalanceCenters } from '../../src/scenarios/intl-retirement-scenario.js';

const D = INTL_RETIREMENT_DEFAULTS;

// Minimal flat params (no shocks)
const FLAT_PARAMS = {
  rothGrowthRate:        D.rothGrowthRate,
  iraGrowthRate:         D.iraGrowthRate,
  k401GrowthRate:        D.k401GrowthRate,
  brokerageGrowthRate:   D.usStockGrowthRate,
  brokerageDividendRate: D.stockDividendRate,
  auStockGrowthRate:     D.auStockGrowthRate,
  auStockDividendRate:   D.auStockDividendRate,
  spouseRothGrowthRate:  D.spouseRothGrowthRate,
  spouseIraGrowthRate:   D.spouseIraGrowthRate,
  spouseK401GrowthRate:  D.spouseK401GrowthRate,
  spouseSuperGrowthRate: D.spouseSuperGrowthRate,
  usSavingsInterestRate: D.usSavingsInterestRate,
  fixedIncomeInterestRate: D.fixedIncomeInterestRate,
  auSavingsInterestRate: D.auSavingsInterestRate,
  inflationRate:         D.usInflationRate,
  auInflationRate:       D.auInflationRate,
  exchangeRateUsdToAud:  D.exchangeRateUsdToAud,
  intlTransferFeeUsd:    D.intlTransferFeeUsd,
  monthlyExpenses:       D.monthlyExpenses,
  primaryMonthlyWage:    D.primaryMonthlyWage,
  spouseMonthlyWage:     D.spouseMonthlyWage,
  initialUsSavings:      D.initialUsSavings,
  rothBalance:           D.rothBalance,
  iraBalance:            D.iraBalance,
  k401Balance:           D.k401Balance,
  stockBalance:          D.stockBalance,
  fixedIncomeBalance:    D.fixedIncomeBalance,
  auSavingsBalance:      D.auSavingsBalance,
  superBalance:          D.superBalance,
  auStockBalance:        D.auStockBalance,
  spouseRothBalance:     D.spouseRothBalance,
  spouseIraBalance:      D.spouseIraBalance,
  spouseK401Balance:     D.spouseK401Balance,
  spouseSuperBalance:    D.spouseSuperBalance,
};

// ── DEFAULT_MC_VARIABLE_CONFIGS sanity ────────────────────────────────────────

test('DEFAULT_MC_VARIABLE_CONFIGS: no shockSeverity or shockStartDate entries', () => {
  const keys = DEFAULT_MC_VARIABLE_CONFIGS.map(c => c.paramKey);
  assert.ok(!keys.includes('shockSeverity'),  'shockSeverity should be removed');
  assert.ok(!keys.includes('shockStartDate'), 'shockStartDate should be removed');
});

test('DEFAULT_MC_VARIABLE_CONFIGS: every entry has required fields', () => {
  for (const cfg of DEFAULT_MC_VARIABLE_CONFIGS) {
    assert.ok(cfg.paramKey, `missing paramKey: ${JSON.stringify(cfg)}`);
    assert.ok(cfg.label,    `missing label: ${cfg.paramKey}`);
    assert.ok(cfg.type,     `missing type: ${cfg.paramKey}`);
    assert.ok(cfg.group,    `missing group: ${cfg.paramKey}`);
    assert.ok(typeof cfg.enabled === 'boolean', `missing enabled: ${cfg.paramKey}`);
  }
});

// ── buildVariables: no shocks ─────────────────────────────────────────────────

test('buildVariables: 0-shock scenario emits no shock rows', () => {
  const cfg  = new IntlRetirementMcConfig();
  const vars = cfg.buildVariables({ ...FLAT_PARAMS, shocks: [] });
  const shockVars = vars.filter(v => v.group === 'Economic Shocks');
  assert.strictEqual(shockVars.length, 0);
});

test('buildVariables: no shocks key emits no shock rows', () => {
  const cfg  = new IntlRetirementMcConfig();
  const vars = cfg.buildVariables(FLAT_PARAMS);
  const shockVars = vars.filter(v => v.group === 'Economic Shocks');
  assert.strictEqual(shockVars.length, 0);
});

// ── buildVariables: 1 shock ───────────────────────────────────────────────────

test('buildVariables: 1-shock scenario emits 2 shock rows', () => {
  const cfg  = new IntlRetirementMcConfig();
  const vars = cfg.buildVariables({
    ...FLAT_PARAMS,
    shocks: [{ preset: 'MARKET_CRASH_2008_LITE', startDate: '2030-01-01' }],
  });
  const shockVars = vars.filter(v => v.group === 'Economic Shocks');
  assert.strictEqual(shockVars.length, 2);

  const keys = shockVars.map(v => v.paramKey);
  assert.ok(keys.includes('shocks[0].severity'),  'severity variable missing');
  assert.ok(keys.includes('shocks[0].startDate'), 'startDate variable missing');
});

test('buildVariables: shock severity variable uses library default as mean', () => {
  const cfg  = new IntlRetirementMcConfig();
  const vars = cfg.buildVariables({
    ...FLAT_PARAMS,
    shocks: [{ preset: 'MARKET_CRASH_2008_LITE', startDate: '2030-01-01' }],
  });
  const sev = vars.find(v => v.paramKey === 'shocks[0].severity');
  assert.ok(sev, 'severity variable not found');
  assert.ok(typeof sev.mean === 'number', `mean should be numeric, got ${sev.mean}`);
  assert.ok(sev.mean > 0, 'mean should be positive');
});

test('buildVariables: shock variables are disabled by default', () => {
  const cfg  = new IntlRetirementMcConfig();
  const vars = cfg.buildVariables({
    ...FLAT_PARAMS,
    shocks: [{ preset: 'MARKET_CRASH_2008_LITE', startDate: '2030-01-01' }],
  });
  for (const v of vars.filter(v => v.group === 'Economic Shocks')) {
    assert.strictEqual(v.enabled, false, `${v.paramKey} should be disabled by default`);
  }
});

// ── buildVariables: 2 shocks ──────────────────────────────────────────────────

test('buildVariables: 2-shock scenario emits 4 shock rows', () => {
  const cfg  = new IntlRetirementMcConfig();
  const vars = cfg.buildVariables({
    ...FLAT_PARAMS,
    shocks: [
      { preset: 'MARKET_CRASH_2008_LITE', startDate: '2030-01-01' },
      { preset: 'STAGFLATION_1970S_LITE', startDate: '2035-01-01' },
    ],
  });
  const shockVars = vars.filter(v => v.group === 'Economic Shocks');
  assert.strictEqual(shockVars.length, 4);

  const keys = shockVars.map(v => v.paramKey);
  assert.ok(keys.includes('shocks[0].severity'));
  assert.ok(keys.includes('shocks[0].startDate'));
  assert.ok(keys.includes('shocks[1].severity'));
  assert.ok(keys.includes('shocks[1].startDate'));
});

// ── resolveBalanceCenters ──────────────────────────────────────────────────────

test('resolveBalanceCenters: maps legacy balance keys to live account balances', () => {
  const cfg = { accounts: [
    { stateKey: 'usStockAccount', balance: 600_000 },
    { stateKey: 'rothAccount',    balance: 90_000  },
    { stateKey: 'usSavingsAccount', balance: 12_000 },
  ] };
  const centers = resolveBalanceCenters(cfg);
  assert.strictEqual(centers.stockBalance,     600_000, 'stockBalance ← usStockAccount');
  assert.strictEqual(centers.rothBalance,      90_000,  'rothBalance ← rothAccount');
  assert.strictEqual(centers.initialUsSavings, 12_000,  'initialUsSavings ← usSavingsAccount');
  // Accounts absent from the cfg produce no center (rather than a bogus 0).
  assert.ok(!('iraBalance' in centers), 'missing account → no center key');
});

test('resolveBalanceCenters: tolerates a missing/empty cfg', () => {
  assert.deepStrictEqual(resolveBalanceCenters(null), {});
  assert.deepStrictEqual(resolveBalanceCenters({}), {});
  assert.deepStrictEqual(resolveBalanceCenters({ accounts: [] }), {});
});

// ── buildVariables: resolveDefault ────────────────────────────────────────────

test('buildVariables: defaultValue is set to the scenario param value', () => {
  const cfg  = new IntlRetirementMcConfig();
  const vars = cfg.buildVariables({ ...FLAT_PARAMS, shocks: [] });
  const roth = vars.find(v => v.paramKey === 'rothGrowthRate');
  assert.ok(roth, 'rothGrowthRate variable not found');
  assert.strictEqual(roth.defaultValue, D.rothGrowthRate);
});

test('buildVariables: presets mean/value from the live scenario value (config wins over hardcoded default)', () => {
  const cfg  = new IntlRetirementMcConfig();
  // A config whose stock balance and growth rate differ from the template defaults.
  const vars = cfg.buildVariables({
    ...FLAT_PARAMS, shocks: [],
    stockBalance: 600_000,        // holdings-bearing balance, resolved from account records
    brokerageGrowthRate: 0.09,    // per-account/global rate from the config
  });
  const bal = vars.find(v => v.paramKey === 'stockBalance');
  assert.strictEqual(bal.value, 600_000, 'CONSTANT balance lever presets its value from config');
  assert.strictEqual(bal.mean,  600_000, 'balance lever mean also tracks config');

  const gr = vars.find(v => v.paramKey === 'brokerageGrowthRate');
  assert.strictEqual(gr.mean, 0.09, 'rate lever mean presets from the config value, not D default');
});

test('buildVariables: falls back to the hardcoded default when the param is absent from params', () => {
  const cfg  = new IntlRetirementMcConfig();
  const vars = cfg.buildVariables({ shocks: [] });   // sparse params: nothing resolves
  const gr = vars.find(v => v.paramKey === 'rothGrowthRate');
  assert.strictEqual(gr.mean, D.rothGrowthRate, 'unresolvable lever keeps its template default mean');
});

test('buildVariables: explicit shock severity is used as mean', () => {
  const cfg  = new IntlRetirementMcConfig();
  const vars = cfg.buildVariables({
    ...FLAT_PARAMS,
    shocks: [{ preset: 'MARKET_CRASH_2008_LITE', startDate: '2030-01-01', severity: 0.55 }],
  });
  const sev = vars.find(v => v.paramKey === 'shocks[0].severity');
  assert.ok(sev, 'severity variable not found');
  assert.strictEqual(sev.defaultValue, 0.55);
  assert.strictEqual(sev.mean, 0.55);
});

// ── buildVariables: stale shock index dropped ─────────────────────────────────

test('buildVariables: drops shock[1] variable when only 1 shock configured', () => {
  const cfg = new IntlRetirementMcConfig();
  // Pre-load a stale shocks[1] override
  cfg.applyOverride('shocks[1].severity', { enabled: true, mean: 0.3, stdDev: 0.1 });
  const vars = cfg.buildVariables({
    ...FLAT_PARAMS,
    shocks: [{ preset: 'MARKET_CRASH_2008_LITE', startDate: '2030-01-01' }],
  });
  const keys = vars.map(v => v.paramKey);
  assert.ok(!keys.includes('shocks[1].severity'), 'stale shock[1] should be dropped');
  assert.ok(keys.includes('shocks[0].severity'),  'shock[0] should be kept');
});

// ── fromVariableConfigs ───────────────────────────────────────────────────────

test('fromVariableConfigs: legacy shockSeverity rewritten to shocks[0].severity', () => {
  const cfg = IntlRetirementMcConfig.fromVariableConfigs([
    { paramKey: 'shockSeverity', enabled: true, type: 'normal', mean: 0.4, stdDev: 0.1 },
  ]);

  const vars = cfg.buildVariables({
    ...FLAT_PARAMS,
    shocks: [{ preset: 'MARKET_CRASH_2008_LITE', startDate: '2030-01-01' }],
  });
  const sev = vars.find(v => v.paramKey === 'shocks[0].severity');
  assert.ok(sev, 'shocks[0].severity should be present');
  assert.strictEqual(sev.enabled, true, 'override enabled:true should be applied');
});

test('fromVariableConfigs: legacy shockStartDate rewritten to shocks[0].startDate', () => {
  const cfg = IntlRetirementMcConfig.fromVariableConfigs([
    { paramKey: 'shockStartDate', enabled: true, type: 'uniformDate', min: '2028-01-01', max: '2033-01-01' },
  ]);

  const vars = cfg.buildVariables({
    ...FLAT_PARAMS,
    shocks: [{ preset: 'MARKET_CRASH_2008_LITE', startDate: '2030-01-01' }],
  });
  const sd = vars.find(v => v.paramKey === 'shocks[0].startDate');
  assert.ok(sd, 'shocks[0].startDate should be present');
  assert.strictEqual(sd.enabled, true, 'override enabled:true should be applied');
});

test('fromVariableConfigs: non-shock overrides are applied correctly', () => {
  const cfg = IntlRetirementMcConfig.fromVariableConfigs([
    { paramKey: 'rothGrowthRate', enabled: false, type: 'normal', mean: 0.05, stdDev: 0.01 },
  ]);
  const vars = cfg.buildVariables(FLAT_PARAMS);
  const roth = vars.find(v => v.paramKey === 'rothGrowthRate');
  assert.ok(roth, 'rothGrowthRate not found');
  assert.strictEqual(roth.enabled, false);
  assert.strictEqual(roth.mean, 0.05);
});

// ── Alias cleanup: growth/dividend/inflation now key on the toolset params ────

test('DEFAULT_MC_VARIABLE_CONFIGS: equity/dividend/inflation use toolset keys (dead aliases fixed)', () => {
  const keys = DEFAULT_MC_VARIABLE_CONFIGS.map(c => c.paramKey);
  // Renamed to the keys the compiler actually reads (verified to take effect):
  assert.ok(keys.includes('brokerageGrowthRate'),   'brokerageGrowthRate present');
  assert.ok(keys.includes('brokerageDividendRate'), 'brokerageDividendRate present');
  assert.ok(keys.includes('inflationRate'),         'inflationRate present');
  // Old scenario-default aliases gone (per-account growth refactor made
  // brokerageGrowthRate a live, independent lever):
  assert.ok(!keys.includes('usStockGrowthRate'), 'usStockGrowthRate alias removed');
  assert.ok(!keys.includes('stockDividendRate'), 'stockDividendRate alias removed');
  assert.ok(!keys.includes('usInflationRate'),   'usInflationRate alias removed');
});

test('fromVariableConfigs: migrates legacy alias keys from saved configs', () => {
  const saved = [
    { paramKey: 'usStockGrowthRate', enabled: true, mean: 0.06, stdDev: 0.02 },
    { paramKey: 'stockDividendRate', enabled: true, mean: 0.03, stdDev: 0.01 },
    { paramKey: 'usInflationRate',   enabled: true, mean: 0.04, stdDev: 0.01 },
  ];
  const cfg  = IntlRetirementMcConfig.fromVariableConfigs(saved);
  const vars = cfg.buildVariables({ ...FLAT_PARAMS, shocks: [] });

  const growth = vars.find(v => v.paramKey === 'brokerageGrowthRate');
  const div    = vars.find(v => v.paramKey === 'brokerageDividendRate');
  const infl   = vars.find(v => v.paramKey === 'inflationRate');
  assert.ok(growth?.enabled, 'saved usStockGrowthRate setting migrated to brokerageGrowthRate');
  assert.ok(Math.abs(growth.stdDev - 0.02) < 1e-9, 'migrated stdDev preserved');
  assert.ok(div?.enabled,  'saved stockDividendRate setting migrated to brokerageDividendRate');
  assert.ok(infl?.enabled, 'saved usInflationRate setting migrated to inflationRate');
});
