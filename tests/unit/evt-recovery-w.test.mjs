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
 * evt-recovery-w.test.mjs
 *
 * Tests for W-shape recovery curve behavior (damped cosine, double-dip):
 *   EVT-RECOVERY-W-1: RecoveryCurves.W returns 1 at t=0
 *   EVT-RECOVERY-W-2: RecoveryCurves.W returns 0 at t=durationMonths
 *   EVT-RECOVERY-W-3: W curve has a local minimum near t=durationMonths/2 (double-dip)
 *   EVT-RECOVERY-W-4: W-curve integration — shows double-dip pattern in effectiveGrowthRates
 */

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { RecoveryCurves } from '../../src/finance/economic-regimes/recovery-curves.js';
import { ServiceRegistry } from '../../src/services/service-registry.js';
import { ScenarioLoader }  from '../../src/scenarios/scenario-loader.js';
import { BaseScenario }    from '../../src/index.js';

beforeEach(() => ServiceRegistry.resetAll());

// ─── Unit tests for RecoveryCurves.W ──────────────────────────────────────────

test('EVT-RECOVERY-W-1: W curve returns 1.0 at t=0', () => {
  assert.strictEqual(RecoveryCurves.W(0, 12), 1.0);
});

test('EVT-RECOVERY-W-2: W curve returns 0.0 at t=durationMonths', () => {
  assert.strictEqual(RecoveryCurves.W(12, 12), 0.0);
});

test('EVT-RECOVERY-W-3: W curve has a local minimum near t=durationMonths/2 (double-dip pattern)', () => {
  // Cosine at phase=π (t = durationMonths/2) produces: (1 + cos(π))/2 = 0
  const midVal = RecoveryCurves.W(6, 12);
  assert.ok(
    midVal < 0.1,
    `W curve should be near 0 at t=6 (phase=π), got ${midVal}`
  );
});

test('EVT-RECOVERY-W-3b: W curve has a local max near t=durationMonths/4 (first recovery)', () => {
  // Cosine at phase=π/2 (t = durationMonths/4) produces: (1 + cos(π/2))/2 = 0.5
  const quarterVal = RecoveryCurves.W(3, 12);
  assert.ok(
    quarterVal > 0.4 && quarterVal < 0.6,
    `W curve should be near 0.5 at t=3 (phase=π/2), got ${quarterVal}`
  );
});

test('EVT-RECOVERY-W-3c: W curve returns 1 for negative t (before shock)', () => {
  assert.strictEqual(RecoveryCurves.W(-1, 12), 1.0);
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

test('EVT-RECOVERY-W-4: W-curve shows double-dip impact pattern over full duration', () => {
  const baseRate   = 0.06;
  const adjustment = -0.06;
  // 12-month W-shaped recovery:
  // t=0: factor=1 (full shock)  → effective rate = base + adj = 0
  // t=3: factor=0.5             → effective rate = base + adj*0.5 = 0.03
  // t=6: factor=0 (brief peak)  → effective rate = base = 0.06
  // t=9: factor=0.5 (2nd dip)   → effective rate = base + adj*0.5 = 0.03
  // t=12: factor=0 (end)        → regime dropped
  const shock = {
    shockId: 'shock-w', name: 'W Recovery Test',
    startDate: '2026-02-01',
    regime: { returnAdjustment: { EQUITY_US: adjustment } },
    recovery: { profile: 'W', durationMonths: 12 },
  };
  const { sim } = loadScenario({ rothGrowthRate: baseRate, shocks: [shock] });

  // At t~0: W factor = 1, effective rate = base + adj = 0 (full shock)
  sim.stepTo(new Date('2026-02-15'));
  // Design 90 §7.2 — read the Roth's PER-ACCOUNT key. `rothGrowthRate` is a wrapper
  // rate and now lands on `EQUITY_US::rothAccount`; the bare `EQUITY_US` key carries the
  // MARKET rate (0.07 by default), which is not the baseline these assertions are
  // written against.
  const rateStart = sim.state.effectiveGrowthRates?.['EQUITY_US::rothAccount'] ?? NaN;
  assert.ok(rateStart < 0.02, `Near-start W rate should be near 0, got ${rateStart}`);

  // At t~3 months (quarter, phase=π/2): W factor ≈ 0.5, rate partially recovers
  sim.stepTo(new Date('2026-05-01'));
  const rateQuarter = sim.state.effectiveGrowthRates?.['EQUITY_US::rothAccount'] ?? NaN;
  assert.ok(
    rateQuarter > rateStart,
    `Quarter-point rate (${rateQuarter}) should be > start rate (${rateStart})`
  );

  // At t~6 months (half, phase=π): W factor ≈ 0 (temporary peak), rate near base
  sim.stepTo(new Date('2026-08-01'));
  const rateHalf = sim.state.effectiveGrowthRates?.['EQUITY_US::rothAccount'] ?? NaN;
  assert.ok(
    rateHalf > rateQuarter,
    `Half-point rate (${rateHalf}) should be > quarter-point rate (${rateQuarter}) — brief recovery peak`
  );

  // After full duration: rate returns to base, regime dropped
  sim.stepTo(new Date('2027-04-01'));
  const rateAfter = sim.state.effectiveGrowthRates?.['EQUITY_US::rothAccount'] ?? NaN;
  assert.ok(
    Math.abs(rateAfter - baseRate) < 0.001,
    `Post-recovery rate should return to base ${baseRate}, got ${rateAfter}`
  );
  assert.strictEqual(sim.state.activeRegimes.length, 0, 'W-regime should be dropped after full duration');
});
