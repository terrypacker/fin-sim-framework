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
 * evt-roth.test.mjs
 * Tests for Roth IRA events: EVT-1 through EVT-4, EVT-41 through EVT-44
 *
 * EVT-1  Roth Contribution             +contribution  out of checking  no tax
 * EVT-2  Roth Withdrawal-Contributions -contribution  into checking    no tax, no age gate
 * EVT-3  Roth Withdrawal-Earnings      -earnings      into checking    age 59.5 gate, 10% penalty before 59.5,
 *                                                                       no US income tax, AU ordinary income if resident, FTC
 * EVT-4  Roth Earnings                 +earnings      stays in account no tax
 *
 * Run with: node --test tests/evt-roth.test.mjs
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
 * Build a Roth scenario config.
 * Uses US_RETIREMENT + AU_RETIREMENT + US_AU_CROSS_BORDER so that both US and AU
 * YTD counters are always in state (needed for assertions like auOrdinaryIncomeYTD === 0).
 * isAuResident is controlled via the US_AU_CROSS_BORDER parameter.
 */
function makeRothConfig({
  initialChecking       = 20000,
  initialAuSavings      = 50000,
  rothBalance           = 0,
  rothContribBasis      = 0,
  rothEarningsBasis     = 0,
  rolloverContribBasis  = 0,
  rolloverEarningsBasis = 0,
  birthDate             = '1966-01-01',
  startingResidency     = 'US',
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
        __type: 'RothAccount', id: 'roth', name: 'Roth IRA',
        role: 'roth-ira', stateKey: 'rothAccount',
        initialValue: rothBalance, contributionBasis: rothContribBasis,
        earningsBasis: rothEarningsBasis,
        rolloverContribBasis, rolloverEarningsBasis,
        ownershipType: 'sole', ownerId: 'primary',
        country: 'US', currency: { code: 'USD', symbol: '$' },
      },
    ],
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// EVT-1: Roth Contribution
// ══════════════════════════════════════════════════════════════════════════════

test('EVT-1: Roth contribution increases rothAccount balance and contributionBasis', () => {
  const { sim } = loadToolsetScenario(makeRothConfig({ initialChecking: 10000 }));
  sim.schedule({ date: new Date(2026, 0, 15), type: 'ROTH_CONTRIBUTION', data: { amount: 5000 } });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.rothAccount.balance, 5000);
  assert.strictEqual(sim.state.rothAccount.contributionBasis, 5000);
  assert.strictEqual(sim.state.rothAccount.earningsBasis, 0);
});

test('EVT-1: Roth contribution debits checking account', () => {
  const { sim } = loadToolsetScenario(makeRothConfig({ initialChecking: 10000 }));
  sim.schedule({ date: new Date(2026, 0, 15), type: 'ROTH_CONTRIBUTION', data: { amount: 5000 } });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.checkingAccount.balance, 5000);
});

test('EVT-1: Roth contribution is not a US or AU taxable event', () => {
  const { sim } = loadToolsetScenario(makeRothConfig({ initialChecking: 10000, startingResidency: 'AU' }));
  sim.schedule({ date: new Date(2026, 0, 15), type: 'ROTH_CONTRIBUTION', data: { amount: 5000 } });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.usOrdinaryIncomeYTD, 0);
  assert.strictEqual(sim.state.usNegativeIncomeYTD, 0);
  assert.strictEqual(sim.state.auOrdinaryIncomeYTD, 0);
});

// ══════════════════════════════════════════════════════════════════════════════
// EVT-2: Roth Withdrawal — Contributions
// ══════════════════════════════════════════════════════════════════════════════

test('EVT-2: Roth contribution withdrawal credits checking and reduces contributionBasis', () => {
  const { sim } = loadToolsetScenario(makeRothConfig({
    initialChecking: 5000,
    rothBalance: 10000,
    rothContribBasis: 10000,
  }));
  sim.schedule({ date: new Date(2026, 0, 15), type: 'ROTH_WITHDRAWAL_CONTRIBUTIONS', data: { amount: 3000 } });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.checkingAccount.balance, 8000);
  assert.strictEqual(sim.state.rothAccount.balance, 7000);
  assert.strictEqual(sim.state.rothAccount.contributionBasis, 7000);
});

