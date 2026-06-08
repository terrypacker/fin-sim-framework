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
 * evt-fx-transfer-usd-to-aud.test.mjs
 *
 * EVT-FX-1  FX_TRANSFER USD→AUD  debits US savings by amount, credits AU savings by (amount - fee) × rate.
 * EVT-FX-2  FX_TRANSFER USD→AUD  with zero balance — no transfer, both balances unchanged.
 * EVT-FX-3  FX_TRANSFER USD→AUD  partial balance available — caps fromAmount to available.
 * EVT-FX-4  State after scenario load has baseExchangeRates / effectiveExchangeRates populated.
 * EVT-FX-5  FxRefreshReducer mirrors base → effective on period advance.
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
  usSavingsBalance  = 10000,
  auSavingsBalance  = 0,
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
// EVT-FX-1: FX_TRANSFER USD → AUD basic transfer
// ══════════════════════════════════════════════════════════════════════════════

test('EVT-FX-1: FX_TRANSFER USD→AUD debits US savings by amount, credits AU savings by (amount - fee) × rate', () => {
  const { sim } = loadFxScenario(makeFxConfig({ usSavingsBalance: 5000, exchangeRate: 1.55, transferFee: 15 }));

  sim.schedule({ date: new Date(2026, 0, 15), type: 'FX_TRANSFER', data: { from: 'USD', to: 'AUD', amount: 1000 } });
  sim.stepTo(new Date(2026, 0, 31));

  const expectedAud = (1000 - 15) * 1.55; // (amount - fee) × rate = 985 × 1.55 = 1526.75
  assert.strictEqual(sim.state.usSavingsAccount.balance, 4000);
  assert.ok(Math.abs(sim.state.auSavingsAccount.balance - expectedAud) < 0.01,
    `Expected AU balance ~${expectedAud}, got ${sim.state.auSavingsAccount.balance}`);
});

// ══════════════════════════════════════════════════════════════════════════════
// EVT-FX-2: FX_TRANSFER with zero source balance
// ══════════════════════════════════════════════════════════════════════════════

test('EVT-FX-2: FX_TRANSFER USD→AUD with zero US balance results in no transfer', () => {
  const { sim } = loadFxScenario(makeFxConfig({ usSavingsBalance: 0, auSavingsBalance: 0 }));

  sim.schedule({ date: new Date(2026, 0, 15), type: 'FX_TRANSFER', data: { from: 'USD', to: 'AUD', amount: 1000 } });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.usSavingsAccount.balance, 0);
  assert.strictEqual(sim.state.auSavingsAccount.balance, 0);
});

// ══════════════════════════════════════════════════════════════════════════════
// EVT-FX-3: FX_TRANSFER caps fromAmount to available balance
// ══════════════════════════════════════════════════════════════════════════════

test('EVT-FX-3: FX_TRANSFER USD→AUD caps fromAmount to available US balance', () => {
  const { sim } = loadFxScenario(makeFxConfig({ usSavingsBalance: 500, exchangeRate: 1.55, transferFee: 15 }));

  // Request 1000 but only 500 available
  sim.schedule({ date: new Date(2026, 0, 15), type: 'FX_TRANSFER', data: { from: 'USD', to: 'AUD', amount: 1000 } });
  sim.stepTo(new Date(2026, 0, 31));

  const expectedAud = (500 - 15) * 1.55; // capped at 500, so 485 × 1.55 = 751.75
  assert.strictEqual(sim.state.usSavingsAccount.balance, 0);
  assert.ok(Math.abs(sim.state.auSavingsAccount.balance - expectedAud) < 0.01,
    `Expected AU balance ~${expectedAud}, got ${sim.state.auSavingsAccount.balance}`);
});

// ══════════════════════════════════════════════════════════════════════════════
// EVT-FX-4: State fields populated after scenario load
// ══════════════════════════════════════════════════════════════════════════════

test('EVT-FX-4: baseExchangeRates and effectiveExchangeRates are populated after scenario load', () => {
  const { sim } = loadFxScenario(makeFxConfig({ exchangeRate: 1.60, transferFee: 20 }));

  assert.deepStrictEqual(sim.state.baseExchangeRates,      { USD_AUD: 1.60 });
  assert.deepStrictEqual(sim.state.effectiveExchangeRates, { USD_AUD: 1.60 });
  assert.deepStrictEqual(sim.state.baseFxFees,             { USD_AUD: 20 });
  assert.deepStrictEqual(sim.state.effectiveFxFees,        { USD_AUD: 20 });
});

// ══════════════════════════════════════════════════════════════════════════════
// EVT-FX-5: FxRefreshReducer mirrors base → effective on US period advance
// ══════════════════════════════════════════════════════════════════════════════

test('EVT-FX-5: FxRefreshReducer syncs effective fields from base fields on period advance', () => {
  const { sim } = loadFxScenario(makeFxConfig({ exchangeRate: 1.55, transferFee: 15 }));

  // Manually update the base rate to simulate a future rate change (e.g., parameter override).
  sim.state.baseExchangeRates = { USD_AUD: 1.70 };
  sim.state.baseFxFees        = { USD_AUD: 20 };

  // Trigger a US period advance to let FxRefreshReducer sync effective → base.
  sim.schedule({ date: new Date(2027, 0, 1), type: 'PERIOD_ADVANCE_US', data: { cc: 'US', periods: [] } });
  sim.stepTo(new Date(2027, 0, 2));

  assert.deepStrictEqual(sim.state.effectiveExchangeRates, { USD_AUD: 1.70 });
  assert.deepStrictEqual(sim.state.effectiveFxFees,        { USD_AUD: 20 });
});
