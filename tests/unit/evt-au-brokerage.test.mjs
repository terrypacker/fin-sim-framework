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
 * evt-au-brokerage.test.mjs
 * Tests for AU Brokerage events: EVT-26 through EVT-32
 *
 * EVT-26  Franked dividend — AU resident     +basis  stays in account  US: ordinary, AU: franking credit, FTC
 * EVT-27  Franked dividend — AU non-resident +basis  stays in account  US: TODO (??), no AU tax
 * EVT-28  Unfranked dividend — AU resident   +basis  stays in account  US: ordinary, AU: ordinary, FTC
 * EVT-29  Unfranked dividend — non-resident  +basis  stays in account  US: ordinary, AU: NR withholding, FTC
 * EVT-30  AU Brokerage earnings (unrealized) +earn   stays in account  no tax
 * EVT-31  AU Brokerage withdrawal — resident  -      into checking     US: capital gain, AU: capital gain, FTC
 * EVT-32  AU Brokerage withdrawal — non-res   -      into checking     US: capital gain, no AU tax
 *
 * Run with: node --test tests/unit/evt-au-brokerage.test.mjs
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

function makeAuBrokerageConfig({
  initialChecking      = 20000,
  initialAuSavings     = 50000,
  auStockBalance       = 0,
  auStockContribBasis  = 0,
  auStockEarningsBasis = 0,
  startingResidency    = 'AU',
} = {}) {
  return {
    toolsets: ['US_RETIREMENT', 'AU_RETIREMENT', 'AU_BROKERAGE', 'US_AU_CROSS_BORDER'],
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
        initialValue: initialAuSavings, ownershipType: 'sole', ownerId: 'primary',
        minimumBalance: 0, country: 'AU', currency: { code: 'AUD', symbol: '$' },
      },
      {
        __type: 'BrokerageAccount', id: 'au-stock', name: 'AU Stock',
        role: 'au-stock', stateKey: 'auStockAccount',
        initialValue: auStockBalance, contributionBasis: auStockContribBasis,
        earningsBasis: auStockEarningsBasis,
        ownershipType: 'sole', ownerId: 'primary',
        country: 'AU', currency: { code: 'AUD', symbol: '$' },
      },
    ],
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// EVT-26: Franked Dividend — AU Resident
// ══════════════════════════════════════════════════════════════════════════════

test('EVT-26: Franked dividend (resident) stays in account', () => {
  const { sim } = loadToolsetScenario(makeAuBrokerageConfig({ auStockBalance: 50000, auStockContribBasis: 50000, startingResidency: 'AU' }));
  sim.schedule({ date: new Date(2026, 0, 15), type: 'AU_DIVIDEND_FRANKED_RESIDENT', data: { amount: 1000 } });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.auStockAccount.balance, 51000);
  assert.strictEqual(sim.state.checkingAccount.balance, 20000); // unchanged
});

test('EVT-26: Franked dividend (resident) is US ordinary income taxable', () => {
  const { sim } = loadToolsetScenario(makeAuBrokerageConfig({ auStockBalance: 50000, auStockContribBasis: 50000, startingResidency: 'AU' }));
  sim.schedule({ date: new Date(2026, 0, 15), type: 'AU_DIVIDEND_FRANKED_RESIDENT', data: { amount: 1000 } });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.usOrdinaryIncomeYTD, 1000 / sim.state.effectiveExchangeRates.USD_AUD); // design 51: AUD-source → USD bucket
});

test('EVT-26: Franked dividend (resident) generates AU franking credit', () => {
  const { sim } = loadToolsetScenario(makeAuBrokerageConfig({ auStockBalance: 50000, auStockContribBasis: 50000, startingResidency: 'AU' }));
  sim.schedule({ date: new Date(2026, 0, 15), type: 'AU_DIVIDEND_FRANKED_RESIDENT', data: { amount: 1000 } });
  sim.stepTo(new Date(2026, 0, 31));

  // In the toolset path, state.people and state.auStockAccount are non-null → per-person maps used
  assert.strictEqual(sim.state.auPersonFrankingCreditYTD?.['primary'], 1000);
  assert.ok(sim.state.ftcYTD > 0, 'FTC should be recorded');
});

// ══════════════════════════════════════════════════════════════════════════════
// EVT-27: Franked Dividend — AU Non-Resident (TODO)
// ══════════════════════════════════════════════════════════════════════════════

test('EVT-27: Franked dividend (non-resident) stays in account', () => {
  const { sim } = loadToolsetScenario(makeAuBrokerageConfig({ auStockBalance: 50000, auStockContribBasis: 50000, startingResidency: 'US' }));
  sim.schedule({ date: new Date(2026, 0, 15), type: 'AU_DIVIDEND_FRANKED_NONRESIDENT', data: { amount: 1000 } });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.auStockAccount.balance, 51000);
  assert.strictEqual(sim.state.checkingAccount.balance, 20000);
});