test('EVT-2: Roth contribution withdrawal has no age restriction (person under 59.5)', () => {
  // Person born 1990 — only 36 years old in 2026
  const { sim } = loadToolsetScenario(makeRothConfig({
    initialChecking: 5000,
    rothBalance: 10000,
    rothContribBasis: 10000,
    birthDate: '1990-01-01',
  }));
  sim.schedule({ date: new Date(2026, 0, 15), type: 'ROTH_WITHDRAWAL_CONTRIBUTIONS', data: { amount: 3000 } });
  sim.stepTo(new Date(2026, 0, 31));

  // No penalty — contributions can always be withdrawn
  assert.strictEqual(sim.state.checkingAccount.balance, 8000);
  assert.strictEqual(sim.state.usPenaltyYTD, 0);
});

test('EVT-2: Roth contribution withdrawal is not a US or AU taxable event', () => {
  const { sim } = loadToolsetScenario(makeRothConfig({
    initialChecking: 5000,
    rothBalance: 10000,
    rothContribBasis: 10000,
    startingResidency: 'AU',
  }));
  sim.schedule({ date: new Date(2026, 0, 15), type: 'ROTH_WITHDRAWAL_CONTRIBUTIONS', data: { amount: 3000 } });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.usOrdinaryIncomeYTD, 0);
  assert.strictEqual(sim.state.auOrdinaryIncomeYTD, 0);
  assert.strictEqual(sim.state.usPenaltyYTD, 0);
});

// ══════════════════════════════════════════════════════════════════════════════
// EVT-3: Roth Withdrawal — Earnings
// ══════════════════════════════════════════════════════════════════════════════

test('EVT-3: Roth earnings withdrawal at age 59.5+ has no penalty', () => {
  // personBirthDate = 1966-01-01, event date = 2026-02-01 → age 60 (>= 59.5)
  const { sim } = loadToolsetScenario(makeRothConfig({
    initialChecking: 5000,
    rothBalance: 10000,
    rothEarningsBasis: 10000,
    birthDate: '1966-01-01',
  }));
  sim.schedule({ date: new Date(2026, 1, 1), type: 'ROTH_WITHDRAWAL_EARNINGS', data: { amount: 4000 } });
  sim.stepTo(new Date(2026, 1, 28));

  assert.strictEqual(sim.state.usPenaltyYTD, 0);
  assert.strictEqual(sim.state.checkingAccount.balance, 9000); // 5000 + 4000
  assert.strictEqual(sim.state.rothAccount.balance, 6000);
});

test('EVT-3: Roth earnings withdrawal before age 59.5 incurs 10% penalty', () => {
  // Person born 1990 — age 36 in 2026
  const { sim } = loadToolsetScenario(makeRothConfig({
    initialChecking: 5000,
    rothBalance: 10000,
    rothEarningsBasis: 10000,
    birthDate: '1990-01-01',
  }));
  sim.schedule({ date: new Date(2026, 0, 15), type: 'ROTH_WITHDRAWAL_EARNINGS', data: { amount: 4000 } });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.usPenaltyYTD, 400);       // 10% of 4000
  assert.strictEqual(sim.state.checkingAccount.balance, 8600); // 5000 + 3600 net
});

test('EVT-3: Roth earnings withdrawal at exactly age 59.5 has no penalty', () => {
  // Born 1966-07-01: decimal age on 2026-01-01 ≈ 59.50 (>= 59.5 → no penalty)
  const { sim } = loadToolsetScenario(makeRothConfig({
    initialChecking: 5000,
    rothBalance: 10000,
    rothEarningsBasis: 10000,
    birthDate: '1966-07-01',
  }));
  sim.schedule({ date: new Date(2026, 0, 15), type: 'ROTH_WITHDRAWAL_EARNINGS', data: { amount: 4000 } });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.usPenaltyYTD, 0);
  assert.strictEqual(sim.state.checkingAccount.balance, 9000); // full amount credited
});

