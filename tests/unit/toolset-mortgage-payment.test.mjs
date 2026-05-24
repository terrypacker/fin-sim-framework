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
 * toolset-mortgage-payment.test.mjs
 *
 * Tests for mortgage payment support in US_REAL_PROPERTY and AU_REAL_PROPERTY toolsets.
 *
 * Required tests:
 *   1. Monthly Mortgage Payments are made while mortgageBalance > 0 and monthlyMortgage > 0
 *   2. The last payment doesn't overpay
 *   3. Payments stop after mortgageBalance == 0
 *   4. Payments stop after the house is sold
 *
 * Run with: node --test tests/unit/toolset-mortgage-payment.test.mjs
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

// ─── Base config builders ──────────────────────────────────────────────────────

function makeUsConfig({ mortgageBalance, monthlyMortgage, plannedSaleYear = null, simStart = '2026-01-01', simEnd = '2028-01-01', initialBalance = 500_000, minimumBalance = 0 }) {
  return {
    toolsets: ['US_RETIREMENT', 'US_REAL_PROPERTY'],
    simStart,
    simEnd,
    parameters: {},
    persons: [
      {
        __type:                'Person',
        id:                    'primary',
        name:                  'Primary',
        birthDate:             '1975-04-15',
        citizen:               ['US'],
        lifeExpectancy:        90,
        monthlyWage:           0,
        retirementDate:        '2025-01-01',
        socialSecurityMonthly: 0,
      },
    ],
    accounts: [
      {
        __type:         'SavingsAccount',
        id:             'us-savings',
        name:           'US Savings',
        type:           'savings',
        role:           'us-savings',
        stateKey:       'usSavingsAccount',
        initialValue:   initialBalance,
        ownershipType:  'sole',
        ownerId:        'primary',
        minimumBalance,
        country:        'US',
        currency:       { code: 'USD', symbol: '$' },
      },
    ],
    realProperties: [
      {
        __type:                 'RealProperty',
        id:                     're1',
        name:                   'US House',
        appreciationRate:       0.03,
        costBasis:              400_000,
        country:                'US',
        drawdownPriority:       null,
        isPrimaryResidence:     true,
        monthlyMortgage,
        mortgageBalance,
        ownerId:                'primary',
        owners:                 [],
        ownershipType:          'sole',
        plannedSaleYear,
        saleDestinationAccount: 'usSavingsAccount',
        stateKey:               'usHouseProperty',
        value:                  800_000,
      },
    ],
  };
}