test('EVT-27: Franked dividend (non-resident) has no AU tax', () => {
  const { sim } = loadToolsetScenario(makeAuBrokerageConfig({ auStockBalance: 50000, auStockContribBasis: 50000, startingResidency: 'US' }));
  sim.schedule({ date: new Date(2026, 0, 15), type: 'AU_DIVIDEND_FRANKED_NONRESIDENT', data: { amount: 1000 } });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.auOrdinaryIncomeYTD, 0);
  assert.strictEqual(sim.state.auNonResidentWithholdingYTD, 0);
  assert.strictEqual(sim.state.auFrankingCreditYTD, 0);
});

// TODO (EVT-27): US tax treatment for non-resident franked dividends is unresolved (CSV: "Ordinary Income??").
// When clarified, add an assertion here for usOrdinaryIncomeYTD.

// ══════════════════════════════════════════════════════════════════════════════
// EVT-28: Unfranked Dividend — AU Resident
// ══════════════════════════════════════════════════════════════════════════════

test('EVT-28: Unfranked dividend (resident) stays in account', () => {
  const { sim } = loadToolsetScenario(makeAuBrokerageConfig({ auStockBalance: 50000, auStockContribBasis: 50000, startingResidency: 'AU' }));
  sim.schedule({ date: new Date(2026, 0, 15), type: 'AU_DIVIDEND_UNFRANKED_RESIDENT', data: { amount: 1000 } });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.auStockAccount.balance, 51000);
  assert.strictEqual(sim.state.checkingAccount.balance, 20000);
});

test('EVT-28: Unfranked dividend (resident) is US ordinary income taxable', () => {
  const { sim } = loadToolsetScenario(makeAuBrokerageConfig({ auStockBalance: 50000, auStockContribBasis: 50000, startingResidency: 'AU' }));
  sim.schedule({ date: new Date(2026, 0, 15), type: 'AU_DIVIDEND_UNFRANKED_RESIDENT', data: { amount: 1000 } });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.usOrdinaryIncomeYTD, 1000 / sim.state.effectiveExchangeRates.USD_AUD); // design 51: AUD-source → USD bucket
});

test('EVT-28: Unfranked dividend (resident) is AU ordinary income taxable', () => {
  const { sim } = loadToolsetScenario(makeAuBrokerageConfig({ auStockBalance: 50000, auStockContribBasis: 50000, startingResidency: 'AU' }));
  sim.schedule({ date: new Date(2026, 0, 15), type: 'AU_DIVIDEND_UNFRANKED_RESIDENT', data: { amount: 1000 } });
  sim.stepTo(new Date(2026, 0, 31));

  // In the toolset path, state.people and state.auStockAccount are non-null → per-person maps used
  assert.strictEqual(sim.state.auPersonOrdinaryIncomeYTD?.['primary'], 1000);
  assert.ok(sim.state.ftcYTD > 0);
});

// ══════════════════════════════════════════════════════════════════════════════
// EVT-29: Unfranked Dividend — AU Non-Resident
// ══════════════════════════════════════════════════════════════════════════════

test('EVT-29: Unfranked dividend (non-resident) stays in account', () => {
  const { sim } = loadToolsetScenario(makeAuBrokerageConfig({ auStockBalance: 50000, auStockContribBasis: 50000, startingResidency: 'US' }));
  sim.schedule({ date: new Date(2026, 0, 15), type: 'AU_DIVIDEND_UNFRANKED_NONRESIDENT', data: { amount: 1000 } });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.auStockAccount.balance, 51000);
  assert.strictEqual(sim.state.checkingAccount.balance, 20000);
});

test('EVT-29: Unfranked dividend (non-resident) is US ordinary income taxable', () => {
  const { sim } = loadToolsetScenario(makeAuBrokerageConfig({ auStockBalance: 50000, auStockContribBasis: 50000, startingResidency: 'US' }));
  sim.schedule({ date: new Date(2026, 0, 15), type: 'AU_DIVIDEND_UNFRANKED_NONRESIDENT', data: { amount: 1000 } });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.usOrdinaryIncomeYTD, 1000 / sim.state.effectiveExchangeRates.USD_AUD); // design 51: AUD-source → USD bucket
});

