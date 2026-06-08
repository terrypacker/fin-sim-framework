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
 * evt-roth-conversion.test.mjs
 * Tests for EVT-52: Roth Conversion (IRA → Roth, direct transfer, bracket-fill policy)
 *
 * EVT-52  Roth Conversion  −IRA, +Roth rolloverContribBasis  US: ordinary income  AU: ordinary income if resident  No penalty
 *
 * Run with: node --test tests/unit/evt-roth-conversion.test.mjs
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

/**
 * Build a Roth conversion scenario config.
 * Includes primary and spouse accounts so both conversion directions can be tested.
 * Uses US_RETIREMENT + AU_RETIREMENT + US_ROTH_CONVERSION + US_AU_CROSS_BORDER.
 */
function makeConversionConfig({
  initialChecking        = 20_000,
  initialAuSavings       = 50_000,
  iraBalance             = 100_000,
  iraContribBasis        = 100_000,
  iraEarningsBasis       = 0,
  rothBalance            = 0,
  rolloverContribBasis   = 0,
  spouseIraBalance       = 0,
  spouseIraContribBasis  = 0,
  spouseRothBalance      = 0,
  spouseRolloverContrib  = 0,
  isAuResident           = false,
  rothGrowthRate         = 0,
  iraGrowthRate          = 0,
} = {}) {
  return {
    toolsets: ['US_RETIREMENT', 'AU_RETIREMENT', 'US_ROTH_CONVERSION', 'US_AU_CROSS_BORDER'],
    simStart: '2026-01-01',
    simEnd:   '2028-01-01',
    parameters: {
      monthlyExpenses: 0, inflationAdjust: false, inflationRate: 0,
      rothGrowthRate, iraGrowthRate, k401GrowthRate: 0,
      brokerageGrowthRate: 0, brokerageDividendRate: 0, fixedIncomeInterestRate: 0,
      usSavingsInterestRate: 0, auSavingsInterestRate: 0,
      superGrowthRate: 0, auStockGrowthRate: 0, auStockDividendRate: 0,
      rothConversionEnabled: false,
      isAuResident,
    },
    persons: [
      {
        __type: 'Person', id: 'primary', name: 'Primary', birthDate: '1966-01-01',
        citizen: ['US'], lifeExpectancy: 90, monthlyWage: 0,
        retirementDate: '2025-01-01', socialSecurityMonthly: 0,
      },
      {
        __type: 'Person', id: 'spouse', name: 'Spouse', birthDate: '1968-01-01',
        citizen: ['US'], lifeExpectancy: 90, monthlyWage: 0,
        retirementDate: '2030-01-01', socialSecurityMonthly: 0,
      },
    ],
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
        __type: 'TraditionalIRAAccount', id: 'ira', name: 'IRA',
        role: 'ira', stateKey: 'iraAccount',
        initialValue: iraBalance, contributionBasis: iraContribBasis,
        earningsBasis: iraEarningsBasis,
        ownershipType: 'sole', ownerId: 'primary',
        country: 'US', currency: { code: 'USD', symbol: '$' },
      },
      {
        __type: 'RothAccount', id: 'roth', name: 'Roth IRA',
        role: 'roth-ira', stateKey: 'rothAccount',
        initialValue: rothBalance, contributionBasis: 0, earningsBasis: 0,
        rolloverContribBasis, rolloverEarningsBasis: 0,
        ownershipType: 'sole', ownerId: 'primary',
        country: 'US', currency: { code: 'USD', symbol: '$' },
      },
      {
        __type: 'TraditionalIRAAccount', id: 'spouse-ira', name: 'Spouse IRA',
        role: 'ira', stateKey: 'spouseIraAccount',
        initialValue: spouseIraBalance, contributionBasis: spouseIraContribBasis,
        earningsBasis: 0,
        ownershipType: 'sole', ownerId: 'spouse',
        country: 'US', currency: { code: 'USD', symbol: '$' },
      },
      {
        __type: 'RothAccount', id: 'spouse-roth', name: 'Spouse Roth IRA',
        role: 'roth-ira', stateKey: 'spouseRothAccount',
        initialValue: spouseRothBalance, contributionBasis: 0, earningsBasis: 0,
        rolloverContribBasis: spouseRolloverContrib, rolloverEarningsBasis: 0,
        ownershipType: 'sole', ownerId: 'spouse',
        country: 'US', currency: { code: 'USD', symbol: '$' },
      },
    ],
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// EVT-52: Roth Conversion — core mechanics
// ══════════════════════════════════════════════════════════════════════════════

