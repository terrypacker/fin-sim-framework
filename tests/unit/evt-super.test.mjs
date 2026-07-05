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
 * evt-super.test.mjs
 * Tests for Superannuation events: EVT-20 through EVT-23
 *
 * EVT-20  Super Contribution          +contribution  out of AU cash pool  AU: always super tax (15%), no US tax, no FTC
 * EVT-21  Super Withdrawal-Contrib    -contribution  into AU cash pool    min age 60 (enforced, no numeric penalty),
 *                                                                          no US tax, no AU tax
 * EVT-22  Super Withdrawal-Earnings   -earnings      into AU cash pool    min age 60 (enforced),
 *                                                                          US: ordinary income, no AU tax
 * EVT-23  Super Earnings              +earnings      stays in account     AU: always super tax, no US tax, no FTC
 *
 * Run with: node --test tests/unit/evt-super.test.mjs
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

function makeSuperConfig({
  initialChecking    = 20000,
  initialAuSavings   = 50000,
  superBalance       = 0,
  superContribBasis  = 0,
  superEarningsBasis = 0,
  superGrowthRate    = 0,
  birthDate          = '1966-01-01', // turns 60 on 2026-01-01
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
      superGrowthRate, auStockGrowthRate: 0, auStockDividendRate: 0,
    },
    persons: [{
      __type: 'Person', id: 'primary', name: 'Primary', birthDate,
      citizen: ['AU'], lifeExpectancy: 90, monthlyWage: 0,
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
        __type: 'SuperannuationAccount', id: 'super', name: 'Super',
        role: 'super', stateKey: 'superAccount',
        initialValue: superBalance, contributionBasis: superContribBasis,
        earningsBasis: superEarningsBasis,
        ownershipType: 'sole', ownerId: 'primary',
        country: 'AU', currency: { code: 'AUD', symbol: '$' },
      },
    ],
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// EVT-20: Superannuation Contribution
// ══════════════════════════════════════════════════════════════════════════════

test('EVT-20: Super contribution increases superAccount balance and contributionBasis', () => {
  const { sim } = loadToolsetScenario(makeSuperConfig({ initialAuSavings: 10000 }));
  sim.schedule({ date: new Date(2026, 0, 15), type: 'SUPER_CONTRIBUTION', data: { amount: 5000 } });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.superAccount.balance, 5000);
  assert.strictEqual(sim.state.superAccount.contributionBasis, 5000);
  assert.strictEqual(sim.state.superAccount.earningsBasis, 0);
});

test('EVT-20: Super contribution debits AU cash pool (auSavingsAccount)', () => {
  const { sim } = loadToolsetScenario(makeSuperConfig({ initialAuSavings: 10000 }));
  sim.schedule({ date: new Date(2026, 0, 15), type: 'SUPER_CONTRIBUTION', data: { amount: 5000 } });
  sim.stepTo(new Date(2026, 0, 31));

  // Super contribution debits AU cash pool = auSavingsAccount ?? checkingAccount
  assert.strictEqual(sim.state.auSavingsAccount.balance, 5000);
  assert.strictEqual(sim.state.checkingAccount.balance, 20000); // unchanged
});

test('EVT-20: Super contribution is always AU super taxable (15%)', () => {
  const { sim } = loadToolsetScenario(makeSuperConfig({ initialAuSavings: 10000 }));
  sim.schedule({ date: new Date(2026, 0, 15), type: 'SUPER_CONTRIBUTION', data: { amount: 5000 } });
  sim.stepTo(new Date(2026, 0, 31));

  // In the toolset path, state.people and state.superAccount are non-null → per-person maps used
  assert.strictEqual(sim.state.auPersonSuperTaxYTD?.['primary'], 750); // 15% of 5000
});

test('EVT-20: Super contribution is not a US taxable event', () => {
  const { sim } = loadToolsetScenario(makeSuperConfig({ initialAuSavings: 10000 }));
  sim.schedule({ date: new Date(2026, 0, 15), type: 'SUPER_CONTRIBUTION', data: { amount: 5000 } });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.usOrdinaryIncomeYTD, 0);
});

// ══════════════════════════════════════════════════════════════════════════════
// EVT-21: Super Withdrawal — Contributions
// ══════════════════════════════════════════════════════════════════════════════

