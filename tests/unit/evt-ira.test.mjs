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
 * evt-ira.test.mjs
 * Tests for Traditional IRA events: EVT-5 through EVT-8, EVT-35, EVT-40
 *
 * EVT-5  IRA Contribution             +contribution  out of checking  US: negative income (deduction), no AU tax
 * EVT-6  IRA Withdrawal-Contributions -contribution  into checking    age 60 gate, 10% penalty before 60,
 *                                                                       US: ordinary income, no AU tax
 * EVT-7  IRA Withdrawal-Earnings      -earnings      into checking    age 60 gate, 10% penalty before 60,
 *                                                                       US: ordinary income, AU: ordinary if resident, FTC
 * EVT-8  IRA Earnings                 +earnings      stays in account no tax
 * EVT-35 IRA Rollover Withdrawal     −contrib+earn  into checking    US: ordinary income, no penalty, AU: ordinary if resident
 * EVT-40 IRA RMD                     −contrib+earn  into checking    US: ordinary income (required at 72), AU: ordinary if resident
 *
 * Run with: node --test tests/evt-ira.test.mjs
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

/**
 * Build an IRA scenario config.
 * Uses US_RETIREMENT + AU_RETIREMENT + US_AU_CROSS_BORDER so that both US and AU
 * YTD counters are always in state.
 */
function makeIraConfig({
  initialChecking  = 20000,
  initialAuSavings = 50000,
  iraBalance       = 0,
  iraContribBasis  = 0,
  iraEarningsBasis = 0,
  birthDate        = '1966-01-01',
  startingResidency = 'US',
} = {}) {
  return {
    toolsets: ['US_RETIREMENT', 'AU_RETIREMENT', 'US_AU_CROSS_BORDER'],
    simStart: '2026-01-01',
    simEnd:   '2028-01-01',
    parameters: {
      monthlyExpenses: 0, inflationAdjust: false, inflationRate: 0,
      rothGrowthRate: 0, iraGrowthRate: 0, k401GrowthRate: 0,
      brokerageGrowthRate: 0, brokerageDividendRate: 0, fixedIncomeInterestRate: 0,
      usSavingsInterestRate: 0, auSavingsInterestRate: 0,
      superGrowthRate: 0, auStockGrowthRate: 0, auStockDividendRate: 0,
      startingResidency,
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
        __type: 'SavingsAccount', id: 'au-savings', name: 'AU Savings',
        role: 'au-savings', stateKey: 'auSavingsAccount',
        initialValue: initialAuSavings, ownershipType: 'sole', ownerId: 'primary',
        minimumBalance: 0, country: 'AU', currency: { code: 'AUD', symbol: '$' },
      },
      {
        __type: 'TraditionalIRAAccount', id: 'ira', name: 'Traditional IRA',
        role: 'ira', stateKey: 'iraAccount',
        initialValue: iraBalance, contributionBasis: iraContribBasis,
        earningsBasis: iraEarningsBasis,
        ownershipType: 'sole', ownerId: 'primary',
        country: 'US', currency: { code: 'USD', symbol: '$' },
      },
    ],
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// EVT-5: IRA Contribution
// ══════════════════════════════════════════════════════════════════════════════

test('EVT-5: IRA contribution increases iraAccount balance and contributionBasis', () => {
  const { sim } = loadToolsetScenario(makeIraConfig({ initialChecking: 10000 }));
  sim.schedule({ date: new Date(2026, 0, 15), type: 'IRA_CONTRIBUTION', data: { amount: 6500 } });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.iraAccount.balance, 6500);
  assert.strictEqual(sim.state.iraAccount.contributionBasis, 6500);
  assert.strictEqual(sim.state.iraAccount.earningsBasis, 0);
});

test('EVT-5: IRA contribution debits checking account', () => {
  const { sim } = loadToolsetScenario(makeIraConfig({ initialChecking: 10000 }));
  sim.schedule({ date: new Date(2026, 0, 15), type: 'IRA_CONTRIBUTION', data: { amount: 6500 } });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.checkingAccount.balance, 3500);
});

test('EVT-5: IRA contribution is a US negative income (deduction) event', () => {
  const { sim } = loadToolsetScenario(makeIraConfig({ initialChecking: 10000 }));
  sim.schedule({ date: new Date(2026, 0, 15), type: 'IRA_CONTRIBUTION', data: { amount: 6500 } });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.usNegativeIncomeYTD, 6500);
  assert.strictEqual(sim.state.usOrdinaryIncomeYTD, 0);
});

test('EVT-5: IRA contribution is not an AU taxable event', () => {
  const { sim } = loadToolsetScenario(makeIraConfig({ initialChecking: 10000, startingResidency: 'AU' }));
  sim.schedule({ date: new Date(2026, 0, 15), type: 'IRA_CONTRIBUTION', data: { amount: 6500 } });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.auOrdinaryIncomeYTD, 0);
});