test('EVT-52: Roth Conversion — IRA balance debited', () => {
  const { sim } = loadToolsetScenario(makeConversionConfig({ iraBalance: 100_000, iraContribBasis: 100_000 }));
  sim.schedule({ date: new Date(2026, 0, 15), type: 'ROTH_CONVERSION', data: { amount: 20_000 } });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.iraAccount.balance, 80_000);
  assert.strictEqual(sim.state.iraAccount.contributionBasis, 80_000);
});

test('EVT-52: Roth Conversion — Roth rolloverContribBasis credited', () => {
  const { sim } = loadToolsetScenario(makeConversionConfig({ iraBalance: 100_000, iraContribBasis: 100_000 }));
  sim.schedule({ date: new Date(2026, 0, 15), type: 'ROTH_CONVERSION', data: { amount: 20_000 } });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.rothAccount.balance, 20_000);
  assert.strictEqual(sim.state.rothAccount.rolloverContribBasis, 20_000);
  assert.strictEqual(sim.state.rothAccount.contributionBasis, 0); // regular basis unaffected
});

test('EVT-52: Roth Conversion — amount does NOT flow through cash pool', () => {
  const { sim } = loadToolsetScenario(makeConversionConfig({ initialChecking: 10_000, iraBalance: 100_000, iraContribBasis: 100_000 }));
  sim.schedule({ date: new Date(2026, 0, 15), type: 'ROTH_CONVERSION', data: { amount: 20_000 } });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.checkingAccount.balance, 10_000); // unchanged
});

test('EVT-52: Roth Conversion — US ordinary income recorded', () => {
  const { sim } = loadToolsetScenario(makeConversionConfig({ iraBalance: 100_000, iraContribBasis: 100_000 }));
  sim.schedule({ date: new Date(2026, 0, 15), type: 'ROTH_CONVERSION', data: { amount: 20_000 } });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.usOrdinaryIncomeYTD, 20_000);
});

test('EVT-52: Roth Conversion — AU ordinary income recorded when isAuResident', () => {
  const { sim } = loadToolsetScenario(makeConversionConfig({ iraBalance: 100_000, iraContribBasis: 100_000, isAuResident: true }));
  sim.schedule({ date: new Date(2026, 0, 15), type: 'ROTH_CONVERSION', data: { amount: 20_000 } });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.auOrdinaryIncomeYTD, 20_000);
  assert.strictEqual(sim.state.ftcYTD, 20_000);
});

test('EVT-52: Roth Conversion — no AU income when not resident', () => {
  const { sim } = loadToolsetScenario(makeConversionConfig({ iraBalance: 100_000, iraContribBasis: 100_000, isAuResident: false }));
  sim.schedule({ date: new Date(2026, 0, 15), type: 'ROTH_CONVERSION', data: { amount: 20_000 } });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.auOrdinaryIncomeYTD, 0);
  assert.strictEqual(sim.state.ftcYTD, 0);
});

test('EVT-52: Roth Conversion — no penalty', () => {
  const { sim } = loadToolsetScenario(makeConversionConfig({ iraBalance: 100_000, iraContribBasis: 100_000 }));
  sim.schedule({ date: new Date(2026, 0, 15), type: 'ROTH_CONVERSION', data: { amount: 20_000 } });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.usPenaltyYTD, 0);
});

test('EVT-52: Roth Conversion — debit draws from contributionBasis first then earningsBasis', () => {
  const { sim } = loadToolsetScenario(makeConversionConfig({ iraBalance: 100_000, iraContribBasis: 60_000, iraEarningsBasis: 40_000 }));
  sim.schedule({ date: new Date(2026, 0, 15), type: 'ROTH_CONVERSION', data: { amount: 70_000 } });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.iraAccount.contributionBasis, 0);       // 60k exhausted
  assert.strictEqual(sim.state.iraAccount.earningsBasis, 30_000);      // 40k - 10k remainder
  assert.strictEqual(sim.state.iraAccount.balance, 30_000);
});

// ══════════════════════════════════════════════════════════════════════════════
// EVT-52: Spouse account routing
// ══════════════════════════════════════════════════════════════════════════════

