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
 * evt-economic-shock.test.mjs
 *
 * EVT-SHOCK-1: ECONOMIC_SHOCK with levelEffects.equityRevaluation drops Roth balance
 * EVT-SHOCK-2: ECONOMIC_SHOCK pushes regime onto state.activeRegimes
 * EVT-SHOCK-3: No REVALUE_ASSET_APPLY when levelEffects is absent
 * EVT-SHOCK-4: effectiveGrowthRates reflects regime returnAdjustment
 */

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { ServiceRegistry } from '../../src/services/service-registry.js';
import { ScenarioLoader }  from '../../src/scenarios/scenario-loader.js';
import { BaseScenario }    from '../../src/index.js';

beforeEach(() => ServiceRegistry.resetAll());

const SIM_START = new Date('2026-01-01');
const SIM_END   = new Date('2028-01-01');

const BASE_CFG = {
  toolsets:   ['US_BANKING', 'US_TAX', 'US_RETIREMENT', 'ECONOMIC_REGIMES'],
  simStart:   '2026-01-01',
  simEnd:     '2028-01-01',
  parameters: {
    monthlyExpenses: 0, inflationAdjust: false, inflationRate: 0,
    rothGrowthRate: 0.0, iraGrowthRate: 0, k401GrowthRate: 0,
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

test('EVT-SHOCK-1: equityRevaluation multiplier drops Roth balance', () => {
  const shock = {
    shockId:  'shock-1', name: 'Test Crash',
    startDate: '2026-03-01',
    levelEffects: {
      equityRevaluation: { rateKeys: ['EQUITY_US'], multiplier: -0.30 },
    },
    recovery: { profile: 'V', durationMonths: 12 },
  };
  const { sim } = loadScenario({ shocks: [shock] });

  sim.stepTo(new Date('2026-04-01'));

  const balance = sim.state.rothAccount.balance;
  assert.ok(balance < 75000, `Expected Roth < 75000, got ${balance}`);
  assert.ok(balance > 60000, `Expected Roth > 60000, got ${balance}`);
});

test('EVT-SHOCK-2: ECONOMIC_SHOCK pushes regime onto state.activeRegimes', () => {
  const shock = {
    shockId: 'shock-2', name: 'Regime Push Test',
    startDate: '2026-06-01',
    regime: { returnAdjustment: { EQUITY_US: -0.05 } },
    recovery: { profile: 'V', durationMonths: 6 },
  };
  const { sim } = loadScenario({ rothGrowthRate: 0.07, shocks: [shock] });

  sim.stepTo(new Date('2026-07-01'));

  const { activeRegimes } = sim.state;
  assert.ok(Array.isArray(activeRegimes), 'state.activeRegimes should be an array');
  assert.ok(activeRegimes.length >= 1, 'At least one active regime after shock');
  assert.ok(
    activeRegimes.some(r => r.shockId === 'shock-2'),
    'Regime with shockId "shock-2" should be active'
  );
});

test('EVT-SHOCK-3: shock without levelEffects leaves balance unchanged', () => {
  const shock = {
    shockId: 'shock-3', name: 'Regime Only',
    startDate: '2026-03-01',
    regime:    { returnAdjustment: { EQUITY_US: -0.02 } },
    recovery:  { profile: 'L', durationMonths: 24 },
  };
  const { sim } = loadScenario({ shocks: [shock] });

  sim.stepTo(new Date('2026-04-01'));

  // No levelEffect → no REVALUE_ASSET_APPLY → balance unchanged (growthRate=0)
  assert.ok(
    Math.abs(sim.state.rothAccount.balance - 100000) < 1,
    `Balance should be ~100000 without levelEffects, got ${sim.state.rothAccount.balance}`
  );
});

test('EVT-SHOCK-4: effectiveGrowthRates reflects regime returnAdjustment', () => {
  const shock = {
    shockId: 'shock-4', name: 'Rate Adjustment',
    startDate: '2026-02-01',
    regime:    { returnAdjustment: { EQUITY_US: -0.04 } },
    recovery:  { profile: 'L', durationMonths: 24 },
  };
  const { sim } = loadScenario({ rothGrowthRate: 0.07, shocks: [shock] });

  sim.stepTo(new Date('2026-03-01'));

  // Design 90 §7.2 — the fan-out target moved from per-account-type MEMBER keys
  // (EQUITY_US_ROTH, EQUITY_US_K401) to per-ACCOUNT keys under the market sleeve
  // (`EQUITY_US::<stateKey>`). `_addScaledExpandingClasses` reaches them through its
  // `<leaf>::` sweep, so coverage is unchanged — but the assertion has to name the
  // account, because the whole point is that each one keeps its OWN baseline under a
  // shared shock. Asserting the bare `EQUITY_US` key twice, as a mechanical rename of
  // this test did, cannot distinguish the two accounts at all.
  const eff = sim.state.effectiveGrowthRates ?? {};

  // The Roth: base rothGrowthRate 0.07 + returnAdjustment −0.04 = 0.03.
  const rothRate = eff['EQUITY_US::rothAccount'];
  assert.ok(rothRate !== undefined, 'EQUITY_US::rothAccount must exist');
  assert.ok(Math.abs(rothRate - 0.03) < 0.001, `Expected Roth ~0.03, got ${rothRate}`);

  // The shared market key takes the shock too, for any holding with no per-account
  // override. Both are asserted because they are separately reachable: the sweep writes
  // `EQUITY_US` directly and `EQUITY_US::*` through the prefix scan, and a fan-out that
  // did only one of the two would still satisfy the other assertion alone.
  assert.ok(Math.abs((eff.EQUITY_US ?? NaN) - (0.07 - 0.04)) < 0.001,
    `Expected the EQUITY_US market rate ~0.03, got ${eff.EQUITY_US}`);

  // No 401k assertion: BASE_CFG has no 401k account. Before design 90 there was a
  // shared `EQUITY_US_K401` key seeded from `k401GrowthRate` whether or not any 401k
  // existed, so the original test could assert on it — a per-ACCOUNT key has no such
  // phantom, which is an improvement rather than lost coverage. `evt-per-account-
  // growth.test.mjs` covers multi-account fan-out against a scenario that has them.
  assert.equal(eff['EQUITY_US::k401Account'], undefined,
    'no phantom per-account key for an account this scenario does not have');
});
