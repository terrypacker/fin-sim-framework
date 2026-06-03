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
 * evt-shock-fx-regime.test.mjs
 *
 * Tests that a regime with fxAdjustment composes into state.effectiveExchangeRates.USD_AUD
 * when both ECONOMIC_REGIMES and US_AU_CROSS_BORDER are loaded.
 *
 *   EVT-SHOCK-FX-1: After shock with fxAdjustment, effectiveExchangeRates.USD_AUD is adjusted
 *   EVT-SHOCK-FX-2: After recovery completes, effectiveExchangeRates.USD_AUD returns to base
 *   EVT-SHOCK-FX-3: Without ECONOMIC_REGIMES, fxAdjustment has no effect (regression)
 */

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { ServiceRegistry } from '../../src/services/service-registry.js';
import { ScenarioLoader }  from '../../src/scenarios/scenario-loader.js';
import { BaseScenario }    from '../../src/index.js';

beforeEach(() => ServiceRegistry.resetAll());

const SIM_START = new Date('2026-01-01');
const SIM_END   = new Date('2029-01-01');

function loadScenario(config) {
  const services = ServiceRegistry.getInstance();
  const scenario = new BaseScenario({
    context:  services.simulationContext,
    simStart: SIM_START,
    simEnd:   SIM_END,
  });
  scenario.buildSim();
  new ScenarioLoader().load(structuredClone(config), services);
  return { scenario, sim: scenario.sim };
}

const BASE_PARAMS = {
  monthlyExpenses: 0, inflationAdjust: false, inflationRate: 0, auInflationRate: 0,
  rothGrowthRate: 0, iraGrowthRate: 0, k401GrowthRate: 0,
  brokerageGrowthRate: 0, brokerageDividendRate: 0, fixedIncomeInterestRate: 0,
  usSavingsInterestRate: 0, auSavingsInterestRate: 0,
  superGrowthRate: 0, auStockGrowthRate: 0, auStockDividendRate: 0,
  exchangeRateUsdToAud: 1.55,
  intlTransferFeeUsd: 0,
};

const BASE_ACCOUNTS = [
  {
    __type: 'SavingsAccount', id: 'checking', name: 'US Savings',
    role: 'us-savings', stateKey: 'usSavingsAccount',
    initialValue: 50000, ownershipType: 'sole', ownerId: 'primary',
    minimumBalance: 0, country: 'US', currency: { code: 'USD', symbol: '$' },
  },
  {
    __type: 'SavingsAccount', id: 'au-savings', name: 'AU Savings',
    role: 'au-savings', stateKey: 'auSavingsAccount',
    initialValue: 50000, ownershipType: 'sole', ownerId: 'primary',
    minimumBalance: 0, country: 'AU', currency: { code: 'AUD', symbol: '$' },
  },
];

const PERSONS = [{
  __type: 'Person', id: 'primary', name: 'Primary',
  birthDate: '1975-04-15', citizen: ['US'], lifeExpectancy: 90,
  monthlyWage: 0, retirementDate: '2025-01-01', socialSecurityMonthly: 0,
}];

test('EVT-SHOCK-FX-1: FX-bearing regime raises effectiveExchangeRates.USD_AUD after shock fires', () => {
  const fxAdjustment = 0.10; // +10 units on top of 1.55 base
  const shock = {
    shockId:  'shock-fx-test',
    name:     'FX Regime Test',
    startDate: '2026-03-01',
    levelEffects: null,
    regime: { fxAdjustment: { USD_AUD: fxAdjustment } },
    recovery: { profile: 'L', durationMonths: 12 },
  };
  const { sim } = loadScenario({
    toolsets: ['US_RETIREMENT', 'AU_RETIREMENT', 'US_AU_CROSS_BORDER', 'ECONOMIC_REGIMES'],
    simStart: '2026-01-01',
    simEnd:   '2029-01-01',
    parameters: { ...BASE_PARAMS, shocks: [shock] },
    persons: PERSONS,
    accounts: BASE_ACCOUNTS,
  });

  // Before shock: effective rate = base (1.55)
  sim.stepTo(new Date('2026-02-15'));
  const rateBefore = sim.state.effectiveExchangeRates?.USD_AUD ?? NaN;
  assert.ok(
    Math.abs(rateBefore - 1.55) < 0.001,
    `Before shock, effectiveExchangeRates.USD_AUD should be 1.55, got ${rateBefore}`
  );

  // After shock fires (mid-duration, L-curve factor = 1): effective rate = 1.55 + 0.10 = 1.65
  sim.stepTo(new Date('2026-06-01'));
  const rateAfterShock = sim.state.effectiveExchangeRates?.USD_AUD ?? NaN;
  assert.ok(
    Math.abs(rateAfterShock - (1.55 + fxAdjustment)) < 0.01,
    `After shock, effectiveExchangeRates.USD_AUD should be ~${1.55 + fxAdjustment}, got ${rateAfterShock}`
  );
});

test('EVT-SHOCK-FX-2: After FX regime expires, effectiveExchangeRates.USD_AUD returns to base', () => {
  const fxAdjustment = 0.10;
  const shock = {
    shockId:  'shock-fx-expiry',
    name:     'FX Regime Expiry Test',
    startDate: '2026-02-01',
    levelEffects: null,
    regime: { fxAdjustment: { USD_AUD: fxAdjustment } },
    recovery: { profile: 'V', durationMonths: 6 },
  };
  const { sim } = loadScenario({
    toolsets: ['US_RETIREMENT', 'AU_RETIREMENT', 'US_AU_CROSS_BORDER', 'ECONOMIC_REGIMES'],
    simStart: '2026-01-01',
    simEnd:   '2029-01-01',
    parameters: { ...BASE_PARAMS, shocks: [shock] },
    persons: PERSONS,
    accounts: BASE_ACCOUNTS,
  });

  // After V-curve expires (6 months from Feb 2026 = Aug 2026): rate returns to base
  sim.stepTo(new Date('2026-10-01'));
  const rateAfter = sim.state.effectiveExchangeRates?.USD_AUD ?? NaN;
  assert.ok(
    Math.abs(rateAfter - 1.55) < 0.01,
    `After FX regime expires, effectiveExchangeRates.USD_AUD should return to 1.55, got ${rateAfter}`
  );
  assert.strictEqual(sim.state.activeRegimes.length, 0, 'FX regime should be dropped after V recovery');
});

test('EVT-SHOCK-FX-3: Without ECONOMIC_REGIMES, effectiveExchangeRates.USD_AUD equals base (regression)', () => {
  const { sim } = loadScenario({
    toolsets: ['US_RETIREMENT', 'AU_RETIREMENT', 'US_AU_CROSS_BORDER'],
    simStart: '2026-01-01',
    simEnd:   '2029-01-01',
    parameters: BASE_PARAMS,
    persons: PERSONS,
    accounts: BASE_ACCOUNTS,
  });

  sim.stepTo(new Date('2027-01-01'));
  const rate = sim.state.effectiveExchangeRates?.USD_AUD ?? NaN;
  assert.ok(
    Math.abs(rate - 1.55) < 0.001,
    `Without ECONOMIC_REGIMES, effectiveExchangeRates.USD_AUD should be 1.55, got ${rate}`
  );
});