test('EVT-21: Super contribution withdrawal at age 60+ succeeds', () => {
  const { sim } = loadToolsetScenario(makeSuperConfig({
    initialAuSavings: 5000,
    superBalance: 20000,
    superContribBasis: 20000,
    birthDate: '1966-01-01', // age 60 in 2026
  }));
  sim.schedule({ date: new Date(2026, 1, 1), type: 'SUPER_WITHDRAWAL_CONTRIBUTIONS', data: { amount: 5000 } });
  sim.stepTo(new Date(2026, 1, 28));

  assert.strictEqual(sim.state.superWithdrawalBlocked, false);
  // Withdrawal credits AU cash pool (auSavingsAccount)
  assert.strictEqual(sim.state.auSavingsAccount.balance, 10000);
  assert.strictEqual(sim.state.superAccount.balance, 15000);
});

test('EVT-21: Super contribution withdrawal before age 60 is blocked', () => {
  const { sim } = loadToolsetScenario(makeSuperConfig({
    initialAuSavings: 5000,
    superBalance: 20000,
    superContribBasis: 20000,
    birthDate: '1990-01-01', // age 36 in 2026
  }));
  sim.schedule({ date: new Date(2026, 0, 15), type: 'SUPER_WITHDRAWAL_CONTRIBUTIONS', data: { amount: 5000 } });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.superWithdrawalBlocked, true);
  assert.strictEqual(sim.state.auSavingsAccount.balance, 5000); // unchanged
  assert.strictEqual(sim.state.superAccount.balance, 20000);    // unchanged
});

test('EVT-21: Super contribution withdrawal has no US or AU tax', () => {
  const { sim } = loadToolsetScenario(makeSuperConfig({
    initialAuSavings: 5000,
    superBalance: 20000,
    superContribBasis: 20000,
    birthDate: '1966-01-01',
  }));
  sim.schedule({ date: new Date(2026, 1, 1), type: 'SUPER_WITHDRAWAL_CONTRIBUTIONS', data: { amount: 5000 } });
  sim.stepTo(new Date(2026, 1, 28));

  assert.strictEqual(sim.state.usOrdinaryIncomeYTD, 0);
  assert.strictEqual(sim.state.auPersonSuperTaxYTD?.['primary'], 0);
});

// ══════════════════════════════════════════════════════════════════════════════
// EVT-22: Super Withdrawal — Earnings
// ══════════════════════════════════════════════════════════════════════════════

test('EVT-22: Super earnings withdrawal at age 60+ succeeds', () => {
  const { sim } = loadToolsetScenario(makeSuperConfig({
    initialAuSavings: 5000,
    superBalance: 20000,
    superEarningsBasis: 20000,
    birthDate: '1966-01-01',
  }));
  sim.schedule({ date: new Date(2026, 1, 1), type: 'SUPER_WITHDRAWAL_EARNINGS', data: { amount: 5000 } });
  sim.stepTo(new Date(2026, 1, 28));

  assert.strictEqual(sim.state.superWithdrawalBlocked, false);
  // Withdrawal credits AU cash pool (auSavingsAccount)
  assert.strictEqual(sim.state.auSavingsAccount.balance, 10000);
});

test('EVT-22: Super earnings withdrawal before age 60 is blocked', () => {
  const { sim } = loadToolsetScenario(makeSuperConfig({
    initialAuSavings: 5000,
    superBalance: 20000,
    superEarningsBasis: 20000,
    birthDate: '1990-01-01',
  }));
  sim.schedule({ date: new Date(2026, 0, 15), type: 'SUPER_WITHDRAWAL_EARNINGS', data: { amount: 5000 } });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.superWithdrawalBlocked, true);
  assert.strictEqual(sim.state.auSavingsAccount.balance, 5000); // unchanged
});

test('EVT-22: Super earnings withdrawal is US ordinary income taxable', () => {
  const { sim } = loadToolsetScenario(makeSuperConfig({
    initialAuSavings: 5000,
    superBalance: 20000,
    superEarningsBasis: 20000,
    birthDate: '1966-01-01',
  }));
  sim.schedule({ date: new Date(2026, 1, 1), type: 'SUPER_WITHDRAWAL_EARNINGS', data: { amount: 5000 } });
  sim.stepTo(new Date(2026, 1, 28));

  assert.strictEqual(sim.state.usOrdinaryIncomeYTD, 5000);
});

