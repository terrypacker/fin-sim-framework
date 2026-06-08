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
 * evt-regime-stack.test.mjs
 *
 * Tests for stacking multiple concurrent regimes:
 *   EVT-REGIME-STACK-1: Two overlapping shocks stack additively on effectiveGrowthRates
 *   EVT-REGIME-STACK-2: An expired regime is removed from state.activeRegimes
 *   EVT-REGIME-STACK-3: REMOVE_REGIME_APPLY manually removes a specific regime
 */

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { ServiceRegistry }    from '../../src/services/service-registry.js';
import { ScenarioLoader }     from '../../src/scenarios/scenario-loader.js';
import { BaseScenario }       from '../../src/index.js';
import { RemoveRegimeReducer } from '../../src/finance/economic-regimes/remove-regime-reducer.js';

beforeEach(() => ServiceRegistry.resetAll());

const SIM_START = new Date('2026-01-01');
const SIM_END   = new Date('2028-01-01');

const BASE_CFG = {
  toolsets:   ['US_BANKING', 'US_TAX', 'US_RETIREMENT', 'ECONOMIC_REGIMES'],
  simStart:   '2026-01-01',
  simEnd:     '2028-01-01',
  parameters: {
    monthlyExpenses: 0, inflationAdjust: false, inflationRate: 0,
    rothGrowthRate: 0.07, iraGrowthRate: 0, k401GrowthRate: 0,
    brokerageGrowthRate: 0, brokerageDividendRate: 0,
    fixedIncomeInterestRate: 0, usSavingsInterestRate: 0,
  },
  persons: [{
    __type: 'Person', id: 'primary', name: 'Primary',
    birthDate: '1975-04-15', citizen: ['US'], lifeExpectancy: 90,
    monthlyWage: 0, retirementDate: '2025-01-01', socialSecurityMonthly: 0,
  }],
  accounts: [
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
  ],
};

function loadScenario(extraParams = {}) {
  const cfg = structuredClone(BASE_CFG);
  cfg.parameters = { ...BASE_CFG.parameters, ...extraParams };
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

test('EVT-REGIME-STACK-1: two overlapping shocks stack additively on effectiveGrowthRates', () => {
  const shocks = [
    {
      shockId: 'shock-a', name: 'Shock A',
      startDate: '2026-02-01',
      regime: { returnAdjustment: { EQUITY_US: -0.02 } },
      recovery: { profile: 'L', durationMonths: 24 },
    },
    {
      shockId: 'shock-b', name: 'Shock B',
      startDate: '2026-03-01',
      regime: { returnAdjustment: { EQUITY_US: -0.01 } },
      recovery: { profile: 'L', durationMonths: 24 },
    },
  ];
  const baseRate = 0.07;
  const { sim } = loadScenario({ rothGrowthRate: baseRate, shocks });

  sim.stepTo(new Date('2026-05-01'));

  // effectiveGrowthRates.EQUITY_US = 0.07 - 0.02 - 0.01 = 0.04
  const effectiveRate = sim.state.effectiveGrowthRates?.EQUITY_US;
  assert.ok(effectiveRate !== undefined, 'effectiveGrowthRates.EQUITY_US must exist');
  assert.ok(
    Math.abs(effectiveRate - 0.04) < 0.001,
    `Expected effective rate ~0.04 (stacked), got ${effectiveRate}`
  );
  assert.strictEqual(sim.state.activeRegimes.length, 2, 'Both regimes should be active');
});

test('EVT-REGIME-STACK-2: expired V-curve regime is dropped from state.activeRegimes', () => {
  const shock = {
    shockId: 'shock-short', name: 'Short Shock',
    startDate: '2026-02-01',
    regime: { returnAdjustment: { EQUITY_US: -0.05 } },
    recovery: { profile: 'V', durationMonths: 2 },
  };
  const { sim } = loadScenario({ shocks: [shock] });

  // After 3 months the 2-month V regime should have expired
  sim.stepTo(new Date('2026-06-01'));

  const active = sim.state.activeRegimes ?? [];
  assert.strictEqual(active.length, 0, 'Expired V-curve regime should be dropped');

  // Effective rate should return to base
  const effectiveRate = sim.state.effectiveGrowthRates?.EQUITY_US;
  assert.ok(
    Math.abs(effectiveRate - 0.07) < 0.001,
    `Effective rate should return to base 0.07 after expiry, got ${effectiveRate}`
  );
});

test('EVT-REGIME-STACK-3: RemoveRegimeReducer removes a specific regime by ID', () => {
  // Unit test: directly invoke RemoveRegimeReducer to verify filter behavior.
  // REMOVE_REGIME_APPLY is an action type (emitted by handlers), not a schedulable event.
  const reducer = new RemoveRegimeReducer();

  const stateWithTwo = {
    activeRegimes: [
      { id: 'regime-shock-keep',   shockId: 'shock-keep',   returnAdjustment: null, currentFactor: 1.0, durationMonths: 24 },
      { id: 'regime-shock-remove', shockId: 'shock-remove', returnAdjustment: null, currentFactor: 1.0, durationMonths: 24 },
    ],
  };

  const action = { type: 'REMOVE_REGIME_APPLY', regimeId: 'regime-shock-remove' };
  const next = reducer.reduce(stateWithTwo, action);

  assert.strictEqual(next.activeRegimes.length, 1, 'One regime should remain');
  assert.strictEqual(next.activeRegimes[0].id, 'regime-shock-keep', 'Remaining regime should be shock-keep');
});
