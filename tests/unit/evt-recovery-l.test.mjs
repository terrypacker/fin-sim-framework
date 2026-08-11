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
 * evt-recovery-l.test.mjs
 *
 * Tests for L-shape recovery curve (permanent structural shift):
 *   EVT-RECOVERY-L-1: RecoveryCurves.L returns 1 at t=0
 *   EVT-RECOVERY-L-2: RecoveryCurves.L returns 1 throughout duration
 *   EVT-RECOVERY-L-3: RecoveryCurves.L snaps to 0 at durationMonths
 *   EVT-RECOVERY-L-4: L-curve regime keeps effectiveGrowthRates depressed for full duration
 */

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { RecoveryCurves } from '../../src/finance/economic-regimes/recovery-curves.js';
import { ServiceRegistry } from '../../src/services/service-registry.js';
import { ScenarioLoader }  from '../../src/scenarios/scenario-loader.js';
import { BaseScenario }    from '../../src/index.js';

beforeEach(() => ServiceRegistry.resetAll());

// ─── Unit tests for RecoveryCurves.L ──────────────────────────────────────────

test('EVT-RECOVERY-L-1: L curve returns 1.0 at t=0', () => {
  assert.strictEqual(RecoveryCurves.L(0, 12), 1.0);
});

test('EVT-RECOVERY-L-2: L curve returns 1.0 at midpoint', () => {
  assert.strictEqual(RecoveryCurves.L(6, 12), 1.0);
});

test('EVT-RECOVERY-L-3: L curve snaps to 0 at durationMonths', () => {
  assert.strictEqual(RecoveryCurves.L(12, 12), 0.0);
});

test('EVT-RECOVERY-L-3b: L curve returns 1 just before durationMonths', () => {
  assert.strictEqual(RecoveryCurves.L(11.9, 12), 1.0);
});

// ─── Integration test ─────────────────────────────────────────────────────────

const SIM_START = new Date('2026-01-01');
const SIM_END   = new Date('2028-06-01');

const BASE_CFG = {
  toolsets:   ['US_BANKING', 'US_TAX', 'US_RETIREMENT', 'ECONOMIC_REGIMES'],
  simStart:   '2026-01-01',
  simEnd:     '2028-06-01',
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

test('EVT-RECOVERY-L-4: L-curve keeps effectiveGrowthRates depressed for full duration then resets', () => {
  const baseRate = 0.07;
  const adjustment = -0.04;
  const shock = {
    shockId: 'shock-l', name: 'L Recovery Test',
    startDate: '2026-02-01',
    regime: { returnAdjustment: { EQUITY_US: adjustment } },
    recovery: { profile: 'L', durationMonths: 12 },
  };
  const { sim } = loadScenario({ rothGrowthRate: baseRate, shocks: [shock] });

  // Mid-duration: factor = 1, full adjustment still applied. The class shock
  // fans out to the per-account member key (EQUITY_US).
  sim.stepTo(new Date('2026-08-01'));
  // Design 90 §7.2 — read the Roth's PER-ACCOUNT key. `rothGrowthRate` is a wrapper
  // rate and now lands on `EQUITY_US::rothAccount`; the bare `EQUITY_US` key carries the
  // MARKET rate (0.07 by default), which is not the baseline these assertions are
  // written against.
  const rateMid = sim.state.effectiveGrowthRates?.['EQUITY_US::rothAccount'] ?? NaN;
  assert.ok(
    Math.abs(rateMid - (baseRate + adjustment)) < 0.001,
    `Mid-L rate should be ${baseRate + adjustment}, got ${rateMid}`
  );

  // After duration (>12 months from Feb 2026 = after Feb 2027): regime expires, rate returns to base
  sim.stepTo(new Date('2027-04-01'));
  const rateAfter = sim.state.effectiveGrowthRates?.['EQUITY_US::rothAccount'] ?? NaN;
  assert.ok(
    Math.abs(rateAfter - baseRate) < 0.001,
    `Post-L rate should return to base ${baseRate}, got ${rateAfter}`
  );
  assert.strictEqual(sim.state.activeRegimes.length, 0, 'L-regime should be dropped after duration');
});