test('EVT-3: Roth earnings withdrawal just before age 59.5 incurs 10% penalty', () => {
  // Born 1966-08-01: decimal age on 2026-01-01 ≈ 59.42 (< 59.5 → penalty)
  const { sim } = loadToolsetScenario(makeRothConfig({
    initialChecking: 5000,
    rothBalance: 10000,
    rothEarningsBasis: 10000,
    birthDate: '1966-08-01',
  }));
  sim.schedule({ date: new Date(2026, 0, 15), type: 'ROTH_WITHDRAWAL_EARNINGS', data: { amount: 4000 } });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.usPenaltyYTD, 400);        // 10% of 4000
  assert.strictEqual(sim.state.checkingAccount.balance, 8600); // 5000 + 3600 net
});

test('EVT-3: Roth earnings withdrawal is NOT a US ordinary income taxable event', () => {
  const { sim } = loadToolsetScenario(makeRothConfig({
    initialChecking: 5000,
    rothBalance: 10000,
    rothEarningsBasis: 10000,
    birthDate: '1966-01-01',
  }));
  sim.schedule({ date: new Date(2026, 1, 1), type: 'ROTH_WITHDRAWAL_EARNINGS', data: { amount: 4000 } });
  sim.stepTo(new Date(2026, 1, 28));

  assert.strictEqual(sim.state.usOrdinaryIncomeYTD, 0);
});

test('EVT-3: Roth earnings withdrawal IS AU taxable if person is AU resident', () => {
  const { sim } = loadToolsetScenario(makeRothConfig({
    initialChecking: 5000,
    rothBalance: 10000,
    rothEarningsBasis: 10000,
    birthDate: '1966-01-01',
    startingResidency: 'AU',
  }));
  sim.schedule({ date: new Date(2026, 1, 1), type: 'ROTH_WITHDRAWAL_EARNINGS', data: { amount: 4000 } });
  sim.stepTo(new Date(2026, 1, 28));

  assert.strictEqual(sim.state.auOrdinaryIncomeYTD, 4000);
  assert.ok(sim.state.ftcYTD > 0, 'FTC should be recorded when AU tax applies');
});

test('EVT-3: Roth earnings withdrawal is NOT AU taxable if person is NOT AU resident', () => {
  const { sim } = loadToolsetScenario(makeRothConfig({
    initialChecking: 5000,
    rothBalance: 10000,
    rothEarningsBasis: 10000,
    birthDate: '1966-01-01',
    startingResidency: 'US',
  }));
  sim.schedule({ date: new Date(2026, 1, 1), type: 'ROTH_WITHDRAWAL_EARNINGS', data: { amount: 4000 } });
  sim.stepTo(new Date(2026, 1, 28));

  assert.strictEqual(sim.state.auOrdinaryIncomeYTD, 0);
  assert.strictEqual(sim.state.ftcYTD, 0);
});

// ══════════════════════════════════════════════════════════════════════════════
// EVT-4: Roth Earnings
// ══════════════════════════════════════════════════════════════════════════════

test('EVT-4: Roth earnings increase rothAccount balance and earningsBasis', () => {
  const { sim } = loadToolsetScenario(makeRothConfig({
    rothBalance: 10000,
    rothContribBasis: 10000,
  }));
  sim.schedule({ date: new Date(2026, 0, 15), type: 'ROTH_EARNINGS', data: { amount: 800 } });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.rothAccount.balance, 10800);
  assert.strictEqual(sim.state.rothAccount.earningsBasis, 800);
  assert.strictEqual(sim.state.rothAccount.contributionBasis, 10000); // unchanged
});

test('EVT-4: Roth earnings stay in account — no checking transaction', () => {
  const { sim } = loadToolsetScenario(makeRothConfig({
    initialChecking: 5000,
    rothBalance: 10000,
    rothContribBasis: 10000,
  }));
  sim.schedule({ date: new Date(2026, 0, 15), type: 'ROTH_EARNINGS', data: { amount: 800 } });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.checkingAccount.balance, 5000); // unchanged
});

