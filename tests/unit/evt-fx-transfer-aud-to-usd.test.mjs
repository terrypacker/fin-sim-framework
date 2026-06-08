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
 * evt-fx-transfer-aud-to-usd.test.mjs
 *
 * EVT-FX-6  FX_TRANSFER AUD→USD  debits AU savings, credits US savings using inverted rate.
 * EVT-FX-7  FX_TRANSFER AUD→USD  fee is converted to AUD before deduction (so USD received = (audActual / rate) - feeUsd).
 */

import { test, beforeEach } from 'node:test';
import assert   from 'node:assert/strict';

import { ServiceRegistry } from '../../src/services/service-registry.js';
import { ScenarioLoader }  from '../../src/scenarios/scenario-loader.js';
import { BaseScenario }    from '../../src/index.js';

beforeEach(() => ServiceRegistry.resetAll());

function loadFxScenario(config) {
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

function makeFxConfig({
  usSavingsBalance  = 0,
  auSavingsBalance  = 5000,
  exchangeRate      = 1.55,
  transferFee       = 15,
} = {}) {
  return {
    toolsets: ['US_RETIREMENT', 'AU_RETIREMENT', 'US_AU_CROSS_BORDER'],
    simStart: '2026-01-01',
    simEnd:   '2028-01-01',
    parameters: {
      monthlyExpenses: 0, inflationAdjust: false, inflationRate: 0, auInflationRate: 0,
      rothGrowthRate: 0, iraGrowthRate: 0, k401GrowthRate: 0,
      brokerageGrowthRate: 0, brokerageDividendRate: 0, fixedIncomeInterestRate: 0,
      usSavingsInterestRate: 0, auSavingsInterestRate: 0,
      superGrowthRate: 0, auStockGrowthRate: 0, auStockDividendRate: 0,
      exchangeRateUsdToAud: exchangeRate,
      intlTransferFeeUsd:   transferFee,
    },
    persons: [{
      __type: 'Person', id: 'primary', name: 'Primary', birthDate: '1966-01-01',
      citizen: ['US', 'AU'], lifeExpectancy: 90, monthlyWage: 0,
      retirementDate: '2025-01-01', socialSecurityMonthly: 0,
    }],
    accounts: [
      {
        __type: 'SavingsAccount', id: 'us-savings', name: 'US Savings',
        role: 'us-savings', stateKey: 'usSavingsAccount',
        initialValue: usSavingsBalance, ownershipType: 'sole', ownerId: 'primary',
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
// EVT-FX-6: FX_TRANSFER AUD → USD basic transfer
// ══════════════════════════════════════════════════════════════════════════════

test('EVT-FX-6: FX_TRANSFER AUD→USD debits AU savings, credits US savings with inverted rate', () => {
  const { sim } = loadFxScenario(makeFxConfig({ auSavingsBalance: 5000, exchangeRate: 1.55, transferFee: 15 }));

  sim.schedule({ date: new Date(2026, 0, 15), type: 'FX_TRANSFER', data: { from: 'AUD', to: 'USD', amount: 1550 } });
  sim.stepTo(new Date(2026, 0, 31));

  // For AUD→USD:
  //   fee in AUD = feeUsd × rate = 15 × 1.55 = 23.25
  //   fromActual = min(1550, 5000) = 1550
  //   toCredit   = (fromActual - feeAud) × (1/rate) = (1550 - 23.25) / 1.55 = 1526.75 / 1.55 ≈ 985
  const feeAud  = 15 * 1.55;
  const usdReceived = (1550 - feeAud) / 1.55;

  assert.ok(Math.abs(sim.state.auSavingsAccount.balance - (5000 - 1550)) < 0.01,
    `Expected AU balance ~${5000 - 1550}, got ${sim.state.auSavingsAccount.balance}`);
  assert.ok(Math.abs(sim.state.usSavingsAccount.balance - usdReceived) < 0.01,
    `Expected US balance ~${usdReceived}, got ${sim.state.usSavingsAccount.balance}`);
});

// ══════════════════════════════════════════════════════════════════════════════
// EVT-FX-7: AUD→USD and USD→AUD are symmetric (round-trip loses only the fees)
// ══════════════════════════════════════════════════════════════════════════════

test('EVT-FX-7: AUD→USD produces numerically equivalent result to the existing INTL_TRANSFER_TO_US handler', () => {
  // The legacy AU_TO_US formula: usdReceived = audActual / rate - feeUsd
  // The new formula:             toCredit = (audActual - feeAud) × (1/rate) = audActual/rate - feeUsd
  // They should be equivalent.
  const rate = 1.55;
  const fee  = 15;
  const audAmount = 1550;

  const legacyUsd = audAmount / rate - fee;
  const feeAud    = fee * rate;
  const newUsd    = (audAmount - feeAud) * (1 / rate);

  assert.ok(Math.abs(legacyUsd - newUsd) < 1e-9,
    `Legacy formula ${legacyUsd} should equal new formula ${newUsd}`);

  const { sim } = loadFxScenario(makeFxConfig({ auSavingsBalance: audAmount, exchangeRate: rate, transferFee: fee }));
  sim.schedule({ date: new Date(2026, 0, 15), type: 'FX_TRANSFER', data: { from: 'AUD', to: 'USD', amount: audAmount } });
  sim.stepTo(new Date(2026, 0, 31));

  assert.ok(Math.abs(sim.state.usSavingsAccount.balance - legacyUsd) < 0.01,
    `US savings ${sim.state.usSavingsAccount.balance} should match legacy formula result ${legacyUsd}`);
});
