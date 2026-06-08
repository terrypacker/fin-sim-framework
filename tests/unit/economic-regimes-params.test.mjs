/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * economic-regimes-params.test.mjs
 *
 * Tests for the ECONOMIC_REGIMES toolset's ShockList parameter and library integration:
 *
 *   PARAM-1:  shocks param is type ShockList with options array
 *   PARAM-2:  options contains a 'none' sentinel as first entry
 *   PARAM-3:  every SHOCK_LIBRARY key appears in options
 *   PARAM-4:  SHOCK_LIBRARY entries have required fields
 *   PARAM-5:  preset reference entry resolves to full shock via schedules()
 *   PARAM-6:  'none' preset produces no events
 *   PARAM-7:  missing startDate produces no events
 *   PARAM-8:  multiple shocks in array all schedule events
 *   PARAM-9:  custom full-object shocks (no preset) still schedule events
 *   PARAM-10: options field survives ScenarioLoader round-trip
 */

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { ECONOMIC_REGIMES }             from '../../src/scenarios/toolsets/economic-regimes-toolset.js';
import { SHOCK_LIBRARY, SHOCK_PRESET_OPTIONS } from '../../src/finance/economic-shocks/shock-library.js';
import { ServiceRegistry }              from '../../src/services/service-registry.js';
import { ScenarioLoader }               from '../../src/scenarios/scenario-loader.js';
import { BaseScenario }                 from '../../src/index.js';

beforeEach(() => ServiceRegistry.resetAll());

// ─── Unit: paramSchema ────────────────────────────────────────────────────────

test('PARAM-1: shocks param is type ShockList with options array', () => {
  const schema = ECONOMIC_REGIMES.paramSchema({});
  const shocksEntry = schema.find(s => s.key === 'shocks');
  assert.ok(shocksEntry, 'shocks param must exist in schema');
  assert.strictEqual(shocksEntry.type, 'ShockList');
  assert.ok(Array.isArray(shocksEntry.options), 'options must be an array');
  assert.ok(shocksEntry.options.length > 0, 'options must be non-empty');
});

test('PARAM-2: first option is the none sentinel', () => {
  const schema = ECONOMIC_REGIMES.paramSchema({});
  const { options } = schema.find(s => s.key === 'shocks');
  assert.strictEqual(options[0].value, 'none');
});

test('PARAM-3: every SHOCK_LIBRARY key appears in options', () => {
  const schema = ECONOMIC_REGIMES.paramSchema({});
  const { options } = schema.find(s => s.key === 'shocks');
  const optionValues = new Set(options.map(o => o.value));
  for (const key of Object.keys(SHOCK_LIBRARY)) {
    assert.ok(optionValues.has(key), `Library key '${key}' must appear in options`);
  }
});

// ─── Unit: SHOCK_LIBRARY structure ───────────────────────────────────────────

test('PARAM-4: every SHOCK_LIBRARY entry has required fields', () => {
  for (const [key, shock] of Object.entries(SHOCK_LIBRARY)) {
    assert.ok(shock.shockId, `${key}: shockId is required`);
    assert.ok(shock.name,    `${key}: name is required`);
    assert.ok(shock.recovery?.profile,        `${key}: recovery.profile is required`);
    assert.ok(shock.recovery?.durationMonths, `${key}: recovery.durationMonths is required`);
  }
});

test('PARAM-4b: SHOCK_PRESET_OPTIONS matches SHOCK_LIBRARY keys (plus none)', () => {
  const libraryKeys = new Set(Object.keys(SHOCK_LIBRARY));
  const optionKeys  = SHOCK_PRESET_OPTIONS.map(o => o.value).filter(v => v !== 'none');
  for (const k of optionKeys) {
    assert.ok(libraryKeys.has(k), `Option value '${k}' must exist in SHOCK_LIBRARY`);
  }
  assert.strictEqual(optionKeys.length, libraryKeys.size, 'Every library key must have an option');
});

// ─── Unit: resolveShockEntry (via schedules()) ────────────────────────────────

function makeContext(shocks) {
  return {
    parameters: { shocks },
    accounts:   [],
  };
}

test('PARAM-5: preset reference schedules ECONOMIC_SHOCK and RECOVERY_TICK events', () => {
  const ctx = makeContext([{ preset: 'MARKET_CRASH_2008_LITE', startDate: '2030-01-01' }]);
  const events = ECONOMIC_REGIMES.schedules(ctx);

  const shockEvents = events.filter(e => e.type === 'ECONOMIC_SHOCK');
  const tickEvents  = events.filter(e => e.type === 'ECONOMIC_RECOVERY_TICK');

  assert.strictEqual(shockEvents.length, 1, 'One ECONOMIC_SHOCK event');
  // MARKET_CRASH_2008_LITE has 18-month duration → 18 ticks
  assert.strictEqual(tickEvents.length, SHOCK_LIBRARY.MARKET_CRASH_2008_LITE.recovery.durationMonths);

  // Shock data carries the resolved template
  const shock = shockEvents[0].data.shock;
  assert.strictEqual(shock.shockId, 'MARKET_CRASH_2008_LITE');
  assert.ok(shock.startDate instanceof Date, 'startDate must be a Date');
});

test('PARAM-6: preset=none produces no events', () => {
  const ctx = makeContext([{ preset: 'none', startDate: '2030-01-01' }]);
  const events = ECONOMIC_REGIMES.schedules(ctx);
  assert.strictEqual(events.length, 0);
});

test('PARAM-7: missing startDate produces no events', () => {
  const ctx = makeContext([{ preset: 'MARKET_CRASH_2008_LITE', startDate: '' }]);
  const events = ECONOMIC_REGIMES.schedules(ctx);
  assert.strictEqual(events.length, 0);
});