test('EVT-4: Roth earnings are not a US or AU taxable event', () => {
  const { sim } = loadToolsetScenario(makeRothConfig({
    rothBalance: 10000,
    rothContribBasis: 10000,
    startingResidency: 'AU',
  }));
  sim.schedule({ date: new Date(2026, 0, 15), type: 'ROTH_EARNINGS', data: { amount: 800 } });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.usOrdinaryIncomeYTD, 0);
  assert.strictEqual(sim.state.auOrdinaryIncomeYTD, 0);
});

// ══════════════════════════════════════════════════════════════════════════════
// EVT-41: Roth Rollover Contribution
// ══════════════════════════════════════════════════════════════════════════════

test('EVT-41: Roth rollover contribution increases balance and rolloverContribBasis', () => {
  const { sim } = loadToolsetScenario(makeRothConfig({ initialChecking: 20000 }));
  sim.schedule({ date: new Date(2026, 0, 15), type: 'ROTH_ROLLOVER_CONTRIBUTION', data: { amount: 10000 } });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.rothAccount.balance, 10000);
  assert.strictEqual(sim.state.rothAccount.rolloverContribBasis, 10000);
  assert.strictEqual(sim.state.rothAccount.contributionBasis, 0); // regular basis unaffected
});

test('EVT-41: Roth rollover contribution debits checking account', () => {
  const { sim } = loadToolsetScenario(makeRothConfig({ initialChecking: 20000 }));
  sim.schedule({ date: new Date(2026, 0, 15), type: 'ROTH_ROLLOVER_CONTRIBUTION', data: { amount: 10000 } });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.checkingAccount.balance, 10000);
});

test('EVT-41: Roth rollover contribution is not a US or AU taxable event', () => {
  const { sim } = loadToolsetScenario(makeRothConfig({ initialChecking: 20000, startingResidency: 'AU' }));
  sim.schedule({ date: new Date(2026, 0, 15), type: 'ROTH_ROLLOVER_CONTRIBUTION', data: { amount: 10000 } });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.usOrdinaryIncomeYTD, 0);
  assert.strictEqual(sim.state.auOrdinaryIncomeYTD, 0);
});

// ══════════════════════════════════════════════════════════════════════════════
// EVT-42: Roth Rollover Earnings
// ══════════════════════════════════════════════════════════════════════════════

test('EVT-42: Roth rollover earnings increase balance and rolloverEarningsBasis', () => {
  const { sim } = loadToolsetScenario(makeRothConfig({
    rothBalance: 10000,
    rolloverContribBasis: 10000,
  }));
  sim.schedule({ date: new Date(2026, 0, 15), type: 'ROTH_ROLLOVER_EARNINGS', data: { amount: 500 } });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.rothAccount.balance, 10500);
  assert.strictEqual(sim.state.rothAccount.rolloverEarningsBasis, 500);
  assert.strictEqual(sim.state.rothAccount.earningsBasis, 0); // regular earnings unaffected
});

test('EVT-42: Roth rollover earnings stay in account — no checking transaction', () => {
  const { sim } = loadToolsetScenario(makeRothConfig({ initialChecking: 5000, rothBalance: 10000, rolloverContribBasis: 10000 }));
  sim.schedule({ date: new Date(2026, 0, 15), type: 'ROTH_ROLLOVER_EARNINGS', data: { amount: 500 } });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.checkingAccount.balance, 5000);
});

test('EVT-42: Roth rollover earnings are not a US or AU taxable event', () => {
  const { sim } = loadToolsetScenario(makeRothConfig({
    rothBalance: 10000,
    rolloverContribBasis: 10000,
    startingResidency: 'AU',
  }));
  sim.schedule({ date: new Date(2026, 0, 15), type: 'ROTH_ROLLOVER_EARNINGS', data: { amount: 500 } });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.usOrdinaryIncomeYTD, 0);
  assert.strictEqual(sim.state.auOrdinaryIncomeYTD, 0);
});

// ══════════════════════════════════════════════════════════════════════════════
// EVT-43: Roth Rollover Withdrawal – Contributions
// ══════════════════════════════════════════════════════════════════════════════

