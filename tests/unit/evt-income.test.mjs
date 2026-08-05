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
 * evt-income.test.mjs
 * Tests for US/AU income events:
 *
 * EVT-37  Social Security Income  + $ amount/month  US: 85% ordinary income  AU: ordinary income if resident
 * EVT-38  Wages (Gross)           + $ amount/month  US: ordinary income       AU: ordinary income if resident
 * EVT-39  Wages – Taxes Withheld  − % of amount     N/A (withholding only)    N/A
 * EVT-48  Self-Employment (US)    + $ amount/month  US: ordinary income       AU: ordinary income if resident
 * EVT-49  Self-Employment (AU)    + $ amount/month  US: ordinary income       AU: ordinary income if resident
 * EVT-50  Bonus                   + $ amount         US: ordinary income       AU: ordinary income if resident
 * EVT-51  Company Sale            + $ amount         US: capital gain          AU: capital gain if resident
 */

import { test, beforeEach } from 'node:test';
import assert   from 'node:assert/strict';
import { auOrdinaryFor } from '../helpers/assert.js';

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

const COMMON_PARAMS = {
  monthlyExpenses: 0, inflationAdjust: false, inflationRate: 0,
  rothGrowthRate: 0, iraGrowthRate: 0, k401GrowthRate: 0,
  brokerageGrowthRate: 0, brokerageDividendRate: 0, fixedIncomeInterestRate: 0,
  usSavingsInterestRate: 0, auSavingsInterestRate: 0,
  superGrowthRate: 0, auStockGrowthRate: 0, auStockDividendRate: 0,
};

function makeUsIncomeConfig({
  initialChecking  = 20000,
  initialAuSavings = 50000,
  startingResidency = 'US',
} = {}) {
  return {
    toolsets: ['US_RETIREMENT', 'AU_RETIREMENT', 'US_AU_CROSS_BORDER'],
    simStart: '2026-01-01',
    simEnd:   '2028-01-01',
    parameters: { ...COMMON_PARAMS, startingResidency },
    persons: [{
      __type: 'Person', id: 'primary', name: 'Primary', birthDate: '1966-01-01',
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
    ],
  };
}

function makeAuIncomeConfig({
  initialChecking  = 0,
  initialAuSavings = 0,
  startingResidency = 'AU',
} = {}) {
  return {
    toolsets: ['US_RETIREMENT', 'AU_RETIREMENT', 'AU_INCOME', 'US_AU_CROSS_BORDER'],
    simStart: '2026-01-01',
    simEnd:   '2028-01-01',
    parameters: { ...COMMON_PARAMS, startingResidency },
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
    ],
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// EVT-37: Social Security Income
// ══════════════════════════════════════════════════════════════════════════════

test('EVT-37: SS income credits full amount to checking', () => {
  const { sim } = loadToolsetScenario(makeUsIncomeConfig({ initialChecking: 5000 }));
  sim.schedule({ date: new Date(2026, 0, 15), type: 'SS_INCOME', data: { amount: 2000 } });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.checkingAccount.balance, 7000);
});

test('EVT-37: SS income records only 85% as US ordinary income', () => {
  const { sim } = loadToolsetScenario(makeUsIncomeConfig());
  sim.schedule({ date: new Date(2026, 0, 15), type: 'SS_INCOME', data: { amount: 2000 } });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.usOrdinaryIncomeYTD, 1700); // 85% of 2000
});

// Design 83 G11 — Art. 18(2) reserves US Social Security to the United States, and
// Art. 1(4)(a) exempts Art. 18(2) from the Art. 1(3) saving clause, so Australia
// cannot reach it back as a resident. The AU-resident case must therefore look
// exactly like the US-resident one. This assertion was inverted: it used to require
// the full benefit in auOrdinaryIncomeYTD.
test('EVT-37: SS income is taxable only in the US, even for an AU resident (Art. 18(2))', () => {
  const { sim } = loadToolsetScenario(makeUsIncomeConfig({ startingResidency: 'AU' }));
  sim.schedule({ date: new Date(2026, 0, 15), type: 'SS_INCOME', data: { amount: 2000 } });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.usOrdinaryIncomeYTD, 1700);
  assert.strictEqual(sim.state.auOrdinaryIncomeYTD, 0);
  // No AU tax on it ⇒ no Art. 22(2) credit for Australia to give, so nothing enters
  // the FITO removal set and no Art. 27(1)(c) re-sourcing is "necessary".
  assert.strictEqual(sim.state.usSourceOrdinaryUsdYTD ?? 0, 0);
  assert.strictEqual(sim.state.usSourceGeneralUsdYTD ?? 0, 0);
});

