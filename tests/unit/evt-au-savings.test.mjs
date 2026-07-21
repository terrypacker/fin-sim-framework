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
 * evt-au-savings.test.mjs
 * Tests for AU Savings Account events: EVT-16 through EVT-19
 *
 * EVT-16  AU Savings contribution             +balance  out of checking  no tax
 * EVT-17  AU Savings withdrawal               -balance  into checking    no tax
 * EVT-18  AU Savings earnings as AU resident  +balance  stays in account US: ordinary income, AU: always ordinary income, FTC
 * EVT-19  AU Savings earnings as non-resident +balance  stays in account US: ordinary income, AU: always non-resident withholding, FTC
 *
 * Note: The source CSV has EVT-18 and EVT-19 AU tax types swapped.
 *       Confirmed correct treatment:
 *         - AU Resident     → AU Ordinary Income rate
 *         - AU Non-Resident → AU Non-Resident Withholding rate
 *
 * Run with: node --test tests/evt-au-savings.test.mjs
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

function makeAuSavingsConfig({
  initialChecking  = 20000,
  auSavingsBalance = 0,
  startingResidency = 'AU',
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
      __type: 'Person', id: 'primary', name: 'Primary', birthDate: '1966-01-01',
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
        initialValue: auSavingsBalance, ownershipType: 'sole', ownerId: 'primary',
        minimumBalance: 0, country: 'AU', currency: { code: 'AUD', symbol: '$' },
      },
    ],
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// EVT-16: AU Savings Contribution
// ══════════════════════════════════════════════════════════════════════════════

test('EVT-16: AU savings contribution increases auSavingsAccount and debits checking', () => {
  const { sim } = loadToolsetScenario(makeAuSavingsConfig({ initialChecking: 10000 }));
  sim.schedule({ date: new Date(2026, 0, 15), type: 'AU_SAVINGS_CONTRIBUTION', data: { amount: 5000 } });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.auSavingsAccount.balance, 5000);
  assert.strictEqual(sim.state.checkingAccount.balance, 5000);
});

test('EVT-16: AU savings contribution is not a US or AU taxable event', () => {
  const { sim } = loadToolsetScenario(makeAuSavingsConfig({ initialChecking: 10000, startingResidency: 'AU' }));
  sim.schedule({ date: new Date(2026, 0, 15), type: 'AU_SAVINGS_CONTRIBUTION', data: { amount: 5000 } });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.usOrdinaryIncomeYTD, 0);
  assert.strictEqual(sim.state.auOrdinaryIncomeYTD, 0);
  assert.strictEqual(sim.state.auNonResidentWithholdingYTD, 0);
});

// ══════════════════════════════════════════════════════════════════════════════
// EVT-17: AU Savings Withdrawal
// ══════════════════════════════════════════════════════════════════════════════

test('EVT-17: AU savings withdrawal decreases auSavingsAccount and credits checking', () => {
  const { sim } = loadToolsetScenario(makeAuSavingsConfig({ initialChecking: 5000, auSavingsBalance: 20000 }));
  sim.schedule({ date: new Date(2026, 0, 15), type: 'AU_SAVINGS_WITHDRAWAL', data: { amount: 8000 } });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.auSavingsAccount.balance, 12000);
  assert.strictEqual(sim.state.checkingAccount.balance, 13000);
});

test('EVT-17: AU savings withdrawal is not a US or AU taxable event', () => {
  const { sim } = loadToolsetScenario(makeAuSavingsConfig({ initialChecking: 5000, auSavingsBalance: 20000, startingResidency: 'AU' }));
  sim.schedule({ date: new Date(2026, 0, 15), type: 'AU_SAVINGS_WITHDRAWAL', data: { amount: 8000 } });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.usOrdinaryIncomeYTD, 0);
  assert.strictEqual(sim.state.auOrdinaryIncomeYTD, 0);
  assert.strictEqual(sim.state.auNonResidentWithholdingYTD, 0);
});

// ══════════════════════════════════════════════════════════════════════════════
// EVT-18: AU Savings Earnings — as AU Resident
// ══════════════════════════════════════════════════════════════════════════════