test('EVT-22: Super earnings withdrawal has no AU tax', () => {
  const { sim } = loadToolsetScenario(makeSuperConfig({
    initialAuSavings: 5000,
    superBalance: 20000,
    superEarningsBasis: 20000,
    birthDate: '1966-01-01',
  }));
  sim.schedule({ date: new Date(2026, 1, 1), type: 'SUPER_WITHDRAWAL_EARNINGS', data: { amount: 5000 } });
  sim.stepTo(new Date(2026, 1, 28));

  assert.strictEqual(sim.state.auPersonSuperTaxYTD?.['primary'], 0);
});

// ══════════════════════════════════════════════════════════════════════════════
// EVT-23: Super Earnings
// ══════════════════════════════════════════════════════════════════════════════

test('EVT-23: Super earnings increase superAccount balance and earningsBasis', () => {
  const { sim } = loadToolsetScenario(makeSuperConfig({ superBalance: 100000, superContribBasis: 100000 }));
  sim.schedule({ date: new Date(2026, 0, 15), type: 'SUPER_EARNINGS', data: { amount: 7000 } });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.superAccount.balance, 107000);
  assert.strictEqual(sim.state.superAccount.earningsBasis, 7000);
  assert.strictEqual(sim.state.superAccount.contributionBasis, 100000); // unchanged
});

test('EVT-23: Super earnings stay in account — no cash pool transaction', () => {
  const { sim } = loadToolsetScenario(makeSuperConfig({
    initialAuSavings: 5000,
    superBalance: 100000,
    superContribBasis: 100000,
  }));
  sim.schedule({ date: new Date(2026, 0, 15), type: 'SUPER_EARNINGS', data: { amount: 7000 } });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.auSavingsAccount.balance, 5000); // unchanged
  assert.strictEqual(sim.state.checkingAccount.balance, 20000); // unchanged
});

test('EVT-23: Super earnings are always AU super taxable (15%)', () => {
  const { sim } = loadToolsetScenario(makeSuperConfig({ superBalance: 100000, superContribBasis: 100000 }));
  sim.schedule({ date: new Date(2026, 0, 15), type: 'SUPER_EARNINGS', data: { amount: 7000 } });
  sim.stepTo(new Date(2026, 0, 31));

  // In the toolset path, state.people and state.superAccount are non-null → per-person maps used
  assert.strictEqual(sim.state.auPersonSuperTaxYTD?.['primary'], 1050); // 15% of 7000
});

test('EVT-23: Super earnings are not US taxable', () => {
  const { sim } = loadToolsetScenario(makeSuperConfig({ superBalance: 100000, superContribBasis: 100000 }));
  sim.schedule({ date: new Date(2026, 0, 15), type: 'SUPER_EARNINGS', data: { amount: 7000 } });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.usOrdinaryIncomeYTD, 0);
});

// ══════════════════════════════════════════════════════════════════════════════
// EVT-23: Pension-phase exemption (design/36 §12.1)
//
// Super fund earnings are taxed 15% in accumulation phase, but 0% once the
// member reaches pension/retirement phase (age ≥ 60, condition-of-release proxy).
// These exercise the real scheduled INTL_SUPER_EARNINGS → SuperEarningsHandler
// path (the toolset wires it year-end, startOffset 1, so the first accrual lands
// in the second sim year, ~end of 2027).
// ══════════════════════════════════════════════════════════════════════════════

test('EVT-23: super earnings taxed at 15% in accumulation phase (member < 60)', () => {
  const { sim } = loadToolsetScenario(makeSuperConfig({
    superBalance: 100000, superContribBasis: 100000,
    superGrowthRate: 0.07,
    birthDate: '1990-01-01', // age ~37 — accumulation phase
  }));
  sim.stepTo(new Date(2027, 11, 31));

  // 7000 of earnings accrued and grew the balance...
  assert.strictEqual(sim.state.superAccount.balance, 107000);
  // ...and were taxed at the flat 15% super rate.
  assert.strictEqual(sim.state.auPersonSuperTaxYTD?.['primary'], 1050); // 15% of 7000
});

test('EVT-23: super earnings tax-free in pension phase (member ≥ 60)', () => {
  const { sim } = loadToolsetScenario(makeSuperConfig({
    superBalance: 100000, superContribBasis: 100000,
    superGrowthRate: 0.07,
    birthDate: '1962-01-01', // age ~65 — pension/retirement phase
  }));
  sim.stepTo(new Date(2027, 11, 31));

  // Earnings still accrue and compound...
  assert.strictEqual(sim.state.superAccount.balance, 107000);
  // ...but attract NO super earnings tax (pension-phase exemption).
  assert.strictEqual(sim.state.auPersonSuperTaxYTD?.['primary'], 0);
});