test('EVT-52: Roth Conversion — spouse IRA debited, spouse Roth credited', () => {
  const { sim } = loadToolsetScenario(makeConversionConfig({
    spouseIraBalance:      50_000,
    spouseIraContribBasis: 50_000,
  }));
  sim.schedule({
    date: new Date(2026, 0, 15),
    type: 'ROTH_CONVERSION',
    data: { amount: 15_000, owner: 'spouse' },
  });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.spouseIraAccount.balance, 35_000);
  assert.strictEqual(sim.state.spouseRothAccount.balance, 15_000);
  assert.strictEqual(sim.state.spouseRothAccount.rolloverContribBasis, 15_000);
  assert.strictEqual(sim.state.iraAccount.balance, 100_000);  // primary IRA untouched
  assert.strictEqual(sim.state.rothAccount.balance, 0);       // primary Roth untouched
});

test('EVT-52: Roth Conversion — spouse conversion records US ordinary income', () => {
  const { sim } = loadToolsetScenario(makeConversionConfig({
    spouseIraBalance:      50_000,
    spouseIraContribBasis: 50_000,
  }));
  sim.schedule({
    date: new Date(2026, 0, 15),
    type: 'ROTH_CONVERSION',
    data: { amount: 15_000, owner: 'spouse' },
  });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.usOrdinaryIncomeYTD, 15_000);
});

// ══════════════════════════════════════════════════════════════════════════════
// EVT-52: Validation
// ══════════════════════════════════════════════════════════════════════════════

test('EVT-52: Roth Conversion — throws when amount exceeds IRA balance', () => {
  const { sim } = loadToolsetScenario(makeConversionConfig({ iraBalance: 10_000, iraContribBasis: 10_000 }));
  sim.schedule({ date: new Date(2026, 0, 15), type: 'ROTH_CONVERSION', data: { amount: 20_000 } });

  assert.throws(
    () => sim.stepTo(new Date(2026, 0, 31)),
    /RothConversion: requested 20000 exceeds iraAccount balance 10000/
  );
});

// ══════════════════════════════════════════════════════════════════════════════
// Bracket-fill policy
// ══════════════════════════════════════════════════════════════════════════════

test('Bracket-fill policy — converts nothing when usOrdinaryIncomeYTD >= targetIncome', () => {
  const { sim } = loadToolsetScenario(makeConversionConfig({
    iraBalance:      100_000,
    iraContribBasis: 100_000,
  }));
  // Pre-load ordinary income to 60k so it exceeds the 50k target
  sim.schedule({ date: new Date(2026, 0, 15), type: 'WAGES_INCOME', data: { amount: 60_000 } });
  sim.schedule({
    date: new Date(2026, 6, 1),
    type: 'ROTH_CONVERSION_POLICY_EVALUATE',
    data: { targetIncome: 50_000, iraKey: 'iraAccount', rothKey: 'rothAccount' },
  });
  sim.stepTo(new Date(2026, 6, 30));

  assert.strictEqual(sim.state.iraAccount.balance, 100_000);   // unchanged
  assert.strictEqual(sim.state.rothAccount.balance, 0);
  assert.strictEqual(sim.state.usOrdinaryIncomeYTD, 60_000);
});

test('Bracket-fill policy — converts exactly the bracket room when IRA has enough', () => {
  const { sim } = loadToolsetScenario(makeConversionConfig({
    iraBalance:      100_000,
    iraContribBasis: 100_000,
  }));
  // Pre-load 30k income; policy will fill up to 50k → converts 20k
  sim.schedule({ date: new Date(2026, 0, 15), type: 'WAGES_INCOME', data: { amount: 30_000 } });
  sim.schedule({
    date: new Date(2026, 6, 1),
    type: 'ROTH_CONVERSION_POLICY_EVALUATE',
    data: { targetIncome: 50_000, iraKey: 'iraAccount', rothKey: 'rothAccount' },
  });
  sim.stepTo(new Date(2026, 6, 30));

  assert.strictEqual(sim.state.iraAccount.balance, 80_000);    // 100k - 20k
  assert.strictEqual(sim.state.rothAccount.balance, 20_000);
  assert.strictEqual(sim.state.usOrdinaryIncomeYTD, 50_000);   // 30k + 20k
});