test('EVT-37: SS income is not AU taxable if not AU resident', () => {
  const { sim } = loadToolsetScenario(makeUsIncomeConfig({ startingResidency: 'US' }));
  sim.schedule({ date: new Date(2026, 0, 15), type: 'SS_INCOME', data: { amount: 2000 } });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.auOrdinaryIncomeYTD, 0);
  assert.strictEqual(sim.state.usSourceOrdinaryUsdYTD, 0);
});

// ══════════════════════════════════════════════════════════════════════════════
// EVT-38: Wages (Gross)
// ══════════════════════════════════════════════════════════════════════════════

test('EVT-38: wages credit full gross amount to checking', () => {
  const { sim } = loadToolsetScenario(makeUsIncomeConfig({ initialChecking: 3000 }));
  sim.schedule({ date: new Date(2026, 0, 15), type: 'WAGES_INCOME', data: { amount: 5000 } });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.checkingAccount.balance, 8000);
});

test('EVT-38: wages record full amount as US ordinary income', () => {
  const { sim } = loadToolsetScenario(makeUsIncomeConfig());
  sim.schedule({ date: new Date(2026, 0, 15), type: 'WAGES_INCOME', data: { amount: 5000 } });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.usOrdinaryIncomeYTD, 5000);
});

test('EVT-38: wages record full amount as AU ordinary income if AU resident', () => {
  const { sim } = loadToolsetScenario(makeUsIncomeConfig({ startingResidency: 'AU' }));
  sim.schedule({ date: new Date(2026, 0, 15), type: 'WAGES_INCOME', data: { amount: 5000 } });
  sim.stepTo(new Date(2026, 0, 31));

  // design 51: US-source wages (USD) are normalized into the AUD bucket.
  assert.strictEqual(sim.state.auOrdinaryIncomeYTD, 5000 * sim.state.effectiveExchangeRates.USD_AUD);
  assert.ok(sim.state.usSourceOrdinaryUsdYTD > 0, 'FTC should be recorded for AU resident');
});

test('EVT-38: wages are not AU taxable if not AU resident', () => {
  const { sim } = loadToolsetScenario(makeUsIncomeConfig({ startingResidency: 'US' }));
  sim.schedule({ date: new Date(2026, 0, 15), type: 'WAGES_INCOME', data: { amount: 5000 } });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.auOrdinaryIncomeYTD, 0);
  assert.strictEqual(sim.state.usSourceOrdinaryUsdYTD, 0);
});

// ══════════════════════════════════════════════════════════════════════════════
// EVT-39: Wages – Taxes Withheld
// ══════════════════════════════════════════════════════════════════════════════

test('EVT-39: wages withheld debits checking account', () => {
  const { sim } = loadToolsetScenario(makeUsIncomeConfig({ initialChecking: 10000 }));
  sim.schedule({ date: new Date(2026, 0, 15), type: 'WAGES_WITHHELD', data: { amount: 1500 } });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.checkingAccount.balance, 8500);
});

test('EVT-39: wages withheld increments usWithheldYTD', () => {
  const { sim } = loadToolsetScenario(makeUsIncomeConfig({ initialChecking: 10000 }));
  sim.schedule({ date: new Date(2026, 0, 15), type: 'WAGES_WITHHELD', data: { amount: 1500 } });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.usWithheldYTD, 1500);
});

test('EVT-39: wages withheld does not affect any income YTD field', () => {
  const { sim } = loadToolsetScenario(makeUsIncomeConfig({ initialChecking: 10000, startingResidency: 'AU' }));
  sim.schedule({ date: new Date(2026, 0, 15), type: 'WAGES_WITHHELD', data: { amount: 1500 } });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.usOrdinaryIncomeYTD, 0);
  assert.strictEqual(sim.state.auOrdinaryIncomeYTD, 0);
  assert.strictEqual(sim.state.usSourceOrdinaryUsdYTD, 0);
});

// ══════════════════════════════════════════════════════════════════════════════
// EVT-48: Self-Employment Income (US)
// ══════════════════════════════════════════════════════════════════════════════

test('EVT-48: US self-employment income credits checking', () => {
  const { sim } = loadToolsetScenario(makeUsIncomeConfig({ initialChecking: 2000 }));
  sim.schedule({ date: new Date(2026, 0, 15), type: 'SE_INCOME_US', data: { amount: 4000 } });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.checkingAccount.balance, 6000);
});