function makeAuConfig({ mortgageBalance, monthlyMortgage, plannedSaleYear = null, simStart = '2026-01-01', simEnd = '2028-01-01', initialBalance = 500_000, minimumBalance = 0 }) {
  return {
    toolsets: ['AU_RETIREMENT', 'AU_REAL_PROPERTY', 'US_TAX'],
    simStart,
    simEnd,
    parameters: {},
    persons: [
      {
        __type:                'Person',
        id:                    'primary',
        name:                  'Primary',
        birthDate:             '1975-04-15',
        citizen:               ['AU'],
        lifeExpectancy:        90,
        monthlyWage:           0,
        retirementDate:        '2025-01-01',
        socialSecurityMonthly: 0,
      },
    ],
    accounts: [
      {
        __type:         'SavingsAccount',
        id:             'au-savings',
        name:           'AU Savings',
        type:           'savings',
        role:           'au-savings',
        stateKey:       'auSavingsAccount',
        initialValue:   initialBalance,
        ownershipType:  'sole',
        ownerId:        'primary',
        minimumBalance,
        country:        'AU',
        currency:       { code: 'AUD', symbol: 'A$' },
      },
    ],
    realProperties: [
      {
        __type:                 'RealProperty',
        id:                     're1',
        name:                   'AU House',
        appreciationRate:       0.03,
        costBasis:              400_000,
        country:                'AU',
        drawdownPriority:       null,
        isPrimaryResidence:     true,
        monthlyMortgage,
        mortgageBalance,
        ownerId:                'primary',
        owners:                 [],
        ownershipType:          'sole',
        plannedSaleYear,
        saleDestinationAccount: 'auSavingsAccount',
        stateKey:               'auHouseProperty',
        value:                  800_000,
      },
    ],
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// US Mortgage Payment Tests
// ══════════════════════════════════════════════════════════════════════════════

test('Mortgage-US-1: Monthly mortgage payments are made each month while mortgageBalance > 0 and monthlyMortgage > 0', () => {
  // mortgageBalance = 10000, monthlyMortgage = 2000: expect 5 payments of 2000 each
  const { sim } = loadToolsetScenario(makeUsConfig({
    mortgageBalance: 10_000,
    monthlyMortgage: 2_000,
    simStart: '2026-01-01',
    simEnd:   '2028-01-01',
  }));

  // Step through 3 months: Jan 31, Feb 28, Mar 31, 2026
  const threeMonths = new Date(Date.UTC(2026, 2, 31));
  assert.doesNotThrow(() => sim.stepTo(threeMonths));

  const payments = sim.journal.getActions('US_MORTGAGE_PAYMENT_APPLY');
  assert.ok(payments.length >= 3, `Expected at least 3 payments; got ${payments.length}`);

  // Each payment should debit 2000 from the cash account
  const cashDiff = payments[0].stateDiff.find(d => d.field === 'usSavingsAccount.balance');
  assert.ok(cashDiff, 'First payment should debit usSavingsAccount.balance');
  assert.strictEqual(cashDiff.delta, -2_000, 'First payment should debit exactly 2000');
});

test('Mortgage-US-2: The last mortgage payment does not overpay (capped to remaining balance)', () => {
  // mortgageBalance = 3000, monthlyMortgage = 2000:
  //   Month 1 (Jan 31): pays 2000, balance → 1000
  //   Month 2 (Feb 28): pays 1000 (remaining), balance → 0
  const { sim } = loadToolsetScenario(makeUsConfig({
    mortgageBalance: 3_000,
    monthlyMortgage: 2_000,
    simStart: '2026-01-01',
    simEnd:   '2028-01-01',
  }));

  const twoMonths = new Date(Date.UTC(2026, 1, 28));
  assert.doesNotThrow(() => sim.stepTo(twoMonths));

  const payments = sim.journal.getActions('US_MORTGAGE_PAYMENT_APPLY');
  assert.strictEqual(payments.length, 2, `Expected exactly 2 payments; got ${payments.length}`);

  // First payment: 2000
  const firstMortgageDiff = payments[0].stateDiff.find(d => d.field === 'usHouseProperty.mortgageBalance');
  assert.ok(firstMortgageDiff, 'First payment should update usHouseProperty.mortgageBalance');
  assert.strictEqual(firstMortgageDiff.delta, -2_000, 'First payment should reduce balance by 2000');
  assert.strictEqual(firstMortgageDiff.after,  1_000, 'Balance after first payment should be 1000');

  // Second (last) payment: 1000, not 2000
  const lastMortgageDiff = payments[1].stateDiff.find(d => d.field === 'usHouseProperty.mortgageBalance');
  assert.ok(lastMortgageDiff, 'Last payment should update usHouseProperty.mortgageBalance');
  assert.strictEqual(lastMortgageDiff.delta, -1_000, 'Last payment should only pay remaining 1000, not the full 2000');
  assert.strictEqual(lastMortgageDiff.after,      0, 'Mortgage balance should reach zero after last payment');
});

test('Mortgage-US-3: Mortgage payments stop once mortgageBalance reaches zero', () => {
  // mortgageBalance = 2000, monthlyMortgage = 2000:
  //   Month 1 (Jan 31): pays 2000, balance → 0
  //   Month 2+: no payments (balance = 0)
  const { sim } = loadToolsetScenario(makeUsConfig({
    mortgageBalance: 2_000,
    monthlyMortgage: 2_000,
    simStart: '2026-01-01',
    simEnd:   '2028-01-01',
  }));

  // Step 3 months — only 1 payment should occur
  const threeMonths = new Date(Date.UTC(2026, 2, 31));
  assert.doesNotThrow(() => sim.stepTo(threeMonths));

  const payments = sim.journal.getActions('US_MORTGAGE_PAYMENT_APPLY');
  assert.strictEqual(payments.length, 1, `Expected exactly 1 payment before balance hits zero; got ${payments.length}`);

  const mortgageDiff = payments[0].stateDiff.find(d => d.field === 'usHouseProperty.mortgageBalance');
  assert.strictEqual(mortgageDiff.after, 0, 'Balance should be zero after the single payment');
});

test('Mortgage-US-4: Mortgage payments stop after the house is sold', () => {
  // Sale fires Jan 15, 2026 (before first month-end Jan 31), zeroing the mortgage.
  // simStart = 2025-12-01 → Dec 31 2025 generates one payment before the sale.
  // After the Jan 15 2026 sale, no more payments.
  const { sim } = loadToolsetScenario(makeUsConfig({
    mortgageBalance:  1_000_000, // large so it would never naturally reach 0
    monthlyMortgage:  2_000,
    plannedSaleYear:  2026,      // sale on Jan 15, 2026
    simStart:         '2025-12-01',
    simEnd:           '2028-01-01',
  }));

  // Step through Dec 2025 + all of 2026 Q1
  const endQ1_2026 = new Date(Date.UTC(2026, 2, 31));
  assert.doesNotThrow(() => sim.stepTo(endQ1_2026));

  const payments = sim.journal.getActions('US_MORTGAGE_PAYMENT_APPLY');
  // Dec 31, 2025: 1 payment before the sale
  // Jan 31, Feb 28, Mar 31 2026: NO payments (house sold Jan 15, mortgage cleared)
  assert.strictEqual(payments.length, 1, `Expected 1 payment (Dec 2025 only); got ${payments.length}`);

  // Confirm the sale zeroed the mortgage
  const saleActions = sim.journal.getActions('US_HOUSE_SALE_APPLY');
  assert.ok(saleActions.length > 0, 'House sale should have been applied');
  const saleStateDiff = saleActions[0].stateDiff.find(d => d.field === 'usHouseProperty.mortgageBalance');
  assert.ok(saleStateDiff, 'Sale should clear mortgageBalance in property state');
  assert.strictEqual(saleStateDiff.after, 0, 'mortgageBalance should be 0 after sale');
});

// ══════════════════════════════════════════════════════════════════════════════
// AU Mortgage Payment Tests
// ══════════════════════════════════════════════════════════════════════════════

test('Mortgage-AU-1: Monthly AU mortgage payments are made each month while mortgageBalance > 0 and monthlyMortgage > 0', () => {
  const { sim } = loadToolsetScenario(makeAuConfig({
    mortgageBalance: 10_000,
    monthlyMortgage: 2_000,
    simStart: '2026-01-01',
    simEnd:   '2028-01-01',
  }));

  const threeMonths = new Date(Date.UTC(2026, 2, 31));
  assert.doesNotThrow(() => sim.stepTo(threeMonths));

  const payments = sim.journal.getActions('AU_MORTGAGE_PAYMENT_APPLY');
  assert.ok(payments.length >= 3, `Expected at least 3 AU payments; got ${payments.length}`);

  const cashDiff = payments[0].stateDiff.find(d => d.field === 'auSavingsAccount.balance');
  assert.ok(cashDiff, 'First AU payment should debit auSavingsAccount.balance');
  assert.strictEqual(cashDiff.delta, -2_000, 'First AU payment should debit exactly 2000');
});

test('Mortgage-AU-2: The last AU mortgage payment does not overpay', () => {
  const { sim } = loadToolsetScenario(makeAuConfig({
    mortgageBalance: 3_000,
    monthlyMortgage: 2_000,
    simStart: '2026-01-01',
    simEnd:   '2028-01-01',
  }));

  const twoMonths = new Date(Date.UTC(2026, 1, 28));
  assert.doesNotThrow(() => sim.stepTo(twoMonths));

  const payments = sim.journal.getActions('AU_MORTGAGE_PAYMENT_APPLY');
  assert.strictEqual(payments.length, 2);

  const lastMortgageDiff = payments[1].stateDiff.find(d => d.field === 'auHouseProperty.mortgageBalance');
  assert.ok(lastMortgageDiff, 'Last AU payment should update auHouseProperty.mortgageBalance');
  assert.strictEqual(lastMortgageDiff.delta, -1_000, 'Last AU payment should only pay the remaining 1000');
  assert.strictEqual(lastMortgageDiff.after,      0, 'AU mortgage balance should reach zero');
});

test('Mortgage-AU-3: AU mortgage payments stop once mortgageBalance reaches zero', () => {
  const { sim } = loadToolsetScenario(makeAuConfig({
    mortgageBalance: 2_000,
    monthlyMortgage: 2_000,
    simStart: '2026-01-01',
    simEnd:   '2028-01-01',
  }));

  const threeMonths = new Date(Date.UTC(2026, 2, 31));
  assert.doesNotThrow(() => sim.stepTo(threeMonths));

  const payments = sim.journal.getActions('AU_MORTGAGE_PAYMENT_APPLY');
  assert.strictEqual(payments.length, 1, `Expected exactly 1 AU payment; got ${payments.length}`);

  const mortgageDiff = payments[0].stateDiff.find(d => d.field === 'auHouseProperty.mortgageBalance');
  assert.strictEqual(mortgageDiff.after, 0, 'AU mortgage balance should be zero after the single payment');
});

test('Mortgage-AU-4: AU mortgage payments stop after the house is sold', () => {
  const { sim } = loadToolsetScenario(makeAuConfig({
    mortgageBalance: 1_000_000,
    monthlyMortgage: 2_000,
    plannedSaleYear: 2026,
    simStart:        '2025-12-01',
    simEnd:          '2028-01-01',
  }));

  const endQ1_2026 = new Date(Date.UTC(2026, 2, 31));
  assert.doesNotThrow(() => sim.stepTo(endQ1_2026));

  const payments = sim.journal.getActions('AU_MORTGAGE_PAYMENT_APPLY');
  assert.strictEqual(payments.length, 1, `Expected 1 AU payment (Dec 2025 only); got ${payments.length}`);

  const saleActions = sim.journal.getActions('AU_HOUSE_SALE_APPLY');
  assert.ok(saleActions.length > 0, 'AU house sale should have been applied');
  const saleStateDiff = saleActions[0].stateDiff.find(d => d.field === 'auHouseProperty.mortgageBalance');
  assert.ok(saleStateDiff, 'AU sale should clear mortgageBalance in property state');
  assert.strictEqual(saleStateDiff.after, 0, 'AU mortgageBalance should be 0 after sale');
});

// ══════════════════════════════════════════════════════════════════════════════
// REPLENISH_SAVINGS Guard Tests
// ══════════════════════════════════════════════════════════════════════════════

test('Mortgage-US-5: REPLENISH_SAVINGS is dispatched and US savings account never goes negative when balance is insufficient', () => {
  // Cash account starts at $500 — less than the $2000 monthly payment.
  // The handler must prepend REPLENISH_SAVINGS so the drawdown machinery gets a
  // chance to top up the account before the debit fires.  Even if replenishment
  // cannot fully cover the deficit (no other accounts in this lean scenario),
  // the reducer caps the debit to the available balance so the account stays >= 0.
  const { sim } = loadToolsetScenario(makeUsConfig({
    mortgageBalance: 10_000,
    monthlyMortgage:  2_000,
    initialBalance:     500,  // far less than one monthly payment
    minimumBalance:       0,
    simStart: '2026-01-01',
    simEnd:   '2028-01-01',
  }));

  const firstMonthEnd = new Date(Date.UTC(2026, 0, 31));
  assert.doesNotThrow(() => sim.stepTo(firstMonthEnd));

  // REPLENISH_SAVINGS must have been dispatched before the payment
  const replenishActions = sim.journal.getActions('REPLENISH_SAVINGS');
  assert.ok(replenishActions.length > 0, 'REPLENISH_SAVINGS should be dispatched when balance is insufficient');

  // The debit must not take the account negative
  assert.ok(sim.state.usSavingsAccount.balance >= 0, 'US savings account must not go below zero');

  // A payment action was still attempted
  const payments = sim.journal.getActions('US_MORTGAGE_PAYMENT_APPLY');
  assert.ok(payments.length > 0, 'A US mortgage payment action should still have been dispatched');
});

test('Mortgage-AU-5: REPLENISH_SAVINGS is dispatched and AU savings account never goes negative when balance is insufficient', () => {
  // Same scenario for AU: account starts at $500, monthly payment is $2000.
  const { sim } = loadToolsetScenario(makeAuConfig({
    mortgageBalance: 10_000,
    monthlyMortgage:  2_000,
    initialBalance:     500,
    minimumBalance:       0,
    simStart: '2026-01-01',
    simEnd:   '2028-01-01',
  }));

  const firstMonthEnd = new Date(Date.UTC(2026, 0, 31));
  assert.doesNotThrow(() => sim.stepTo(firstMonthEnd));

  const replenishActions = sim.journal.getActions('REPLENISH_SAVINGS');
  assert.ok(replenishActions.length > 0, 'REPLENISH_SAVINGS should be dispatched when AU balance is insufficient');

  assert.ok(sim.state.auSavingsAccount.balance >= 0, 'AU savings account must not go below zero');

  const payments = sim.journal.getActions('AU_MORTGAGE_PAYMENT_APPLY');
  assert.ok(payments.length > 0, 'An AU mortgage payment action should still have been dispatched');
});