test('EVT-43: Roth rollover contribution withdrawal credits checking and reduces rolloverContribBasis', () => {
  const { sim } = loadToolsetScenario(makeRothConfig({
    initialChecking: 5000,
    rothBalance: 10000,
    rolloverContribBasis: 10000,
  }));
  sim.schedule({ date: new Date(2026, 0, 15), type: 'ROTH_ROLLOVER_WITHDRAWAL_CONTRIBUTIONS', data: { amount: 4000 } });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.checkingAccount.balance, 9000); // 5000 + 4000
  assert.strictEqual(sim.state.rothAccount.balance, 6000);
  assert.strictEqual(sim.state.rothAccount.rolloverContribBasis, 6000);
});

test('EVT-43: Roth rollover contribution withdrawal is not a US or AU taxable event', () => {
  const { sim } = loadToolsetScenario(makeRothConfig({
    initialChecking: 5000,
    rothBalance: 10000,
    rolloverContribBasis: 10000,
    startingResidency: 'AU',
  }));
  sim.schedule({ date: new Date(2026, 0, 15), type: 'ROTH_ROLLOVER_WITHDRAWAL_CONTRIBUTIONS', data: { amount: 4000 } });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.usOrdinaryIncomeYTD, 0);
  assert.strictEqual(sim.state.usPenaltyYTD, 0);
  assert.strictEqual(sim.state.auOrdinaryIncomeYTD, 0);
});

// ══════════════════════════════════════════════════════════════════════════════
// EVT-44: Roth Rollover Withdrawal – Earnings
// ══════════════════════════════════════════════════════════════════════════════

test('EVT-44: Roth rollover earnings withdrawal credits checking and reduces rolloverEarningsBasis', () => {
  const { sim } = loadToolsetScenario(makeRothConfig({
    initialChecking: 5000,
    rothBalance: 10000,
    rolloverEarningsBasis: 10000,
  }));
  sim.schedule({ date: new Date(2026, 0, 15), type: 'ROTH_ROLLOVER_WITHDRAWAL_EARNINGS', data: { amount: 3000 } });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.checkingAccount.balance, 8000); // 5000 + 3000
  assert.strictEqual(sim.state.rothAccount.balance, 7000);
  assert.strictEqual(sim.state.rothAccount.rolloverEarningsBasis, 7000);
});

test('EVT-44: Roth rollover earnings withdrawal has no US ordinary income or penalty', () => {
  const { sim } = loadToolsetScenario(makeRothConfig({
    initialChecking: 5000,
    rothBalance: 10000,
    rolloverEarningsBasis: 10000,
    birthDate: '1990-01-01', // under 60
  }));
  sim.schedule({ date: new Date(2026, 0, 15), type: 'ROTH_ROLLOVER_WITHDRAWAL_EARNINGS', data: { amount: 3000 } });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.usOrdinaryIncomeYTD, 0);
  assert.strictEqual(sim.state.usPenaltyYTD, 0);
});

test('EVT-44: Roth rollover earnings withdrawal IS AU ordinary income if AU resident', () => {
  const { sim } = loadToolsetScenario(makeRothConfig({
    initialChecking: 5000,
    rothBalance: 10000,
    rolloverEarningsBasis: 10000,
    startingResidency: 'AU',
  }));
  sim.schedule({ date: new Date(2026, 0, 15), type: 'ROTH_ROLLOVER_WITHDRAWAL_EARNINGS', data: { amount: 3000 } });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.auOrdinaryIncomeYTD, 3000);
  assert.ok(sim.state.ftcYTD > 0, 'FTC should be recorded for AU resident');
});

test('EVT-44: Roth rollover earnings withdrawal is NOT AU taxable if not AU resident', () => {
  const { sim } = loadToolsetScenario(makeRothConfig({
    initialChecking: 5000,
    rothBalance: 10000,
    rolloverEarningsBasis: 10000,
    startingResidency: 'US',
  }));
  sim.schedule({ date: new Date(2026, 0, 15), type: 'ROTH_ROLLOVER_WITHDRAWAL_EARNINGS', data: { amount: 3000 } });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.auOrdinaryIncomeYTD, 0);
  assert.strictEqual(sim.state.ftcYTD, 0);
});