// ══════════════════════════════════════════════════════════════════════════════
// EVT-6: IRA Withdrawal — Contributions
// ══════════════════════════════════════════════════════════════════════════════

test('EVT-6: IRA contribution withdrawal at age 60+ has no penalty', () => {
  const { sim } = loadToolsetScenario(makeIraConfig({
    initialChecking: 5000,
    iraBalance: 20000,
    iraContribBasis: 20000,
    birthDate: '1966-01-01', // turns 60 in 2026
  }));
  sim.schedule({ date: new Date(2026, 1, 1), type: 'IRA_WITHDRAWAL_CONTRIBUTIONS', data: { amount: 5000 } });
  sim.stepTo(new Date(2026, 1, 28));

  assert.strictEqual(sim.state.usPenaltyYTD, 0);
  assert.strictEqual(sim.state.checkingAccount.balance, 10000);
});

test('EVT-6: IRA contribution withdrawal before age 60 incurs 10% penalty', () => {
  const { sim } = loadToolsetScenario(makeIraConfig({
    initialChecking: 5000,
    iraBalance: 20000,
    iraContribBasis: 20000,
    birthDate: '1990-01-01', // age 36 in 2026
  }));
  sim.schedule({ date: new Date(2026, 0, 15), type: 'IRA_WITHDRAWAL_CONTRIBUTIONS', data: { amount: 5000 } });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.usPenaltyYTD, 500); // 10% of 5000
  assert.strictEqual(sim.state.checkingAccount.balance, 9500); // 5000 + 4500 net
});

test('EVT-6: IRA contribution withdrawal is US ordinary income taxable', () => {
  const { sim } = loadToolsetScenario(makeIraConfig({
    initialChecking: 5000,
    iraBalance: 20000,
    iraContribBasis: 20000,
    birthDate: '1966-01-01',
  }));
  sim.schedule({ date: new Date(2026, 1, 1), type: 'IRA_WITHDRAWAL_CONTRIBUTIONS', data: { amount: 5000 } });
  sim.stepTo(new Date(2026, 1, 28));

  assert.strictEqual(sim.state.usOrdinaryIncomeYTD, 5000);
});

test('EVT-6: IRA contribution withdrawal is not AU taxable', () => {
  const { sim } = loadToolsetScenario(makeIraConfig({
    initialChecking: 5000,
    iraBalance: 20000,
    iraContribBasis: 20000,
    startingResidency: 'AU',
    birthDate: '1966-01-01',
  }));
  sim.schedule({ date: new Date(2026, 1, 1), type: 'IRA_WITHDRAWAL_CONTRIBUTIONS', data: { amount: 5000 } });
  sim.stepTo(new Date(2026, 1, 28));

  assert.strictEqual(sim.state.auOrdinaryIncomeYTD, 0);
});

// ══════════════════════════════════════════════════════════════════════════════
// EVT-7: IRA Withdrawal — Earnings
// ══════════════════════════════════════════════════════════════════════════════

test('EVT-7: IRA earnings withdrawal at age 60+ has no penalty', () => {
  const { sim } = loadToolsetScenario(makeIraConfig({
    initialChecking: 5000,
    iraBalance: 20000,
    iraEarningsBasis: 20000,
    birthDate: '1966-01-01',
  }));
  sim.schedule({ date: new Date(2026, 1, 1), type: 'IRA_WITHDRAWAL_EARNINGS', data: { amount: 5000 } });
  sim.stepTo(new Date(2026, 1, 28));

  assert.strictEqual(sim.state.usPenaltyYTD, 0);
  assert.strictEqual(sim.state.checkingAccount.balance, 10000);
});

test('EVT-7: IRA earnings withdrawal before age 60 incurs 10% penalty', () => {
  const { sim } = loadToolsetScenario(makeIraConfig({
    initialChecking: 5000,
    iraBalance: 20000,
    iraEarningsBasis: 20000,
    birthDate: '1990-01-01',
  }));
  sim.schedule({ date: new Date(2026, 0, 15), type: 'IRA_WITHDRAWAL_EARNINGS', data: { amount: 5000 } });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.usPenaltyYTD, 500);
});

test('EVT-7: IRA earnings withdrawal is US ordinary income taxable', () => {
  const { sim } = loadToolsetScenario(makeIraConfig({
    initialChecking: 5000,
    iraBalance: 20000,
    iraEarningsBasis: 20000,
    birthDate: '1966-01-01',
  }));
  sim.schedule({ date: new Date(2026, 1, 1), type: 'IRA_WITHDRAWAL_EARNINGS', data: { amount: 5000 } });
  sim.stepTo(new Date(2026, 1, 28));

  assert.strictEqual(sim.state.usOrdinaryIncomeYTD, 5000);
});

