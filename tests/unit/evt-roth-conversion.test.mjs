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

import { Account }        from '../../src/finance/assets/account.js';
import { FinancialState } from '../../src/finance/state/financial-state.js';
import { Simulation }     from '../../src/simulation-framework/simulation.js';
import { TaxService }     from '../../src/finance/tax-service.js';
import { ServiceRegistry } from '../../src/services/service-registry.js';
import { PeriodService }  from '../../src/finance/period/period-service.js';
import { buildUsCalendarYear, applyTo } from '../../src/finance/period/period-builder.js';

beforeEach(() => ServiceRegistry.reset());

function buildUsPeriodService(year) {
  const ps = new PeriodService();
  applyTo(ps, buildUsCalendarYear(year));
  return ps;
}

const START_DATE = new Date(2026, 0, 1);

/**
 * Build a minimal conversion simulation.
 * Includes both iraAccount and rothAccount (and optional spouse accounts).
 */
function buildConversionSim({
  initialChecking         = 20_000,
  iraBalance              = 100_000,
  iraContribBasis         = 100_000,
  iraEarningsBasis        = 0,
  rothBalance             = 0,
  rolloverContribBasis    = 0,
  spouseIraBalance        = 0,
  spouseIraContribBasis   = 0,
  spouseRothBalance       = 0,
  spouseRolloverContrib   = 0,
  isAuResident            = false,
  usOrdinaryIncomeYTD     = 0,
} = {}) {
  const registry = ServiceRegistry.getInstance();
  const sim = new Simulation(START_DATE, {
    initialState: new FinancialState({
      checkingAccount: new Account(initialChecking),
      iraAccount: {
        balance:           iraBalance,
        contributionBasis: iraContribBasis,
        earningsBasis:     iraEarningsBasis,
      },
      rothAccount: {
        balance:              rothBalance,
        contributionBasis:    0,
        earningsBasis:        0,
        rolloverContribBasis,
        rolloverEarningsBasis: 0,
      },
      spouseIraAccount: {
        balance:           spouseIraBalance,
        contributionBasis: spouseIraContribBasis,
        earningsBasis:     0,
      },
      spouseRothAccount: {
        balance:               spouseRothBalance,
        contributionBasis:     0,
        earningsBasis:         0,
        rolloverContribBasis:  spouseRolloverContrib,
        rolloverEarningsBasis: 0,
      },
      isAuResident,
      usOrdinaryIncomeYTD,
      usNegativeIncomeYTD: 0,
      usCapitalGainsYTD:   0,
      usPenaltyYTD:        0,
      auOrdinaryIncomeYTD: 0,
      ftcYTD:              0,
    }),
  });
  registry.simulationRegistry.register('primary', sim);
  registry.simulationSync.setSimStart(START_DATE);
  const taxService = new TaxService();
  taxService.setup(sim, ['US'], buildUsPeriodService(2026));
  taxService.registerHandlersAndReducers(registry, ['US']);
  return { sim };
}

// ══════════════════════════════════════════════════════════════════════════════
// EVT-52: Roth Conversion — core mechanics
// ══════════════════════════════════════════════════════════════════════════════

test('EVT-52: Roth Conversion — IRA balance debited', () => {
  const { sim } = buildConversionSim({ iraBalance: 100_000, iraContribBasis: 100_000 });
  sim.schedule({ date: new Date(2026, 0, 15), type: 'ROTH_CONVERSION', data: { amount: 20_000 } });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.iraAccount.balance, 80_000);
  assert.strictEqual(sim.state.iraAccount.contributionBasis, 80_000);
});

test('EVT-52: Roth Conversion — Roth rolloverContribBasis credited', () => {
  const { sim } = buildConversionSim({ iraBalance: 100_000, iraContribBasis: 100_000 });
  sim.schedule({ date: new Date(2026, 0, 15), type: 'ROTH_CONVERSION', data: { amount: 20_000 } });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.rothAccount.balance, 20_000);
  assert.strictEqual(sim.state.rothAccount.rolloverContribBasis, 20_000);
  assert.strictEqual(sim.state.rothAccount.contributionBasis, 0); // regular basis unaffected
});

test('EVT-52: Roth Conversion — amount does NOT flow through cash pool', () => {
  const { sim } = buildConversionSim({ initialChecking: 10_000, iraBalance: 100_000, iraContribBasis: 100_000 });
  sim.schedule({ date: new Date(2026, 0, 15), type: 'ROTH_CONVERSION', data: { amount: 20_000 } });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.checkingAccount.balance, 10_000); // unchanged
});

test('EVT-52: Roth Conversion — US ordinary income recorded', () => {
  const { sim } = buildConversionSim({ iraBalance: 100_000, iraContribBasis: 100_000 });
  sim.schedule({ date: new Date(2026, 0, 15), type: 'ROTH_CONVERSION', data: { amount: 20_000 } });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.usOrdinaryIncomeYTD, 20_000);
});