test('EVT-48: US self-employment income is US ordinary income', () => {
  const { sim } = loadToolsetScenario(makeUsIncomeConfig());
  sim.schedule({ date: new Date(2026, 0, 15), type: 'SE_INCOME_US', data: { amount: 4000 } });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.usOrdinaryIncomeYTD, 4000);
});

test('EVT-48: US self-employment income is AU ordinary income if AU resident', () => {
  const { sim } = loadToolsetScenario(makeUsIncomeConfig({ startingResidency: 'AU' }));
  sim.schedule({ date: new Date(2026, 0, 15), type: 'SE_INCOME_US', data: { amount: 4000 } });
  sim.stepTo(new Date(2026, 0, 31));

  // design 51: US-source SE income (USD) is normalized into the AUD bucket.
  assert.strictEqual(sim.state.auOrdinaryIncomeYTD, 4000 * sim.state.effectiveExchangeRates.USD_AUD);
  assert.ok(sim.state.usSourceOrdinaryUsdYTD > 0, 'FTC should be recorded for AU resident');
});

test('EVT-48: US self-employment income is not AU taxable if not AU resident', () => {
  const { sim } = loadToolsetScenario(makeUsIncomeConfig({ startingResidency: 'US' }));
  sim.schedule({ date: new Date(2026, 0, 15), type: 'SE_INCOME_US', data: { amount: 4000 } });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.auOrdinaryIncomeYTD, 0);
  assert.strictEqual(sim.state.usSourceOrdinaryUsdYTD, 0);
});

// ══════════════════════════════════════════════════════════════════════════════
// EVT-49: Self-Employment Income (AU Savings)
// ══════════════════════════════════════════════════════════════════════════════

test('EVT-49: AU self-employment income credits AU savings account', () => {
  const { sim } = loadToolsetScenario(makeAuIncomeConfig({ initialAuSavings: 1000 }));
  sim.schedule({ date: new Date(2026, 0, 15), type: 'SE_INCOME_AU', data: { amount: 3000 } });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.auSavingsAccount.balance, 4000);
});

test('EVT-49: AU self-employment income is always US ordinary income', () => {
  const { sim } = loadToolsetScenario(makeAuIncomeConfig({ startingResidency: 'US' }));
  sim.schedule({ date: new Date(2026, 0, 15), type: 'SE_INCOME_AU', data: { amount: 3000 } });
  sim.stepTo(new Date(2026, 0, 31));

  // design 51: AU-source SE income (AUD) is normalized into the USD worldwide bucket.
  assert.strictEqual(sim.state.usOrdinaryIncomeYTD, 3000 / sim.state.effectiveExchangeRates.USD_AUD);
});

test('EVT-49: AU self-employment income is AU ordinary income if AU resident', () => {
  const { sim } = loadToolsetScenario(makeAuIncomeConfig({ startingResidency: 'AU' }));
  sim.schedule({ date: new Date(2026, 0, 15), type: 'SE_INCOME_AU', data: { amount: 3000 } });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.auOrdinaryIncomeYTD, 3000);
  assert.ok(sim.state.foreignGeneralIncomeYTD > 0, 'FTC should be recorded for AU resident');
});

test('EVT-49: AU self-employment income is not AU taxable if not AU resident', () => {
  const { sim } = loadToolsetScenario(makeAuIncomeConfig({ startingResidency: 'US' }));
  sim.schedule({ date: new Date(2026, 0, 15), type: 'SE_INCOME_AU', data: { amount: 3000 } });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.auOrdinaryIncomeYTD, 0);
  assert.strictEqual(sim.state.foreignGeneralIncomeYTD, 0);
});

// ══════════════════════════════════════════════════════════════════════════════
// EVT-50: Bonus
// ══════════════════════════════════════════════════════════════════════════════

test('EVT-50: bonus credits full amount to checking', () => {
  const { sim } = loadToolsetScenario(makeUsIncomeConfig({ initialChecking: 5000 }));
  sim.schedule({ date: new Date(2026, 1, 1), type: 'BONUS', data: { amount: 10000 } });
  sim.stepTo(new Date(2026, 1, 28));

  assert.strictEqual(sim.state.checkingAccount.balance, 15000);
});

test('EVT-50: bonus is US ordinary income', () => {
  const { sim } = loadToolsetScenario(makeUsIncomeConfig());
  sim.schedule({ date: new Date(2026, 1, 1), type: 'BONUS', data: { amount: 10000 } });
  sim.stepTo(new Date(2026, 1, 28));

  assert.strictEqual(sim.state.usOrdinaryIncomeYTD, 10000);
});

