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
 * evt-401k-to-ira-conversion.test.mjs
 * Tests for EVT-53: 401(k) → IRA Conversion (direct rollover, no tax, no cash pool).
 *
 * EVT-53  401(k)→IRA Rollover  −401(k), +IRA  No US tax, no AU tax, no penalty
 *
 * Run with: node --test tests/unit/evt-401k-to-ira-conversion.test.mjs
 */

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { ServiceRegistry } from '../../src/services/service-registry.js';
import { ScenarioLoader }  from '../../src/scenarios/scenario-loader.js';
import { BaseScenario }    from '../../src/index.js';

beforeEach(() => ServiceRegistry.resetAll());

function loadToolsetScenario(config) {
  const services = ServiceRegistry.getInstance();
  const scenario = new BaseScenario({
    context:  services.simulationContext,
    simStart: new Date(config.simStart),
    simEnd:   new Date(config.simEnd),
  });
  scenario.buildSim();
  new ScenarioLoader().load(structuredClone(config), services);
  return { scenario, sim: scenario.sim };
}

function makeConfig({
  initialChecking    = 20_000,
  k401Balance        = 100_000,
  k401ContribBasis   = 80_000,
  k401EarningsBasis  = 20_000,
  iraBalance         = 0,
  iraContribBasis    = 0,
  iraEarningsBasis   = 0,
  retirementDate     = '2030-06-15',
  conversionEnabled  = false,
  conversionMonth    = null,
  conversionDay      = null,
  conversionYear     = null,
  includeIra         = true,
  k401GrowthRate     = 0,
  iraGrowthRate      = 0,
} = {}) {
  const accounts = [
    {
      __type: 'SavingsAccount', id: 'checking', name: 'Checking',
      role: 'us-savings', stateKey: 'checkingAccount',
      initialValue: initialChecking, ownershipType: 'sole', ownerId: 'primary',
      minimumBalance: 0, country: 'US', currency: { code: 'USD', symbol: '$' },
    },
    {
      __type: 'FourOhOneKAccount', id: 'k401', name: '401K',
      role: 'k401', stateKey: 'k401Account',
      initialValue: k401Balance, contributionBasis: k401ContribBasis,
      earningsBasis: k401EarningsBasis,
      ownershipType: 'sole', ownerId: 'primary',
      country: 'US', currency: { code: 'USD', symbol: '$' },
    },
  ];
  if (includeIra) {
    accounts.push({
      __type: 'TraditionalIRAAccount', id: 'ira', name: 'IRA',
      role: 'ira', stateKey: 'iraAccount',
      initialValue: iraBalance, contributionBasis: iraContribBasis,
      earningsBasis: iraEarningsBasis,
      ownershipType: 'sole', ownerId: 'primary',
      country: 'US', currency: { code: 'USD', symbol: '$' },
    });
  }
  return {
    toolsets: ['US_RETIREMENT'],
    simStart: '2026-01-01',
    simEnd:   '2032-01-01',
    parameters: {
      monthlyExpenses: 0, inflationAdjust: false, inflationRate: 0,
      rothGrowthRate: 0, iraGrowthRate, k401GrowthRate,
      brokerageGrowthRate: 0, brokerageDividendRate: 0, fixedIncomeInterestRate: 0,
      usSavingsInterestRate: 0,
      k401ToIraConversionEnabled: conversionEnabled,
      k401ToIraConversionMonth:   conversionMonth,
      k401ToIraConversionDay:     conversionDay,
      k401ToIraConversionYear:    conversionYear,
    },
    persons: [{
      __type: 'Person', id: 'primary', name: 'Primary', birthDate: '1966-01-01',
      citizen: ['US'], lifeExpectancy: 90, monthlyWage: 0,
      retirementDate, socialSecurityMonthly: 0,
    }],
    accounts,
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// EVT-53: Core mechanics (manually scheduled event)
// ══════════════════════════════════════════════════════════════════════════════

test('EVT-53: 401(k)→IRA conversion debits 401(k) balance', () => {
  const { sim } = loadToolsetScenario(makeConfig());
  sim.schedule({
    date: new Date(2026, 0, 15),
    type: 'K401_TO_IRA_CONVERSION',
    data: { amount: 30_000, k401Key: 'k401Account', iraKey: 'iraAccount' },
  });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.k401Account.balance, 70_000);
});

test('EVT-53: 401(k)→IRA conversion credits IRA balance', () => {
  const { sim } = loadToolsetScenario(makeConfig());
  sim.schedule({
    date: new Date(2026, 0, 15),
    type: 'K401_TO_IRA_CONVERSION',
    data: { amount: 30_000, k401Key: 'k401Account', iraKey: 'iraAccount' },
  });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.iraAccount.balance, 30_000);
});