test('Bracket-fill policy — converts IRA balance when less than bracket room', () => {
  const { sim } = loadToolsetScenario(makeConversionConfig({
    iraBalance:      8_000,
    iraContribBasis: 8_000,
  }));
  // Pre-load 30k income; room = 20k but IRA only has 8k → converts 8k
  sim.schedule({ date: new Date(2026, 0, 15), type: 'WAGES_INCOME', data: { amount: 30_000 } });
  sim.schedule({
    date: new Date(2026, 6, 1),
    type: 'ROTH_CONVERSION_POLICY_EVALUATE',
    data: { targetIncome: 50_000, iraKey: 'iraAccount', rothKey: 'rothAccount' },
  });
  sim.stepTo(new Date(2026, 6, 30));

  assert.strictEqual(sim.state.iraAccount.balance, 0);          // fully converted
  assert.strictEqual(sim.state.rothAccount.balance, 8_000);
  assert.strictEqual(sim.state.usOrdinaryIncomeYTD, 38_000);    // 30k + 8k
});

test('Bracket-fill policy — spouse conversion uses spouseIraAccount', () => {
  const { sim } = loadToolsetScenario(makeConversionConfig({
    spouseIraBalance:      40_000,
    spouseIraContribBasis: 40_000,
  }));
  // Pre-load 30k income; room = 20k, spouse IRA has 40k → converts 20k
  sim.schedule({ date: new Date(2026, 0, 15), type: 'WAGES_INCOME', data: { amount: 30_000 } });
  sim.schedule({
    date: new Date(2026, 6, 1),
    type: 'ROTH_CONVERSION_POLICY_EVALUATE',
    data: { targetIncome: 50_000, iraKey: 'spouseIraAccount', rothKey: 'spouseRothAccount' },
  });
  sim.stepTo(new Date(2026, 6, 30));

  assert.strictEqual(sim.state.spouseIraAccount.balance, 20_000);   // 40k - 20k
  assert.strictEqual(sim.state.spouseRothAccount.balance, 20_000);
  assert.strictEqual(sim.state.usOrdinaryIncomeYTD, 50_000);
  assert.strictEqual(sim.state.iraAccount.balance, 100_000);        // primary untouched
});

test('Bracket-fill policy — no actions when IRA balance is zero', () => {
  const { sim } = loadToolsetScenario(makeConversionConfig({
    iraBalance:      0,
    iraContribBasis: 0,
  }));
  // Pre-load 30k income; IRA is empty so nothing converts
  sim.schedule({ date: new Date(2026, 0, 15), type: 'WAGES_INCOME', data: { amount: 30_000 } });
  sim.schedule({
    date: new Date(2026, 6, 1),
    type: 'ROTH_CONVERSION_POLICY_EVALUATE',
    data: { targetIncome: 50_000, iraKey: 'iraAccount', rothKey: 'rothAccount' },
  });
  sim.stepTo(new Date(2026, 6, 30));

  assert.strictEqual(sim.state.rothAccount.balance, 0);
  assert.strictEqual(sim.state.usOrdinaryIncomeYTD, 30_000);        // unchanged
});

// ══════════════════════════════════════════════════════════════════════════════
// Holdings invariant (§4.4) — conversion must keep balance === Σ holdings.marketValue
// ══════════════════════════════════════════════════════════════════════════════

test('EVT-52: Roth conversion updates Roth holdings so subsequent earnings are not wiped', () => {
  // Regression: ROTH_CONVERSION_APPLY credited roth.balance but not roth.holdings.
  // When INTL_ROTH_EARNINGS fired next, computeHoldingsGrowth used stale holdings,
  // and _syncBalance then overwrote the balance, erasing the conversion amount.
  const { sim } = loadToolsetScenario(makeConversionConfig({
    iraBalance:    250_000, iraContribBasis: 250_000,
    rothBalance:   107_000, rolloverContribBasis: 107_000,
    rothGrowthRate: 0.07, iraGrowthRate: 0.07,
  }));

  // Convert 238k from IRA → Roth on 2026-12-01
  sim.schedule({
    date: new Date(2026, 11, 1),
    type: 'ROTH_CONVERSION',
    data: { amount: 238_000, owner: 'primary' },
  });

  // Step through a full year-end earnings cycle
  sim.stepTo(new Date(2027, 0, 1));

  // Roth balance must include the 238k rollover (not be reset to pre-conversion value).
  assert.ok(sim.state.rothAccount.balance > 107_000 + 238_000 - 1,
    'Roth balance must retain the conversion amount after year-end earnings');

  // IRA holdings must match IRA balance (invariant check).
  const iraHoldings = sim.state.iraAccount.holdings ?? [];
  const iraSum = iraHoldings.reduce((s, h) => s + (h?.marketValue ?? 0), 0);
  assert.ok(Math.abs(iraSum - sim.state.iraAccount.balance) < 1,
    `IRA holdings sum ${iraSum} must match IRA balance ${sim.state.iraAccount.balance}`);
});