test('EVT-50: bonus is AU ordinary income if AU resident', () => {
  const { sim } = loadToolsetScenario(makeUsIncomeConfig({ startingResidency: 'AU' }));
  sim.schedule({ date: new Date(2026, 1, 1), type: 'BONUS', data: { amount: 10000 } });
  sim.stepTo(new Date(2026, 1, 28));

  // design 51: US-source bonus (USD) is normalized into the AUD bucket.
  // design 76 P5: a bonus is W-2 wages, so it is assessed wholly to the earner
  // rather than halved across the household.
  assert.strictEqual(auOrdinaryFor(sim.state), 10000 * sim.state.effectiveExchangeRates.USD_AUD);
  assert.ok(sim.state.usSourceOrdinaryUsdYTD > 0, 'FTC should be recorded for AU resident');
});

test('EVT-50: bonus is not AU taxable if not AU resident', () => {
  const { sim } = loadToolsetScenario(makeUsIncomeConfig({ startingResidency: 'US' }));
  sim.schedule({ date: new Date(2026, 1, 1), type: 'BONUS', data: { amount: 10000 } });
  sim.stepTo(new Date(2026, 1, 28));

  assert.strictEqual(sim.state.auOrdinaryIncomeYTD, 0);
  assert.strictEqual(sim.state.usSourceOrdinaryUsdYTD, 0);
});

// ══════════════════════════════════════════════════════════════════════════════
// EVT-51: Company Sale
// ══════════════════════════════════════════════════════════════════════════════

test('EVT-51: company sale credits full sale price to checking', () => {
  const { sim } = loadToolsetScenario(makeUsIncomeConfig({ initialChecking: 5000 }));
  sim.schedule({
    date: new Date(2026, 1, 1),
    type: 'COMPANY_SALE',
    data: { salePrice: 200000, costBasis: 80000 },
  });
  sim.stepTo(new Date(2026, 1, 28));

  assert.strictEqual(sim.state.checkingAccount.balance, 205000); // 5000 + 200000
});

test('EVT-51: company sale records gain as US capital gain', () => {
  const { sim } = loadToolsetScenario(makeUsIncomeConfig());
  sim.schedule({
    date: new Date(2026, 1, 1),
    type: 'COMPANY_SALE',
    data: { salePrice: 200000, costBasis: 80000 },
  });
  sim.stepTo(new Date(2026, 1, 28));

  assert.strictEqual(sim.state.usCapitalGainsYTD, 120000); // 200000 - 80000
});

test('EVT-51: company sale records gain as AU capital gain if AU resident', () => {
  const { sim } = loadToolsetScenario(makeUsIncomeConfig({ startingResidency: 'AU' }));
  sim.schedule({
    date: new Date(2026, 1, 1),
    type: 'COMPANY_SALE',
    data: { salePrice: 200000, costBasis: 80000 },
  });
  sim.stepTo(new Date(2026, 1, 28));

  // design 51: US-source company-sale gain (USD) is normalized into the AUD CGT bucket.
  assert.strictEqual(sim.state.auCapitalGainsYTD, 120000 * sim.state.effectiveExchangeRates.USD_AUD);
  // Design 83 G10 — company shares are personal property, so §865(a) sources the
  // gain by the seller's residence: foreign source for an AU-resident US citizen.
  // It creates §904 passive limitation room and no Art. 22(2) removal slice.
  assert.strictEqual(sim.state.usSourceCapGainsUsdYTD ?? 0, 0);
  assert.ok(sim.state.foreignPassiveIncomeYTD > 0,
    'the gain must still create §904 passive limitation room');
});

test('EVT-51: company sale is not AU taxable if not AU resident', () => {
  const { sim } = loadToolsetScenario(makeUsIncomeConfig({ startingResidency: 'US' }));
  sim.schedule({
    date: new Date(2026, 1, 1),
    type: 'COMPANY_SALE',
    data: { salePrice: 200000, costBasis: 80000 },
  });
  sim.stepTo(new Date(2026, 1, 28));

  assert.strictEqual(sim.state.auCapitalGainsYTD, 0);
  assert.strictEqual(sim.state.usSourceCapGainsUsdYTD, 0);
});

test('EVT-51: company sale with no gain records zero capital gain', () => {
  const { sim } = loadToolsetScenario(makeUsIncomeConfig({ initialChecking: 5000 }));
  sim.schedule({
    date: new Date(2026, 1, 1),
    type: 'COMPANY_SALE',
    data: { salePrice: 80000, costBasis: 80000 },
  });
  sim.stepTo(new Date(2026, 1, 28));

  assert.strictEqual(sim.state.usCapitalGainsYTD, 0);
});