test('EVT-7: IRA earnings withdrawal IS AU taxable if person is AU resident', () => {
  const { sim } = loadToolsetScenario(makeIraConfig({
    initialChecking: 5000,
    iraBalance: 20000,
    iraEarningsBasis: 20000,
    birthDate: '1966-01-01',
    startingResidency: 'AU',
  }));
  sim.schedule({ date: new Date(2026, 1, 1), type: 'IRA_WITHDRAWAL_EARNINGS', data: { amount: 5000 } });
  sim.stepTo(new Date(2026, 1, 28));

  assert.strictEqual(sim.state.auOrdinaryIncomeYTD, 5000);
  assert.ok(sim.state.ftcYTD > 0, 'FTC should be recorded when AU tax applies');
});

test('EVT-7: IRA earnings withdrawal is NOT AU taxable if person is not AU resident', () => {
  const { sim } = loadToolsetScenario(makeIraConfig({
    initialChecking: 5000,
    iraBalance: 20000,
    iraEarningsBasis: 20000,
    birthDate: '1966-01-01',
    startingResidency: 'US',
  }));
  sim.schedule({ date: new Date(2026, 1, 1), type: 'IRA_WITHDRAWAL_EARNINGS', data: { amount: 5000 } });
  sim.stepTo(new Date(2026, 1, 28));

  assert.strictEqual(sim.state.auOrdinaryIncomeYTD, 0);
  assert.strictEqual(sim.state.ftcYTD, 0);
});

// ══════════════════════════════════════════════════════════════════════════════
// EVT-8: IRA Earnings
// ══════════════════════════════════════════════════════════════════════════════

test('EVT-8: IRA earnings increase iraAccount balance and earningsBasis', () => {
  const { sim } = loadToolsetScenario(makeIraConfig({ iraBalance: 50000, iraContribBasis: 50000 }));
  sim.schedule({ date: new Date(2026, 0, 15), type: 'IRA_EARNINGS', data: { amount: 3000 } });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.iraAccount.balance, 53000);
  assert.strictEqual(sim.state.iraAccount.earningsBasis, 3000);
  assert.strictEqual(sim.state.iraAccount.contributionBasis, 50000); // unchanged
});

test('EVT-8: IRA earnings stay in account — no checking transaction', () => {
  const { sim } = loadToolsetScenario(makeIraConfig({ initialChecking: 5000, iraBalance: 50000, iraContribBasis: 50000 }));
  sim.schedule({ date: new Date(2026, 0, 15), type: 'IRA_EARNINGS', data: { amount: 3000 } });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.checkingAccount.balance, 5000);
});

test('EVT-8: IRA earnings are not a US or AU taxable event', () => {
  const { sim } = loadToolsetScenario(makeIraConfig({
    iraBalance: 50000,
    iraContribBasis: 50000,
    startingResidency: 'AU',
  }));
  sim.schedule({ date: new Date(2026, 0, 15), type: 'IRA_EARNINGS', data: { amount: 3000 } });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.usOrdinaryIncomeYTD, 0);
  assert.strictEqual(sim.state.auOrdinaryIncomeYTD, 0);
});

// ══════════════════════════════════════════════════════════════════════════════
// EVT-35: IRA Rollover Withdrawal
// ══════════════════════════════════════════════════════════════════════════════

test('EVT-35: IRA rollover withdrawal credits checking account', () => {
  const { sim } = loadToolsetScenario(makeIraConfig({
    initialChecking: 5000,
    iraBalance: 20000,
    iraContribBasis: 20000,
  }));
  sim.schedule({ date: new Date(2026, 1, 1), type: 'IRA_ROLLOVER_WITHDRAWAL', data: { amount: 8000 } });
  sim.stepTo(new Date(2026, 1, 28));

  assert.strictEqual(sim.state.checkingAccount.balance, 13000); // 5000 + 8000
});

test('EVT-35: IRA rollover withdrawal debits IRA balance', () => {
  const { sim } = loadToolsetScenario(makeIraConfig({
    iraBalance: 20000,
    iraContribBasis: 15000,
    iraEarningsBasis: 5000,
  }));
  sim.schedule({ date: new Date(2026, 1, 1), type: 'IRA_ROLLOVER_WITHDRAWAL', data: { amount: 8000 } });
  sim.stepTo(new Date(2026, 1, 28));

  assert.strictEqual(sim.state.iraAccount.balance, 12000);
});