test('PARAM-7b: absent startDate (no key) produces no events', () => {
  const ctx = makeContext([{ preset: 'MARKET_CRASH_2008_LITE' }]);
  const events = ECONOMIC_REGIMES.schedules(ctx);
  assert.strictEqual(events.length, 0);
});

test('PARAM-8: two preset shocks both schedule events independently', () => {
  const ctx = makeContext([
    { preset: 'MARKET_CRASH_2008_LITE', startDate: '2030-01-01' },
    { preset: 'COVID_2020_LITE',        startDate: '2032-06-01' },
  ]);
  const events = ECONOMIC_REGIMES.schedules(ctx);
  const shockEvents = events.filter(e => e.type === 'ECONOMIC_SHOCK');
  assert.strictEqual(shockEvents.length, 2, 'Two ECONOMIC_SHOCK events');

  const ids = shockEvents.map(e => e.data.shock.shockId);
  assert.ok(ids.includes('MARKET_CRASH_2008_LITE'));
  assert.ok(ids.includes('COVID_2020_LITE'));

  const expectedTicks = SHOCK_LIBRARY.MARKET_CRASH_2008_LITE.recovery.durationMonths
                      + SHOCK_LIBRARY.COVID_2020_LITE.recovery.durationMonths;
  const tickEvents = events.filter(e => e.type === 'ECONOMIC_RECOVERY_TICK');
  assert.strictEqual(tickEvents.length, expectedTicks);
});

test('PARAM-9: custom full-object shock (no preset) still schedules events', () => {
  const custom = {
    shockId:   'my-custom-shock',
    name:      'Custom Shock',
    startDate: '2031-03-15',
    levelEffects: { equityRevaluation: { rateKeys: ['EQUITY_US'], multiplier: -0.20 } },
    regime: { returnAdjustment: { EQUITY_US: -0.02 } },
    recovery: { profile: 'V', durationMonths: 6 },
  };
  const ctx = makeContext([custom]);
  const events = ECONOMIC_REGIMES.schedules(ctx);

  assert.strictEqual(events.filter(e => e.type === 'ECONOMIC_SHOCK').length, 1);
  assert.strictEqual(events.filter(e => e.type === 'ECONOMIC_RECOVERY_TICK').length, 6);
});

// ─── Integration: options survives ScenarioLoader round-trip ──────────────────

const SIM_START = new Date('2026-01-01');
const SIM_END   = new Date('2030-01-01');

const BASE_CFG = {
  toolsets:   ['US_BANKING', 'US_TAX', 'US_RETIREMENT', 'ECONOMIC_REGIMES'],
  simStart:   '2026-01-01',
  simEnd:     '2030-01-01',
  parameters: {
    monthlyExpenses: 0, inflationAdjust: false, inflationRate: 0,
    rothGrowthRate: 0.0, iraGrowthRate: 0, k401GrowthRate: 0,
    brokerageGrowthRate: 0, brokerageDividendRate: 0,
    fixedIncomeInterestRate: 0, usSavingsInterestRate: 0,
    shocks: [],
  },
  persons: [{
    __type: 'Person', id: 'primary', name: 'Primary',
    birthDate: '1975-04-15', citizen: ['US'], lifeExpectancy: 90,
    monthlyWage: 0, retirementDate: '2025-01-01', socialSecurityMonthly: 0,
  }],
  accounts: [{
    __type: 'SavingsAccount', id: 'checking', name: 'Checking',
    role: 'us-savings', stateKey: 'checkingAccount',
    initialValue: 50000, ownershipType: 'sole', ownerId: 'primary',
    minimumBalance: 0, country: 'US', currency: { code: 'USD', symbol: '$' },
  }],
};

test('PARAM-10: options field is present on shocks param after ScenarioLoader.load()', () => {
  const cfg = structuredClone(BASE_CFG);
  const services = ServiceRegistry.getInstance();
  const scenario = new BaseScenario({
    context:  services.simulationContext,
    simStart: SIM_START,
    simEnd:   SIM_END,
  });
  scenario.buildSim();
  new ScenarioLoader().load(cfg, services);

  const shocksParam = cfg.params?.find(p => p.name === 'shocks');
  assert.ok(shocksParam, 'shocks param must be in cfg.params after load');
  assert.ok(Array.isArray(shocksParam.options), 'options must be an array');
  assert.strictEqual(shocksParam.options[0].value, 'none', 'first option is none');
  assert.ok(shocksParam.options.length > 1, 'options includes library presets');
});

test('PARAM-10b: preset shock fires ECONOMIC_SHOCK event during simulation', () => {
  const cfg = structuredClone(BASE_CFG);
  cfg.parameters.shocks = [{ preset: 'MILD_CORRECTION', startDate: '2027-03-01' }];
  cfg.accounts.push({
    __type: 'RothAccount', stateKey: 'rothAccount', role: 'roth-ira',
    name: 'Roth IRA', initialValue: 100000,
    contributionBasis: 0, ownerId: 'primary',
    drawdownPriority: 5, country: 'US', currency: { code: 'USD', symbol: '$' },
  });
  const services = ServiceRegistry.getInstance();
  const scenario = new BaseScenario({
    context:  services.simulationContext,
    simStart: SIM_START,
    simEnd:   SIM_END,
  });
  scenario.buildSim();
  new ScenarioLoader().load(cfg, services);
  const { sim } = scenario;

  sim.stepTo(new Date('2027-04-01'));

  // MILD_CORRECTION: −15% US equity level effect → Roth drops from 100k
  const balance = sim.state.rothAccount.balance;
  assert.ok(balance < 90000, `Expected Roth < 90000 after −15% correction, got ${balance}`);
  assert.ok(balance > 75000, `Expected Roth > 75000 (not below −25%), got ${balance}`);
});
