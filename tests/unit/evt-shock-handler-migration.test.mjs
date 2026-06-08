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
 * evt-shock-handler-migration.test.mjs
 *
 * Tests that earnings handlers fall back to their configured growthRate when
 * ECONOMIC_REGIMES is NOT loaded (no state.effectiveGrowthRates), ensuring
 * bit-for-bit compatibility with scenarios that don't include the toolset.
 *
 *   EVT-MIGRATION-1: Roth earnings without ECONOMIC_REGIMES use configured growthRate
 *   EVT-MIGRATION-2: Roth earnings with ECONOMIC_REGIMES and no shocks equal non-regime run
 *   EVT-MIGRATION-3: effectiveGrowthRates absent → earnings fallback produces same growth as explicit rate
 *
 * Note: INTL_ROTH_EARNINGS is scheduled at year-end with startOffset(1), so first earnings
 * fire at 2027-12-31 (second year). Tests step to 2028-01-01 to capture earnings.
 */

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { ServiceRegistry } from '../../src/services/service-registry.js';
import { ScenarioLoader }  from '../../src/scenarios/scenario-loader.js';
import { BaseScenario }    from '../../src/index.js';

beforeEach(() => ServiceRegistry.resetAll());

const SIM_START = new Date('2026-01-01');
const SIM_END   = new Date('2030-01-01');

const COMMON_PARAMS = {
  monthlyExpenses: 0, inflationAdjust: false, inflationRate: 0,
  rothGrowthRate: 0.12, iraGrowthRate: 0, k401GrowthRate: 0,
  brokerageGrowthRate: 0, brokerageDividendRate: 0,
  fixedIncomeInterestRate: 0, usSavingsInterestRate: 0,
};

const COMMON_PERSONS = [{
  __type: 'Person', id: 'primary', name: 'Primary',
  birthDate: '1975-04-15', citizen: ['US'], lifeExpectancy: 90,
  monthlyWage: 0, retirementDate: '2025-01-01', socialSecurityMonthly: 0,
}];

const COMMON_ACCOUNTS = [
  {
    __type: 'SavingsAccount', id: 'checking', name: 'Checking',
    role: 'us-savings', stateKey: 'checkingAccount',
    initialValue: 50000, ownershipType: 'sole', ownerId: 'primary',
    minimumBalance: 0, country: 'US', currency: { code: 'USD', symbol: '$' },
  },
  {
    __type: 'RothAccount', stateKey: 'rothAccount', role: 'roth-ira',
    name: 'Roth IRA', initialValue: 100000,
    contributionBasis: 0, ownerId: 'primary',
    drawdownPriority: 5, country: 'US', currency: { code: 'USD', symbol: '$' },
  },
];

function loadScenario(toolsets, extraParams = {}) {
  const cfg = {
    toolsets,
    simStart:   '2026-01-01',
    simEnd:     '2030-01-01',
    parameters: { ...COMMON_PARAMS, ...extraParams },
    persons:    structuredClone(COMMON_PERSONS),
    accounts:   structuredClone(COMMON_ACCOUNTS),
  };
  const services = ServiceRegistry.getInstance();
  const scenario = new BaseScenario({
    context:  services.simulationContext,
    simStart: SIM_START,
    simEnd:   SIM_END,
  });
  scenario.buildSim();
  new ScenarioLoader().load(cfg, services);
  return { scenario, sim: scenario.sim };
}

// Earnings fire at year-end starting year 1 (2027-12-31). Step to 2028-06-01 to capture.
const AFTER_EARNINGS = new Date('2028-06-01');

test('EVT-MIGRATION-1: Roth earnings without ECONOMIC_REGIMES use configured growthRate', () => {
  const { sim } = loadScenario(['US_BANKING', 'US_TAX', 'US_RETIREMENT']);

  // effectiveGrowthRates should not be present (ECONOMIC_REGIMES not loaded)
  assert.strictEqual(sim.state.effectiveGrowthRates, undefined,
    'effectiveGrowthRates should not exist without ECONOMIC_REGIMES');

  sim.stepTo(AFTER_EARNINGS);

  // At 12% annual, 100k initial → after ~2 years the balance should have grown
  const balance = sim.state.rothAccount.balance;
  // Earnings fire once at year-end 2027 (startOffset=1): 100000 × 1.12 = 112000
  assert.ok(balance > 100000, `Roth should have grown at 12%, got ${balance}`);
  assert.ok(balance > 110000, `Balance ${balance} should be well above 110k after one year-end earnings`);
});

test('EVT-MIGRATION-2: with ECONOMIC_REGIMES and no shocks, result equals non-regime run', () => {
  const { sim: simWithout } = loadScenario(['US_BANKING', 'US_TAX', 'US_RETIREMENT']);
  simWithout.stepTo(AFTER_EARNINGS);
  const balanceWithout = simWithout.state.rothAccount.balance;

  ServiceRegistry.resetAll();

  const { sim: simWith } = loadScenario(
    ['US_BANKING', 'US_TAX', 'US_RETIREMENT', 'ECONOMIC_REGIMES'],
    { shocks: [] }
  );
  simWith.stepTo(AFTER_EARNINGS);
  const balanceWith = simWith.state.rothAccount.balance;

  // Should be essentially identical — the regime layer is a no-op with no shocks
  assert.ok(
    Math.abs(balanceWith - balanceWithout) < 1,
    `Balances should match: without=${balanceWithout}, with=${balanceWith}`
  );
});

test('EVT-MIGRATION-3: effectiveGrowthRates absent produces same growth as explicit rate path', () => {
  // Run two scenarios: one without ECONOMIC_REGIMES (fallback path) and one
  // with ECONOMIC_REGIMES but zero adjustment (explicit effective rate = base rate).
  // Results should be identical.
  const { sim: simFallback } = loadScenario(['US_BANKING', 'US_TAX', 'US_RETIREMENT']);
  simFallback.stepTo(AFTER_EARNINGS);
  const balanceFallback = simFallback.state.rothAccount.balance;

  ServiceRegistry.resetAll();

  const { sim: simExplicit } = loadScenario(
    ['US_BANKING', 'US_TAX', 'US_RETIREMENT', 'ECONOMIC_REGIMES'],
    { shocks: [], rothGrowthRate: 0.12 }
  );
  simExplicit.stepTo(AFTER_EARNINGS);
  const balanceExplicit = simExplicit.state.rothAccount.balance;

  assert.ok(balanceFallback > 100000, `Fallback path should grow, got ${balanceFallback}`);
  assert.ok(
    Math.abs(balanceFallback - balanceExplicit) < 1,
    `Fallback (${balanceFallback}) and explicit (${balanceExplicit}) should match`
  );
});
