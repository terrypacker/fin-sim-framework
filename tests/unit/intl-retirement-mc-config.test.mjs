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
import { INTL_RETIREMENT_DEFAULTS } from '../../src/scenarios/intl-retirement-scenario.js';
import { resolveRecordCenters }     from '../../src/scenarios/scenario-param-apply.js';

const D = INTL_RETIREMENT_DEFAULTS;

// Minimal flat params (no shocks)
const FLAT_PARAMS = {
  usEquityGrowthRate:    0.07,
  auEquityGrowthRate:    0.07,
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

// ── resolveRecordCenters ──────────────────────────────────────────────────────

/**
 * Accounts under stateKeys the reference plan does not use — the case the 13 legacy
 * balance rows got wrong. A holdings-bearing account, a holdings-free one, and an empty one.
 */
const OWN_ACCOUNTS_CFG = { accounts: [
  { stateKey: 'myBrokerage', name: 'My Brokerage', type: 'brokerage', country: 'US',
    balance: 600_000, holdings: [{ marketValue: 600_000 }] },
  { stateKey: 'myCash', name: 'My Cash', type: 'savings', country: 'US', balance: 12_000 },
  { stateKey: 'emptyIra', name: 'Empty IRA', type: 'ira', country: 'US',
    balance: 0, holdings: [{ marketValue: 0 }] },
] };

test('resolveRecordCenters: every account balance, under the generated key its lever uses', () => {
  const centers = resolveRecordCenters(OWN_ACCOUNTS_CFG);
  const balances = Object.fromEntries(Object.entries(centers)
    .filter(([k]) => /\.balance(Target)?$/.test(k)));
  assert.deepStrictEqual(balances, {
    'acct.myBrokerage.balanceTarget': 600_000,   // holdings-bearing → the hidden lever
    'acct.myCash.balance':            12_000,    // holdings-free → the plain param
    'acct.emptyIra.balanceTarget':    0,
  });
  // No legacy flat keys: they named the reference plan's accounts, not this plan's.
  assert.ok(!('stockBalance' in centers) && !('rothBalance' in centers));
});

test('resolveRecordCenters: a person\'s wage and a blank sale year, from the records', () => {
  const centers = resolveRecordCenters({
    persons: [{ id: 'alex', name: 'Alex', monthlyWage: 9_000 }],
    realProperties: [{ stateKey: 'cabin', name: 'Cabin', country: 'US', plannedSaleYear: null }],
  });
  assert.strictEqual(centers['person.alex.monthlyWage'], 9_000);
  assert.ok('prop.cabin.plannedSaleYear' in centers, 'a blank sale year is carried …');
  assert.strictEqual(centers['prop.cabin.plannedSaleYear'], null, '… as an explicit null');
});

test('resolveRecordCenters: tolerates a missing/empty cfg', () => {
  assert.deepStrictEqual(resolveRecordCenters(null), {});
  assert.deepStrictEqual(resolveRecordCenters({}), {});
  assert.deepStrictEqual(resolveRecordCenters({ accounts: [] }), {});
});

// ── buildVariables: resolveDefault ────────────────────────────────────────────

test('buildVariables: defaultValue is set to the scenario param value', () => {
  const cfg  = new IntlRetirementMcConfig();
  const vars = cfg.buildVariables({ ...FLAT_PARAMS, shocks: [] });
  const us = vars.find(v => v.paramKey === 'usEquityGrowthRate');
  assert.ok(us, 'usEquityGrowthRate variable not found');
  assert.strictEqual(us.defaultValue, 0.07);
});

test('buildVariables: presets mean/value from the live scenario value (config wins over hardcoded default)', () => {
  const cfg  = new IntlRetirementMcConfig();
  const vars = cfg.buildVariables({ ...FLAT_PARAMS, shocks: [], usEquityGrowthRate: 0.09 });
  const gr = vars.find(v => v.paramKey === 'usEquityGrowthRate');
  assert.strictEqual(gr.mean, 0.09, 'rate lever mean presets from the config value, not D default');
});

// ── Account balance rows: one per account on the plan, from the harvest ──────

test('buildVariables: every account with a balance gets ONE balance row, keyed by its own generated param', () => {
  const vars = new IntlRetirementMcConfig().buildVariables(
    { ...FLAT_PARAMS, shocks: [], ...resolveRecordCenters(OWN_ACCOUNTS_CFG) },
    { cfg: OWN_ACCOUNTS_CFG });
  const bal = vars.filter(v => /^acct\.[^.]+\.(balance|balanceTarget)$/.test(v.paramKey));

  assert.deepStrictEqual(bal.map(v => v.paramKey).sort(),
    ['acct.myBrokerage.balanceTarget', 'acct.myCash.balance'],
    'the hidden balanceTarget is harvested, the plain balance too — and nothing for $0');
  const brk = bal.find(v => v.paramKey === 'acct.myBrokerage.balanceTarget');
  assert.strictEqual(brk.mean, 600_000, 'centred on the account record');
  assert.strictEqual(brk.enabled, false);
  assert.strictEqual(brk.centerSource, 'scenario');
  assert.strictEqual(brk.sweepKind, 'amount',
    'an amount, not a rate — a $0 center would otherwise be read as a 0% rate');
});

test('buildVariables: the 13 legacy balance rows are retired', () => {
  const keys = new IntlRetirementMcConfig()
    .buildVariables({ ...FLAT_PARAMS, shocks: [] }, { cfg: OWN_ACCOUNTS_CFG })
    .map(v => v.paramKey);
  for (const k of ['initialUsSavings', 'rothBalance', 'iraBalance', 'k401Balance', 'stockBalance',
    'fixedIncomeBalance', 'auSavingsBalance', 'superBalance', 'auStockBalance',
    'spouseRothBalance', 'spouseIraBalance', 'spouseK401Balance', 'spouseSuperBalance']) {
    assert.ok(!keys.includes(k), `${k} retired`);
  }
});

test('buildVariables: falls back to the hardcoded default when the param is absent from params', () => {
  const cfg  = new IntlRetirementMcConfig();
  const vars = cfg.buildVariables({ shocks: [] });   // sparse params: nothing resolves
  const gr = vars.find(v => v.paramKey === 'usEquityGrowthRate');
  assert.strictEqual(gr.mean, 0.07, 'unresolvable lever keeps its template default mean');
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
    { paramKey: 'usEquityGrowthRate', enabled: false, type: 'normal', mean: 0.05, stdDev: 0.01 },
  ]);
  const vars = cfg.buildVariables(FLAT_PARAMS);
  const roth = vars.find(v => v.paramKey === 'usEquityGrowthRate');
  assert.ok(roth, 'usEquityGrowthRate not found');
  assert.strictEqual(roth.enabled, false);
  assert.strictEqual(roth.mean, 0.05);
});