test('EVT-29: Unfranked dividend (non-resident) is AU non-resident withholding taxable', () => {
  const { sim } = loadToolsetScenario(makeAuBrokerageConfig({ auStockBalance: 50000, auStockContribBasis: 50000, startingResidency: 'US' }));
  sim.schedule({ date: new Date(2026, 0, 15), type: 'AU_DIVIDEND_UNFRANKED_NONRESIDENT', data: { amount: 1000 } });
  sim.stepTo(new Date(2026, 0, 31));

  // In the toolset path, state.people and state.auStockAccount are non-null → per-person maps used
  assert.strictEqual(sim.state.auPersonNonResidentWithholdingYTD?.['primary'], 1000);
  assert.strictEqual(sim.state.auOrdinaryIncomeYTD, 0);
  assert.ok(sim.state.ftcYTD > 0);
});

// ══════════════════════════════════════════════════════════════════════════════
// EVT-30: AU Brokerage Earnings (Unrealized)
// ══════════════════════════════════════════════════════════════════════════════

test('EVT-30: AU stock earnings stay in account, no tax event', () => {
  const { sim } = loadToolsetScenario(makeAuBrokerageConfig({
    initialChecking: 5000,
    auStockBalance: 50000,
    auStockContribBasis: 50000,
    startingResidency: 'AU',
  }));
  sim.schedule({ date: new Date(2026, 0, 15), type: 'AU_STOCK_EARNINGS', data: { amount: 5000 } });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.auStockAccount.balance, 55000);
  assert.strictEqual(sim.state.auStockAccount.earningsBasis, 5000);
  assert.strictEqual(sim.state.checkingAccount.balance, 5000);   // unchanged
  assert.strictEqual(sim.state.usOrdinaryIncomeYTD, 0);
  assert.strictEqual(sim.state.auOrdinaryIncomeYTD, 0);
  assert.strictEqual(sim.state.usCapitalGainsYTD, 0);
});

// ══════════════════════════════════════════════════════════════════════════════
// EVT-31: AU Brokerage Withdrawal — AU Resident
// ══════════════════════════════════════════════════════════════════════════════

test('EVT-31: AU stock sale (resident) credits AU cash pool with sale proceeds', () => {
  const { sim } = loadToolsetScenario(makeAuBrokerageConfig({
    initialChecking: 5000,
    initialAuSavings: 10000,
    auStockBalance: 30000,
    auStockContribBasis: 20000,
    auStockEarningsBasis: 10000,
    startingResidency: 'AU',
  }));
  sim.schedule({ date: new Date(2026, 0, 15), type: 'AU_STOCK_WITHDRAWAL',
    data: { salePrice: 15000, costBasis: 10000 } });
  sim.stepTo(new Date(2026, 0, 31));

  // AU stock withdrawal credits auSavingsAccount (AU cash pool = auSavingsAccount ?? checkingAccount)
  assert.strictEqual(sim.state.auSavingsAccount.balance, 25000); // 10000 + 15000
  assert.strictEqual(sim.state.checkingAccount.balance, 5000);  // unchanged
});

test('EVT-31: AU stock sale (resident) records US and AU capital gains', () => {
  const { sim } = loadToolsetScenario(makeAuBrokerageConfig({
    auStockBalance: 30000,
    auStockContribBasis: 20000,
    auStockEarningsBasis: 10000,
    startingResidency: 'AU',
  }));
  sim.schedule({ date: new Date(2026, 0, 15), type: 'AU_STOCK_WITHDRAWAL',
    data: { salePrice: 15000, costBasis: 10000 } });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.usCapitalGainsYTD, 5000 / sim.state.effectiveExchangeRates.USD_AUD); // design 51: AUD-source → USD bucket
  // In the toolset path, state.people and state.auStockAccount are non-null → per-person maps used
  assert.strictEqual(sim.state.auPersonCapitalGainsYTD?.['primary'], 5000);
  assert.ok(sim.state.ftcYTD > 0);
});

// ══════════════════════════════════════════════════════════════════════════════
// EVT-32: AU Brokerage Withdrawal — AU Non-Resident
// ══════════════════════════════════════════════════════════════════════════════

test('EVT-32: AU stock sale (non-resident) records US capital gain only — no AU tax', () => {
  const { sim } = loadToolsetScenario(makeAuBrokerageConfig({
    auStockBalance: 30000,
    auStockContribBasis: 20000,
    auStockEarningsBasis: 10000,
    startingResidency: 'US',
  }));
  sim.schedule({ date: new Date(2026, 0, 15), type: 'AU_STOCK_WITHDRAWAL',
    data: { salePrice: 15000, costBasis: 10000 } });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.usCapitalGainsYTD, 5000 / sim.state.effectiveExchangeRates.USD_AUD); // design 51: AUD-source → USD bucket
  assert.strictEqual(sim.state.auCapitalGainsYTD, 0);
  assert.strictEqual(sim.state.ftcYTD, 0);
});
