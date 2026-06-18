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
 * evt-recovery-u.test.mjs
 *
 * Tests for U-shape recovery curve behavior:
 *   EVT-RECOVERY-U-1: RecoveryCurves.U returns 1 at t=0
 *   EVT-RECOVERY-U-2: RecoveryCurves.U returns 0 at t=durationMonths
 *   EVT-RECOVERY-U-3: RecoveryCurves.U stays flat at 1 for the first half
 *   EVT-RECOVERY-U-4: RecoveryCurves.U decays linearly in the second half
 *   EVT-RECOVERY-U-5: U-curve integration — rate stays depressed for first half, then recovers
 */

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { RecoveryCurves } from '../../src/finance/economic-regimes/recovery-curves.js';
import { ServiceRegistry } from '../../src/services/service-registry.js';
import { ScenarioLoader }  from '../../src/scenarios/scenario-loader.js';
import { BaseScenario }    from '../../src/index.js';

beforeEach(() => ServiceRegistry.resetAll());

// ─── Unit tests for RecoveryCurves.U ──────────────────────────────────────────

test('EVT-RECOVERY-U-1: U curve returns 1.0 at t=0', () => {
  assert.strictEqual(RecoveryCurves.U(0, 12), 1.0);
});

test('EVT-RECOVERY-U-2: U curve returns 0.0 at t=durationMonths', () => {
  assert.strictEqual(RecoveryCurves.U(12, 12), 0.0);
});

test('EVT-RECOVERY-U-3: U curve stays flat at 1.0 throughout first half', () => {
  assert.strictEqual(RecoveryCurves.U(3, 12), 1.0);
  assert.strictEqual(RecoveryCurves.U(5.9, 12), 1.0);
});

test('EVT-RECOVERY-U-4: U curve decays linearly in second half — midpoint of second half is 0.5', () => {
  // Second half: t in [6, 12]. Midpoint of second half = t=9 → factor = 0.5
  const mid = RecoveryCurves.U(9, 12);
  assert.ok(Math.abs(mid - 0.5) < 0.001, `Expected 0.5 at t=9 (mid of second half), got ${mid}`);
});

test('EVT-RECOVERY-U-4b: U curve returns 1 for negative t (before shock)', () => {
  assert.strictEqual(RecoveryCurves.U(-1, 12), 1.0);
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

test('EVT-RECOVERY-U-5: U-curve keeps effectiveGrowthRates fully depressed for first half, then recovers', () => {
  const baseRate   = 0.06;
  const adjustment = -0.06;
  // 12-month U-shaped recovery: first 6 months flat at 1, then linear fade to 0
  const shock = {
    shockId: 'shock-u', name: 'U Recovery Test',
    startDate: '2026-02-01',
    regime: { returnAdjustment: { EQUITY_US: adjustment } },
    recovery: { profile: 'U', durationMonths: 12 },
  };
  const { sim } = loadScenario({ rothGrowthRate: baseRate, shocks: [shock] });

  // Just after shock, still in stagnation half: factor = 1, effective rate = base + adjustment
  sim.stepTo(new Date('2026-04-01'));
  const rateStagnation = sim.state.effectiveGrowthRates?.EQUITY_US_ROTH ?? NaN;
  assert.ok(
    Math.abs(rateStagnation - (baseRate + adjustment)) < 0.001,
    `Stagnation-phase rate should be ${baseRate + adjustment}, got ${rateStagnation}`
  );

  // Past the stagnation midpoint (t ~ 9 months): should be partially recovered
  sim.stepTo(new Date('2026-11-01'));
  const rateMid = sim.state.effectiveGrowthRates?.EQUITY_US_ROTH ?? NaN;
  assert.ok(
    rateMid > rateStagnation,
    `Mid-recovery rate (${rateMid}) should be > stagnation rate (${rateStagnation})`
  );

  // After recovery complete: rate returns to base
  sim.stepTo(new Date('2027-04-01'));
  const rateAfter = sim.state.effectiveGrowthRates?.EQUITY_US_ROTH ?? NaN;
  assert.ok(
    Math.abs(rateAfter - baseRate) < 0.001,
    `Post-recovery rate should return to base ${baseRate}, got ${rateAfter}`
  );
  assert.strictEqual(sim.state.activeRegimes.length, 0, 'U-regime should be dropped after full duration');
});