test('EVT-18: AU savings earnings (resident) stay in account', () => {
  const { sim } = loadToolsetScenario(makeAuSavingsConfig({ initialChecking: 5000, auSavingsBalance: 20000, startingResidency: 'AU' }));
  sim.schedule({ date: new Date(2026, 0, 15), type: 'AU_SAVINGS_EARNINGS', data: { amount: 600 } });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.auSavingsAccount.balance, 20600);
  assert.strictEqual(sim.state.checkingAccount.balance, 5000); // unchanged
});

test('EVT-18: AU savings earnings (resident) are US ordinary income taxable', () => {
  const { sim } = loadToolsetScenario(makeAuSavingsConfig({ auSavingsBalance: 20000, startingResidency: 'AU' }));
  sim.schedule({ date: new Date(2026, 0, 15), type: 'AU_SAVINGS_EARNINGS', data: { amount: 600 } });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.usOrdinaryIncomeYTD, 600 / sim.state.effectiveExchangeRates.USD_AUD); // design 51: AUD-source → USD bucket
});

test('EVT-18: AU savings earnings (resident) are ALWAYS AU taxable at ordinary income rate', () => {
  const { sim } = loadToolsetScenario(makeAuSavingsConfig({ auSavingsBalance: 20000, startingResidency: 'AU' }));
  sim.schedule({ date: new Date(2026, 0, 15), type: 'AU_SAVINGS_EARNINGS', data: { amount: 600 } });
  sim.stepTo(new Date(2026, 0, 31));

  // In the toolset path, state.people is non-null → per-person maps are used instead of flat YTD fields
  assert.strictEqual(sim.state.auPersonOrdinaryIncomeYTD?.['primary'], 600);
  assert.strictEqual(sim.state.auNonResidentWithholdingYTD, 0); // resident pays ordinary rate
  assert.ok(sim.state.foreignPassiveIncomeYTD > 0, 'FTC should be recorded');
});

// ══════════════════════════════════════════════════════════════════════════════
// EVT-19: AU Savings Earnings — as AU Non-Resident
// ══════════════════════════════════════════════════════════════════════════════

test('EVT-19: AU savings earnings (non-resident) stay in account', () => {
  const { sim } = loadToolsetScenario(makeAuSavingsConfig({ initialChecking: 5000, auSavingsBalance: 20000, startingResidency: 'US' }));
  sim.schedule({ date: new Date(2026, 0, 15), type: 'AU_SAVINGS_EARNINGS', data: { amount: 600 } });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.auSavingsAccount.balance, 20600);
  assert.strictEqual(sim.state.checkingAccount.balance, 5000); // unchanged
});

test('EVT-19: AU savings earnings (non-resident) are US ordinary income taxable', () => {
  const { sim } = loadToolsetScenario(makeAuSavingsConfig({ auSavingsBalance: 20000, startingResidency: 'US' }));
  sim.schedule({ date: new Date(2026, 0, 15), type: 'AU_SAVINGS_EARNINGS', data: { amount: 600 } });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.usOrdinaryIncomeYTD, 600 / sim.state.effectiveExchangeRates.USD_AUD); // design 51: AUD-source → USD bucket
});

test('EVT-19: AU savings earnings (non-resident) are ALWAYS AU taxable at non-resident withholding rate', () => {
  const { sim } = loadToolsetScenario(makeAuSavingsConfig({ auSavingsBalance: 20000, startingResidency: 'US' }));
  sim.schedule({ date: new Date(2026, 0, 15), type: 'AU_SAVINGS_EARNINGS', data: { amount: 600 } });
  sim.stepTo(new Date(2026, 0, 31));

  // In the toolset path, state.people is non-null → per-person maps are used instead of flat YTD fields.
  // Design 73 Gap 2: interest lands in the typed 10% bucket, not the pooled 15% one.
  assert.strictEqual(sim.state.auPersonNrWithholdingInterestYTD?.['primary'], 600);
  assert.strictEqual(sim.state.auPersonNonResidentWithholdingYTD?.['primary'], 0);
  assert.strictEqual(sim.state.auOrdinaryIncomeYTD, 0); // non-resident pays withholding rate
  assert.ok(sim.state.foreignPassiveIncomeYTD > 0, 'FTC should be recorded');
});
