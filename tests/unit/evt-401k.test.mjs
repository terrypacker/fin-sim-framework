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
 * evt-401k.test.mjs
 * Tests for 401K events: EVT-24 and EVT-25
 *
 * EVT-24  401K Contribution  +contribution  out of checking  US: negative income (pre-tax deduction), no AU tax
 * EVT-25  401K Earnings      +earnings      stays in account US: ordinary income (always taxable),
 *                                                              10% penalty if accessed before age 59.5, no AU tax
 *
 * Note: EVT-25 says "stays in account" under earnings, but also lists "10% penalty before min age".
 *       The penalty applies when the earnings are *accessed/withdrawn*, not when they accrue.
 *       These tests model: (a) earnings accrual as non-taxable accumulation, and
 *       (b) a separate WITHDRAWAL event that triggers ordinary income tax + penalty if under 59.5.
 *
 * Run with: node --test tests/evt-401k.test.mjs
 */

import { test, beforeEach } from 'node:test';
import assert   from 'node:assert/strict';

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

function makeK401Config({
  initialChecking   = 20000,
  k401Balance       = 0,
  k401ContribBasis  = 0,
  k401EarningsBasis = 0,
  birthDate         = '1966-01-01',
} = {}) {
  return {
    toolsets: ['US_RETIREMENT'],
    simStart: '2026-01-01',
    simEnd:   '2028-01-01',
    parameters: {
      monthlyExpenses: 0, inflationAdjust: false, inflationRate: 0,
      rothGrowthRate: 0, iraGrowthRate: 0, k401GrowthRate: 0,
      brokerageGrowthRate: 0, brokerageDividendRate: 0, fixedIncomeInterestRate: 0,
      usSavingsInterestRate: 0,
    },
    persons: [{
      __type: 'Person', id: 'primary', name: 'Primary', birthDate,
      citizen: ['US'], lifeExpectancy: 90, monthlyWage: 0,
      retirementDate: '2025-01-01', socialSecurityMonthly: 0,
    }],
    accounts: [
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
    ],
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// EVT-24: 401K Contribution
// ══════════════════════════════════════════════════════════════════════════════

test('EVT-24: 401K contribution increases k401Account balance and contributionBasis', () => {
  const { sim } = loadToolsetScenario(makeK401Config({ initialChecking: 10000 }));
  sim.schedule({ date: new Date(2026, 0, 15), type: 'K401_CONTRIBUTION', data: { amount: 7000 } });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.k401Account.balance, 7000);
  assert.strictEqual(sim.state.k401Account.contributionBasis, 7000);
  assert.strictEqual(sim.state.k401Account.earningsBasis, 0);
});

test('EVT-24: 401K contribution debits checking account', () => {
  const { sim } = loadToolsetScenario(makeK401Config({ initialChecking: 10000 }));
  sim.schedule({ date: new Date(2026, 0, 15), type: 'K401_CONTRIBUTION', data: { amount: 7000 } });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.checkingAccount.balance, 3000);
});

test('EVT-24: 401K contribution is a US negative income (deduction) event', () => {
  const { sim } = loadToolsetScenario(makeK401Config({ initialChecking: 10000 }));
  sim.schedule({ date: new Date(2026, 0, 15), type: 'K401_CONTRIBUTION', data: { amount: 7000 } });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.usNegativeIncomeYTD, 7000);
  assert.strictEqual(sim.state.usOrdinaryIncomeYTD, 0);
});

// ══════════════════════════════════════════════════════════════════════════════
// EVT-25: 401K Earnings (accrual)
// ══════════════════════════════════════════════════════════════════════════════

test('EVT-25: 401K earnings increase k401Account balance and earningsBasis', () => {
  const { sim } = loadToolsetScenario(makeK401Config({ k401Balance: 50000, k401ContribBasis: 50000 }));
  sim.schedule({ date: new Date(2026, 0, 15), type: 'K401_EARNINGS', data: { amount: 4000 } });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.k401Account.balance, 54000);
  assert.strictEqual(sim.state.k401Account.earningsBasis, 4000);
  assert.strictEqual(sim.state.k401Account.contributionBasis, 50000); // unchanged
});

test('EVT-25: 401K earnings stay in account — no checking transaction', () => {
  const { sim } = loadToolsetScenario(makeK401Config({ initialChecking: 5000, k401Balance: 50000, k401ContribBasis: 50000 }));
  sim.schedule({ date: new Date(2026, 0, 15), type: 'K401_EARNINGS', data: { amount: 4000 } });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.checkingAccount.balance, 5000);
});

// ══════════════════════════════════════════════════════════════════════════════
// EVT-25: 401K Withdrawal (age-gated access to earnings)
// ══════════════════════════════════════════════════════════════════════════════

test('EVT-25: 401K withdrawal at age 59.5+ has no penalty and is US ordinary income taxable', () => {
  // Born 1966-07-01: turns 59.5 on 2026-01-01, so is 60 by the July 1 withdrawal date
  const { sim } = loadToolsetScenario(makeK401Config({
    initialChecking: 5000,
    k401Balance: 50000,
    k401EarningsBasis: 50000,
    birthDate: '1966-07-01',
  }));
  sim.schedule({ date: new Date(2026, 6, 1), type: 'K401_WITHDRAWAL', data: { amount: 10000 } });
  sim.stepTo(new Date(2026, 6, 30));

  assert.strictEqual(sim.state.usPenaltyYTD, 0);
  assert.strictEqual(sim.state.usOrdinaryIncomeYTD, 10000);
  assert.strictEqual(sim.state.checkingAccount.balance, 15000);
});

test('EVT-25: 401K withdrawal before age 59.5 incurs 10% penalty', () => {
  const { sim } = loadToolsetScenario(makeK401Config({
    initialChecking: 5000,
    k401Balance: 50000,
    k401EarningsBasis: 50000,
    birthDate: '1990-01-01',
  }));
  sim.schedule({ date: new Date(2026, 0, 15), type: 'K401_WITHDRAWAL', data: { amount: 10000 } });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.usPenaltyYTD, 1000);           // 10% of 10000
  assert.strictEqual(sim.state.usOrdinaryIncomeYTD, 10000);   // full amount still taxable
  assert.strictEqual(sim.state.checkingAccount.balance, 14000); // 5000 + 9000 net
});

test('EVT-25: 401K withdrawal is always US ordinary income taxable (no AU tax)', () => {
  const { sim } = loadToolsetScenario(makeK401Config({
    initialChecking: 5000,
    k401Balance: 50000,
    k401EarningsBasis: 50000,
    birthDate: '1966-01-01',
  }));
  sim.schedule({ date: new Date(2026, 1, 1), type: 'K401_WITHDRAWAL', data: { amount: 10000 } });
  sim.stepTo(new Date(2026, 1, 28));

  assert.strictEqual(sim.state.usOrdinaryIncomeYTD, 10000);
  // 401K withdrawals are US-only taxable events per requirements
});