test('EVT-53: 401(k)→IRA conversion does NOT flow through cash pool', () => {
  const { sim } = loadToolsetScenario(makeConfig({ initialChecking: 10_000 }));
  sim.schedule({
    date: new Date(2026, 0, 15),
    type: 'K401_TO_IRA_CONVERSION',
    data: { amount: 30_000, k401Key: 'k401Account', iraKey: 'iraAccount' },
  });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.checkingAccount.balance, 10_000);
});

test('EVT-53: 401(k)→IRA conversion records no US ordinary income (pre-tax rollover)', () => {
  const { sim } = loadToolsetScenario(makeConfig());
  sim.schedule({
    date: new Date(2026, 0, 15),
    type: 'K401_TO_IRA_CONVERSION',
    data: { amount: 30_000, k401Key: 'k401Account', iraKey: 'iraAccount' },
  });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.usOrdinaryIncomeYTD, 0);
  assert.strictEqual(sim.state.usPenaltyYTD, 0);
});

test('EVT-53: 401(k)→IRA conversion preserves basis split (contribution first, then earnings)', () => {
  const { sim } = loadToolsetScenario(makeConfig({
    k401Balance: 100_000, k401ContribBasis: 80_000, k401EarningsBasis: 20_000,
  }));
  // Convert 90k → all 80k of contributionBasis + 10k of earningsBasis
  sim.schedule({
    date: new Date(2026, 0, 15),
    type: 'K401_TO_IRA_CONVERSION',
    data: { amount: 90_000, k401Key: 'k401Account', iraKey: 'iraAccount' },
  });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.k401Account.contributionBasis, 0);
  assert.strictEqual(sim.state.k401Account.earningsBasis, 10_000);
  assert.strictEqual(sim.state.iraAccount.contributionBasis, 80_000);
  assert.strictEqual(sim.state.iraAccount.earningsBasis, 10_000);
});

test('EVT-53: 401(k)→IRA conversion with no amount converts entire balance', () => {
  const { sim } = loadToolsetScenario(makeConfig({
    k401Balance: 100_000, k401ContribBasis: 80_000, k401EarningsBasis: 20_000,
  }));
  sim.schedule({
    date: new Date(2026, 0, 15),
    type: 'K401_TO_IRA_CONVERSION',
    data: { k401Key: 'k401Account', iraKey: 'iraAccount' },
  });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.k401Account.balance, 0);
  assert.strictEqual(sim.state.k401Account.contributionBasis, 0);
  assert.strictEqual(sim.state.k401Account.earningsBasis, 0);
  assert.strictEqual(sim.state.iraAccount.balance, 100_000);
  assert.strictEqual(sim.state.iraAccount.contributionBasis, 80_000);
  assert.strictEqual(sim.state.iraAccount.earningsBasis, 20_000);
});

test('EVT-53: 401(k)→IRA conversion throws when amount exceeds 401(k) balance', () => {
  const { sim } = loadToolsetScenario(makeConfig({ k401Balance: 10_000, k401ContribBasis: 10_000, k401EarningsBasis: 0 }));
  sim.schedule({
    date: new Date(2026, 0, 15),
    type: 'K401_TO_IRA_CONVERSION',
    data: { amount: 20_000, k401Key: 'k401Account', iraKey: 'iraAccount' },
  });

  assert.throws(
    () => sim.stepTo(new Date(2026, 0, 31)),
    /K401ToIraConversion: requested 20000 exceeds k401Account balance 10000/
  );
});

// ══════════════════════════════════════════════════════════════════════════════
// Toolset auto-scheduling — uses owner's retirement date by default
// ══════════════════════════════════════════════════════════════════════════════

test('Toolset: auto-schedules conversion on owner retirement date when enabled', () => {
  const { sim } = loadToolsetScenario(makeConfig({
    conversionEnabled: true,
    retirementDate:    '2030-06-15',
  }));

  // Step past retirement date — auto-scheduled event should fire
  sim.stepTo(new Date(2030, 6, 1));

  assert.strictEqual(sim.state.k401Account.balance, 0);
  assert.strictEqual(sim.state.iraAccount.balance, 100_000);
});

test('Toolset: does NOT schedule conversion when k401ToIraConversionEnabled is false', () => {
  const { sim } = loadToolsetScenario(makeConfig({
    conversionEnabled: false,
    retirementDate:    '2030-06-15',
  }));

  sim.stepTo(new Date(2030, 6, 1));

  // 401k still has full balance
  assert.strictEqual(sim.state.k401Account.balance, 100_000);
  assert.strictEqual(sim.state.iraAccount.balance, 0);
});