test('EVT-52: Roth Conversion — AU ordinary income recorded when isAuResident', () => {
  const { sim } = buildConversionSim({ iraBalance: 100_000, iraContribBasis: 100_000, isAuResident: true });
  sim.schedule({ date: new Date(2026, 0, 15), type: 'ROTH_CONVERSION', data: { amount: 20_000 } });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.auOrdinaryIncomeYTD, 20_000);
  assert.strictEqual(sim.state.ftcYTD, 20_000);
});

test('EVT-52: Roth Conversion — no AU income when not resident', () => {
  const { sim } = buildConversionSim({ iraBalance: 100_000, iraContribBasis: 100_000, isAuResident: false });
  sim.schedule({ date: new Date(2026, 0, 15), type: 'ROTH_CONVERSION', data: { amount: 20_000 } });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.auOrdinaryIncomeYTD, 0);
  assert.strictEqual(sim.state.ftcYTD, 0);
});

test('EVT-52: Roth Conversion — no penalty', () => {
  const { sim } = buildConversionSim({ iraBalance: 100_000, iraContribBasis: 100_000 });
  sim.schedule({ date: new Date(2026, 0, 15), type: 'ROTH_CONVERSION', data: { amount: 20_000 } });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.usPenaltyYTD, 0);
});

test('EVT-52: Roth Conversion — debit draws from contributionBasis first then earningsBasis', () => {
  const { sim } = buildConversionSim({ iraBalance: 100_000, iraContribBasis: 60_000, iraEarningsBasis: 40_000 });
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
  const { sim } = buildConversionSim({
    spouseIraBalance:      50_000,
    spouseIraContribBasis: 50_000,
  });
  sim.schedule({
    date: new Date(2026, 0, 15),
    type: 'ROTH_CONVERSION',
    data: { amount: 15_000, owner: 'spouse' },
  });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.spouseIraAccount.balance, 35_000);
  assert.strictEqual(sim.state.spouseRothAccount.balance, 15_000);
  assert.strictEqual(sim.state.spouseRothAccount.rolloverContribBasis, 15_000);
  assert.strictEqual(sim.state.iraAccount.balance, 100_000);  // primary IRA untouched (default 100k)
  assert.strictEqual(sim.state.rothAccount.balance, 0);       // primary Roth untouched
});

test('EVT-52: Roth Conversion — spouse conversion records US ordinary income', () => {
  const { sim } = buildConversionSim({
    spouseIraBalance:      50_000,
    spouseIraContribBasis: 50_000,
  });
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
  const { sim } = buildConversionSim({ iraBalance: 10_000, iraContribBasis: 10_000 });
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
  const { sim } = buildConversionSim({
    iraBalance:         100_000,
    iraContribBasis:    100_000,
    usOrdinaryIncomeYTD: 60_000,
  });
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
  const { sim } = buildConversionSim({
    iraBalance:          100_000,
    iraContribBasis:     100_000,
    usOrdinaryIncomeYTD: 30_000,
  });
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
  const { sim } = buildConversionSim({
    iraBalance:          8_000,
    iraContribBasis:     8_000,
    usOrdinaryIncomeYTD: 30_000,
  });
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
  const { sim } = buildConversionSim({
    spouseIraBalance:     40_000,
    spouseIraContribBasis: 40_000,
    usOrdinaryIncomeYTD:  30_000,
  });
  sim.schedule({
    date: new Date(2026, 6, 1),
    type: 'ROTH_CONVERSION_POLICY_EVALUATE',
    data: { targetIncome: 50_000, iraKey: 'spouseIraAccount', rothKey: 'spouseRothAccount' },
  });
  sim.stepTo(new Date(2026, 6, 30));

  assert.strictEqual(sim.state.spouseIraAccount.balance, 20_000);   // 40k - 20k
  assert.strictEqual(sim.state.spouseRothAccount.balance, 20_000);
  assert.strictEqual(sim.state.usOrdinaryIncomeYTD, 50_000);
  assert.strictEqual(sim.state.iraAccount.balance, 100_000);        // primary untouched (default 100k)
});

test('Bracket-fill policy — no actions when IRA balance is zero', () => {
  const { sim } = buildConversionSim({
    iraBalance:          0,
    iraContribBasis:     0,
    usOrdinaryIncomeYTD: 30_000,
  });
  sim.schedule({
    date: new Date(2026, 6, 1),
    type: 'ROTH_CONVERSION_POLICY_EVALUATE',
    data: { targetIncome: 50_000, iraKey: 'iraAccount', rothKey: 'rothAccount' },
  });
  sim.stepTo(new Date(2026, 6, 30));

  assert.strictEqual(sim.state.rothAccount.balance, 0);
  assert.strictEqual(sim.state.usOrdinaryIncomeYTD, 30_000);        // unchanged
});