// ── Design 99 P2: equity axes are the markets'; the per-account ones are retired ─

test('DEFAULT_MC_VARIABLE_CONFIGS: equity axes are the market returns; retired keys are gone', () => {
  const keys = DEFAULT_MC_VARIABLE_CONFIGS.map(c => c.paramKey);
  for (const k of ['usEquityGrowthRate', 'auEquityGrowthRate', 'usEquityDividendYield', 'inflationRate']) {
    assert.ok(keys.includes(k), `${k} present`);
  }
  for (const k of ['rothGrowthRate', 'iraGrowthRate', 'k401GrowthRate', 'brokerageGrowthRate',
    'brokerageDividendRate', 'auStockGrowthRate', 'auStockDividendRate', 'superGrowthRate',
    'usStockGrowthRate', 'stockDividendRate', 'usInflationRate']) {
    assert.ok(!keys.includes(k), `${k} retired`);
  }
});

test('fromVariableConfigs: a saved setting for a retired equity axis simply disappears; usInflationRate still migrates', () => {
  const saved = [
    { paramKey: 'usStockGrowthRate', enabled: true, mean: 0.06, stdDev: 0.02 },
    { paramKey: 'brokerageGrowthRate', enabled: true, mean: 0.06, stdDev: 0.02 },
    { paramKey: 'usInflationRate',   enabled: true, mean: 0.04, stdDev: 0.01 },
  ];
  const cfg  = IntlRetirementMcConfig.fromVariableConfigs(saved);
  const vars = cfg.buildVariables({ ...FLAT_PARAMS, shocks: [] });

  const keys = vars.map(v => v.paramKey);
  assert.ok(!keys.includes('usStockGrowthRate') && !keys.includes('brokerageGrowthRate'),
    'no contributor emits a retired axis, so its stored setting resolves to nothing');
  assert.ok(vars.find(v => v.paramKey === 'inflationRate')?.enabled,
    'saved usInflationRate setting migrated to inflationRate');
});

test('fromVariableConfigs: a saved legacy balance setting moves to the account it aliased', () => {
  const cfg = { accounts: [{ stateKey: 'rothAccount', name: 'Roth IRA', type: 'roth', country: 'US',
    balance: 90_000, holdings: [{ marketValue: 90_000 }] }] };
  const mc   = IntlRetirementMcConfig.fromVariableConfigs([
    { paramKey: 'rothBalance', enabled: true, type: 'normal', mean: 95_000, stdDev: 5_000 },
  ]);
  const roth = mc.buildVariables({ ...FLAT_PARAMS, shocks: [], ...resolveRecordCenters(cfg) }, { cfg })
    .find(v => v.paramKey === 'acct.rothAccount.balanceTarget');
  assert.ok(roth?.enabled, 'the saved setting follows rothBalance → acct.rothAccount.balanceTarget');
  assert.strictEqual(roth.mean, 95_000);
});