test('Toolset: does NOT schedule conversion when owner has no IRA', () => {
  const { sim } = loadToolsetScenario(makeConfig({
    conversionEnabled: true,
    retirementDate:    '2030-06-15',
    includeIra:        false,
  }));

  sim.stepTo(new Date(2030, 6, 1));

  // Nothing converted since there is no destination IRA
  assert.strictEqual(sim.state.k401Account.balance, 100_000);
});

test('Toolset: conversion param overrides (year/month/day) replace retirement date', () => {
  const { sim } = loadToolsetScenario(makeConfig({
    conversionEnabled: true,
    retirementDate:    '2030-06-15',
    conversionYear:    2028,
    conversionMonth:   3,
    conversionDay:     10,
  }));

  // Conversion should fire on 2028-03-10 (not 2030-06-15)
  sim.stepTo(new Date(2028, 3, 1));

  assert.strictEqual(sim.state.k401Account.balance, 0);
  assert.strictEqual(sim.state.iraAccount.balance, 100_000);
});

test('Toolset: partial overrides — only month set, year/day default to retirement', () => {
  const { sim } = loadToolsetScenario(makeConfig({
    conversionEnabled: true,
    retirementDate:    '2030-06-15',
    conversionMonth:   12, // December instead of June
  }));

  // Should NOT have fired before December
  sim.stepTo(new Date(2030, 9, 1)); // October
  assert.strictEqual(sim.state.k401Account.balance, 100_000);

  // Should fire on 2030-12-15
  sim.stepTo(new Date(2030, 11, 31));
  assert.strictEqual(sim.state.k401Account.balance, 0);
  assert.strictEqual(sim.state.iraAccount.balance, 100_000);
});

// ══════════════════════════════════════════════════════════════════════════════
// EVT-53: Holdings invariant (§4.4) — balance === Σ holdings[i].marketValue
// ══════════════════════════════════════════════════════════════════════════════

test('EVT-53: full conversion zeroes k401 holdings so no ghost earnings fire', () => {
  const { sim } = loadToolsetScenario(makeConfig({
    k401Balance: 100_000, k401ContribBasis: 80_000, k401EarningsBasis: 20_000,
    k401GrowthRate: 0.07,
  }));
  sim.schedule({
    date: new Date(2026, 0, 15),
    type: 'K401_TO_IRA_CONVERSION',
    data: { k401Key: 'k401Account', iraKey: 'iraAccount' },
  });
  sim.stepTo(new Date(2026, 0, 31));

  // After full conversion the k401 holding must sum to 0 so earnings = 0.
  const k401Holdings = sim.state.k401Account.holdings ?? [];
  const k401HoldingsSum = k401Holdings.reduce((s, h) => s + (h?.marketValue ?? 0), 0);
  assert.strictEqual(k401HoldingsSum, 0,
    'k401 holdings must sum to 0 after full conversion (no ghost earnings)');
});

test('EVT-53: full conversion sets IRA holding to match IRA balance', () => {
  const { sim } = loadToolsetScenario(makeConfig({
    k401Balance: 100_000, k401ContribBasis: 80_000, k401EarningsBasis: 20_000,
    iraBalance: 0,
  }));
  sim.schedule({
    date: new Date(2026, 0, 15),
    type: 'K401_TO_IRA_CONVERSION',
    data: { k401Key: 'k401Account', iraKey: 'iraAccount' },
  });
  sim.stepTo(new Date(2026, 0, 31));

  const iraHoldings = sim.state.iraAccount.holdings ?? [];
  const iraHoldingsSum = iraHoldings.reduce((s, h) => s + (h?.marketValue ?? 0), 0);
  assert.strictEqual(iraHoldingsSum, 100_000,
    'IRA holdings must sum to match IRA balance after rollover');
});

test('EVT-53: k401 earnings stay at 0 after conversion with non-zero growth rate', () => {
  // Regression: ghost k401 holdings caused earnings to compute on stale 250k balance.
  const { sim } = loadToolsetScenario(makeConfig({
    k401Balance:    250_000, k401ContribBasis: 250_000, k401EarningsBasis: 0,
    iraBalance:     0,
    k401GrowthRate: 0.07,
    iraGrowthRate:  0.07,
    conversionEnabled: true,
    conversionYear:  2027, conversionMonth: 1, conversionDay: 1,
  }));

  // Step to just before year-end earnings fire
  sim.stepTo(new Date(2027, 11, 31));

  // 401k must remain at 0, not restore to ~267k via ghost earnings + _syncBalance
  assert.strictEqual(sim.state.k401Account.balance, 0,
    'k401 balance must stay at 0 after conversion even when growth rate > 0');

  // IRA must hold ~267.5k (250k rollover × 1.07 for 2027 earnings)
  assert.ok(sim.state.iraAccount.balance > 250_000,
    'IRA balance must grow past rollover amount due to earnings');
});
