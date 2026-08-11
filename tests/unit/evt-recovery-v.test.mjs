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
 * evt-recovery-v.test.mjs
 *
 * Tests for V-shape recovery curve behavior:
 *   EVT-RECOVERY-V-1: RecoveryCurves.V returns 1 at t=0
 *   EVT-RECOVERY-V-2: RecoveryCurves.V returns 0 at t=durationMonths
 *   EVT-RECOVERY-V-3: RecoveryCurves.V is linear between 0 and durationMonths
 *   EVT-RECOVERY-V-4: ECONOMIC_RECOVERY_TICK events drive gradual rate recovery in simulation
 */

import { test } from 'node:test';
import { beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { RecoveryCurves } from '../../src/finance/economic-regimes/recovery-curves.js';
import { ServiceRegistry } from '../../src/services/service-registry.js';
import { ScenarioLoader }  from '../../src/scenarios/scenario-loader.js';
import { BaseScenario }    from '../../src/index.js';

beforeEach(() => ServiceRegistry.resetAll());

// ─── Unit tests for RecoveryCurves.V ──────────────────────────────────────────

test('EVT-RECOVERY-V-1: V curve returns 1.0 at t=0', () => {
  assert.strictEqual(RecoveryCurves.V(0, 12), 1.0);
});

test('EVT-RECOVERY-V-2: V curve returns 0.0 at t=durationMonths', () => {
  assert.strictEqual(RecoveryCurves.V(12, 12), 0.0);
});

test('EVT-RECOVERY-V-3: V curve is linear — midpoint returns 0.5', () => {
  const mid = RecoveryCurves.V(6, 12);
  assert.ok(Math.abs(mid - 0.5) < 0.001, `Expected 0.5 at midpoint, got ${mid}`);
});

test('EVT-RECOVERY-V-3b: V curve returns 1 for negative t (before shock)', () => {
  assert.strictEqual(RecoveryCurves.V(-1, 12), 1.0);
});

// ─── Integration test: ECONOMIC_RECOVERY_TICK drives rate recovery in sim ─────

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

test('EVT-RECOVERY-V-4: V-curve recovery gradually reduces regime impact over time', () => {
  const baseRate = 0.06;
  const adjustment = -0.06;
  const shock = {
    shockId: 'shock-v', name: 'V Recovery Test',
    startDate: '2026-02-01',
    regime: { returnAdjustment: { EQUITY_US: adjustment } },
    recovery: { profile: 'V', durationMonths: 6 },
  };
  const { sim } = loadScenario({ rothGrowthRate: baseRate, shocks: [shock] });

  // Just after shock: factor ~1, effective rate ~0.06 + (-0.06) = 0
  sim.stepTo(new Date('2026-02-15'));
  // Design 90 §7.2 — read the Roth's PER-ACCOUNT key. `rothGrowthRate` is a wrapper
  // rate and now lands on `EQUITY_US::rothAccount`; the bare `EQUITY_US` key carries the
  // MARKET rate (0.07 by default), which is not the baseline these assertions are
  // written against.
  const rateNearStart = sim.state.effectiveGrowthRates?.['EQUITY_US::rothAccount'] ?? NaN;

  // Halfway through recovery: factor ~0.5, effective rate ~0.06 + (-0.03) = 0.03
  sim.stepTo(new Date('2026-05-01'));
  const rateMid = sim.state.effectiveGrowthRates?.['EQUITY_US::rothAccount'] ?? NaN;

  // After recovery complete: factor = 0, effective rate = base
  sim.stepTo(new Date('2026-09-01'));
  const rateAfter = sim.state.effectiveGrowthRates?.['EQUITY_US::rothAccount'] ?? NaN;

  assert.ok(rateNearStart < 0.02, `Near-start effective rate should be near 0, got ${rateNearStart}`);
  assert.ok(rateMid > rateNearStart, `Mid rate (${rateMid}) should be > near-start rate (${rateNearStart})`);
  assert.ok(Math.abs(rateAfter - baseRate) < 0.001,
    `Post-recovery rate should return to base ${baseRate}, got ${rateAfter}`);
});