test('EVT-35: IRA rollover withdrawal is US ordinary income', () => {
  const { sim } = loadToolsetScenario(makeIraConfig({
    iraBalance: 20000,
    iraContribBasis: 20000,
  }));
  sim.schedule({ date: new Date(2026, 1, 1), type: 'IRA_ROLLOVER_WITHDRAWAL', data: { amount: 8000 } });
  sim.stepTo(new Date(2026, 1, 28));

  assert.strictEqual(sim.state.usOrdinaryIncomeYTD, 8000);
});

test('EVT-35: IRA rollover withdrawal has NO penalty even when person is under 60', () => {
  const { sim } = loadToolsetScenario(makeIraConfig({
    iraBalance: 20000,
    iraContribBasis: 20000,
    birthDate: '1990-01-01', // age 36 in 2026
  }));
  sim.schedule({ date: new Date(2026, 1, 1), type: 'IRA_ROLLOVER_WITHDRAWAL', data: { amount: 8000 } });
  sim.stepTo(new Date(2026, 1, 28));

  assert.strictEqual(sim.state.usPenaltyYTD, 0);
});

test('EVT-35: IRA rollover withdrawal is AU ordinary income if AU resident', () => {
  const { sim } = loadToolsetScenario(makeIraConfig({
    iraBalance: 20000,
    iraContribBasis: 20000,
    startingResidency: 'AU',
  }));
  sim.schedule({ date: new Date(2026, 1, 1), type: 'IRA_ROLLOVER_WITHDRAWAL', data: { amount: 8000 } });
  sim.stepTo(new Date(2026, 1, 28));

  assert.strictEqual(sim.state.auOrdinaryIncomeYTD, 8000);
  assert.ok(sim.state.ftcYTD > 0, 'FTC should be recorded for AU resident');
});

test('EVT-35: IRA rollover withdrawal is not AU taxable if not AU resident', () => {
  const { sim } = loadToolsetScenario(makeIraConfig({
    iraBalance: 20000,
    iraContribBasis: 20000,
    startingResidency: 'US',
  }));
  sim.schedule({ date: new Date(2026, 1, 1), type: 'IRA_ROLLOVER_WITHDRAWAL', data: { amount: 8000 } });
  sim.stepTo(new Date(2026, 1, 28));

  assert.strictEqual(sim.state.auOrdinaryIncomeYTD, 0);
  assert.strictEqual(sim.state.ftcYTD, 0);
});

// ══════════════════════════════════════════════════════════════════════════════
// EVT-40: IRA RMD (Required Minimum Distribution)
// ══════════════════════════════════════════════════════════════════════════════

test('EVT-40: IRA RMD credits checking account', () => {
  const { sim } = loadToolsetScenario(makeIraConfig({
    initialChecking: 3000,
    iraBalance: 500000,
    iraContribBasis: 300000,
    iraEarningsBasis: 200000,
    birthDate: '1954-01-01', // age 72 in 2026
  }));
  sim.schedule({ date: new Date(2026, 1, 1), type: 'IRA_RMD', data: { amount: 20000 } });
  sim.stepTo(new Date(2026, 1, 28));

  assert.strictEqual(sim.state.checkingAccount.balance, 23000); // 3000 + 20000
});

test('EVT-40: IRA RMD debits IRA balance', () => {
  const { sim } = loadToolsetScenario(makeIraConfig({
    iraBalance: 500000,
    iraContribBasis: 300000,
    iraEarningsBasis: 200000,
    birthDate: '1954-01-01',
  }));
  sim.schedule({ date: new Date(2026, 1, 1), type: 'IRA_RMD', data: { amount: 20000 } });
  sim.stepTo(new Date(2026, 1, 28));

  assert.strictEqual(sim.state.iraAccount.balance, 480000);
});

test('EVT-40: IRA RMD is US ordinary income', () => {
  const { sim } = loadToolsetScenario(makeIraConfig({
    iraBalance: 500000,
    iraContribBasis: 500000,
    birthDate: '1954-01-01',
  }));
  sim.schedule({ date: new Date(2026, 1, 1), type: 'IRA_RMD', data: { amount: 20000 } });
  sim.stepTo(new Date(2026, 1, 28));

  assert.strictEqual(sim.state.usOrdinaryIncomeYTD, 20000);
  assert.strictEqual(sim.state.usPenaltyYTD, 0);
});

test('EVT-40: IRA RMD is AU ordinary income if AU resident', () => {
  const { sim } = loadToolsetScenario(makeIraConfig({
    iraBalance: 500000,
    iraContribBasis: 500000,
    birthDate: '1954-01-01',
    startingResidency: 'AU',
  }));
  sim.schedule({ date: new Date(2026, 1, 1), type: 'IRA_RMD', data: { amount: 20000 } });
  sim.stepTo(new Date(2026, 1, 28));

  assert.strictEqual(sim.state.auOrdinaryIncomeYTD, 20000);
  assert.ok(sim.state.ftcYTD > 0, 'FTC should be recorded for AU resident');
});
