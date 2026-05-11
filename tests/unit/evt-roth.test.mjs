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

import { Account } from '../../src/finance/assets/account.js';
import { FinancialState } from '../../src/finance/state/financial-state.js';
import { Simulation } from '../../src/simulation-framework/simulation.js';
import { TaxService } from '../../src/finance/tax-service.js';
import { ServiceRegistry } from '../../src/services/service-registry.js';
import { PeriodService } from '../../src/finance/period/period-service.js';
import { buildUsCalendarYear, applyTo } from '../../src/finance/period/period-builder.js';

beforeEach(() => ServiceRegistry.reset());

function buildUsPeriodService(year) {
  const ps = new PeriodService();
  applyTo(ps, buildUsCalendarYear(year));
  return ps;
}

const START_DATE = new Date(2026, 0, 1);

/**
 * Build a minimal Roth simulation.
 * @param {object} opts
 * @param {number}  opts.initialChecking   - Starting checking balance (default 20000)
 * @param {number}  opts.rothBalance       - Starting Roth total balance (default 0)
 * @param {number}  opts.rothContribBasis  - Starting Roth contribution basis (default 0)
 * @param {number}  opts.rothEarningsBasis - Starting Roth earnings basis (default 0)
 * @param {boolean} opts.isAuResident      - AU residency flag (default false)
 * @param {Date}    opts.personBirthDate   - Birth date for age checks
 */
function buildRothSim({
  initialChecking        = 20000,
  rothBalance            = 0,
  rothContribBasis       = 0,
  rothEarningsBasis      = 0,
  rolloverContribBasis   = 0,
  rolloverEarningsBasis  = 0,
  isAuResident           = false,
  personBirthDate        = new Date(1966, 0, 1),   // age 60 on 2026-01-01 (>= 59.5, no penalty)
} = {}) {
  const registry = ServiceRegistry.getInstance();
  const sim = new Simulation(START_DATE, { initialState: new FinancialState({
    checkingAccount:  new Account(initialChecking),
    rothAccount: {
      balance:               rothBalance,
      contributionBasis:     rothContribBasis,
      earningsBasis:         rothEarningsBasis,
      rolloverContribBasis,
      rolloverEarningsBasis,
    },
    isAuResident,
    personBirthDate,
    usOrdinaryIncomeYTD: 0,
    usNegativeIncomeYTD: 0,
    usCapitalGainsYTD:   0,
    usPenaltyYTD:        0,
    auOrdinaryIncomeYTD: 0,
    ftcYTD:              0,
  }) });
  registry.simulationRegistry.register('primary', sim);
  registry.simulationSync.setSimStart(START_DATE);
  const taxService = new TaxService();
  taxService.setup(sim, ['US'], buildUsPeriodService(2026));
  taxService.registerHandlersAndReducers(registry, ['US']);

  return { sim };
}

// ══════════════════════════════════════════════════════════════════════════════
// EVT-1: Roth Contribution
// ══════════════════════════════════════════════════════════════════════════════

test('EVT-1: Roth contribution increases rothAccount balance and contributionBasis', () => {
  const { sim } = buildRothSim({ initialChecking: 10000 });
  sim.schedule({ date: new Date(2026, 0, 15), type: 'ROTH_CONTRIBUTION', data: { amount: 5000 } });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.rothAccount.balance, 5000);
  assert.strictEqual(sim.state.rothAccount.contributionBasis, 5000);
  assert.strictEqual(sim.state.rothAccount.earningsBasis, 0);
});

test('EVT-1: Roth contribution debits checking account', () => {
  const { sim } = buildRothSim({ initialChecking: 10000 });
  sim.schedule({ date: new Date(2026, 0, 15), type: 'ROTH_CONTRIBUTION', data: { amount: 5000 } });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.checkingAccount.balance, 5000);
});

test('EVT-1: Roth contribution is not a US or AU taxable event', () => {
  const { sim } = buildRothSim({ initialChecking: 10000, isAuResident: true });
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
  const { sim } = buildRothSim({
    initialChecking: 5000,
    rothBalance: 10000,
    rothContribBasis: 10000,
  });
  sim.schedule({ date: new Date(2026, 0, 15), type: 'ROTH_WITHDRAWAL_CONTRIBUTIONS', data: { amount: 3000 } });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.checkingAccount.balance, 8000);
  assert.strictEqual(sim.state.rothAccount.balance, 7000);
  assert.strictEqual(sim.state.rothAccount.contributionBasis, 7000);
});

test('EVT-2: Roth contribution withdrawal has no age restriction (person under 59.5)', () => {
  // Person born 1990 — only 36 years old in 2026
  const { sim } = buildRothSim({
    initialChecking: 5000,
    rothBalance: 10000,
    rothContribBasis: 10000,
    personBirthDate: new Date(1990, 0, 1),
  });
  sim.schedule({ date: new Date(2026, 0, 15), type: 'ROTH_WITHDRAWAL_CONTRIBUTIONS', data: { amount: 3000 } });
  sim.stepTo(new Date(2026, 0, 31));

  // No penalty — contributions can always be withdrawn
  assert.strictEqual(sim.state.checkingAccount.balance, 8000);
  assert.strictEqual(sim.state.usPenaltyYTD, 0);
});

test('EVT-2: Roth contribution withdrawal is not a US or AU taxable event', () => {
  const { sim } = buildRothSim({
    initialChecking: 5000,
    rothBalance: 10000,
    rothContribBasis: 10000,
    isAuResident: true,
  });
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
  const { sim } = buildRothSim({
    initialChecking: 5000,
    rothBalance: 10000,
    rothEarningsBasis: 10000,
    personBirthDate: new Date(1966, 0, 1),
  });
  sim.schedule({ date: new Date(2026, 1, 1), type: 'ROTH_WITHDRAWAL_EARNINGS', data: { amount: 4000 } });
  sim.stepTo(new Date(2026, 1, 28));

  assert.strictEqual(sim.state.usPenaltyYTD, 0);
  assert.strictEqual(sim.state.checkingAccount.balance, 9000); // 5000 + 4000
  assert.strictEqual(sim.state.rothAccount.balance, 6000);
});

test('EVT-3: Roth earnings withdrawal before age 59.5 incurs 10% penalty', () => {
  // Person born 1990 — age 36 in 2026
  const { sim } = buildRothSim({
    initialChecking: 5000,
    rothBalance: 10000,
    rothEarningsBasis: 10000,
    personBirthDate: new Date(1990, 0, 1),
  });
  sim.schedule({ date: new Date(2026, 0, 15), type: 'ROTH_WITHDRAWAL_EARNINGS', data: { amount: 4000 } });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.usPenaltyYTD, 400);       // 10% of 4000
  assert.strictEqual(sim.state.checkingAccount.balance, 8600); // 5000 + 3600 net
});

test('EVT-3: Roth earnings withdrawal at exactly age 59.5 has no penalty', () => {
  // Born 1966-07-01: decimal age on 2026-01-01 ≈ 59.50 (>= 59.5 → no penalty)
  const { sim } = buildRothSim({
    initialChecking: 5000,
    rothBalance: 10000,
    rothEarningsBasis: 10000,
    personBirthDate: new Date(1966, 6, 1),
  });
  sim.schedule({ date: new Date(2026, 0, 15), type: 'ROTH_WITHDRAWAL_EARNINGS', data: { amount: 4000 } });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.usPenaltyYTD, 0);
  assert.strictEqual(sim.state.checkingAccount.balance, 9000); // full amount credited
});

test('EVT-3: Roth earnings withdrawal just before age 59.5 incurs 10% penalty', () => {
  // Born 1966-08-01: decimal age on 2026-01-01 ≈ 59.42 (< 59.5 → penalty)
  const { sim } = buildRothSim({
    initialChecking: 5000,
    rothBalance: 10000,
    rothEarningsBasis: 10000,
    personBirthDate: new Date(1966, 7, 1),
  });
  sim.schedule({ date: new Date(2026, 0, 15), type: 'ROTH_WITHDRAWAL_EARNINGS', data: { amount: 4000 } });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.usPenaltyYTD, 400);        // 10% of 4000
  assert.strictEqual(sim.state.checkingAccount.balance, 8600); // 5000 + 3600 net
});

test('EVT-3: Roth earnings withdrawal is NOT a US ordinary income taxable event', () => {
  const { sim } = buildRothSim({
    initialChecking: 5000,
    rothBalance: 10000,
    rothEarningsBasis: 10000,
    personBirthDate: new Date(1966, 0, 1),
  });
  sim.schedule({ date: new Date(2026, 1, 1), type: 'ROTH_WITHDRAWAL_EARNINGS', data: { amount: 4000 } });
  sim.stepTo(new Date(2026, 1, 28));

  assert.strictEqual(sim.state.usOrdinaryIncomeYTD, 0);
});

test('EVT-3: Roth earnings withdrawal IS AU taxable if person is AU resident', () => {
  const { sim } = buildRothSim({
    initialChecking: 5000,
    rothBalance: 10000,
    rothEarningsBasis: 10000,
    personBirthDate: new Date(1966, 0, 1),
    isAuResident: true,
  });
  sim.schedule({ date: new Date(2026, 1, 1), type: 'ROTH_WITHDRAWAL_EARNINGS', data: { amount: 4000 } });
  sim.stepTo(new Date(2026, 1, 28));

  assert.strictEqual(sim.state.auOrdinaryIncomeYTD, 4000);
  assert.ok(sim.state.ftcYTD > 0, 'FTC should be recorded when AU tax applies');
});

test('EVT-3: Roth earnings withdrawal is NOT AU taxable if person is NOT AU resident', () => {
  const { sim } = buildRothSim({
    initialChecking: 5000,
    rothBalance: 10000,
    rothEarningsBasis: 10000,
    personBirthDate: new Date(1966, 0, 1),
    isAuResident: false,
  });
  sim.schedule({ date: new Date(2026, 1, 1), type: 'ROTH_WITHDRAWAL_EARNINGS', data: { amount: 4000 } });
  sim.stepTo(new Date(2026, 1, 28));

  assert.strictEqual(sim.state.auOrdinaryIncomeYTD, 0);
  assert.strictEqual(sim.state.ftcYTD, 0);
});

// ══════════════════════════════════════════════════════════════════════════════
// EVT-4: Roth Earnings
// ══════════════════════════════════════════════════════════════════════════════

test('EVT-4: Roth earnings increase rothAccount balance and earningsBasis', () => {
  const { sim } = buildRothSim({
    rothBalance: 10000,
    rothContribBasis: 10000,
  });
  sim.schedule({ date: new Date(2026, 0, 15), type: 'ROTH_EARNINGS', data: { amount: 800 } });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.rothAccount.balance, 10800);
  assert.strictEqual(sim.state.rothAccount.earningsBasis, 800);
  assert.strictEqual(sim.state.rothAccount.contributionBasis, 10000); // unchanged
});

test('EVT-4: Roth earnings stay in account — no checking transaction', () => {
  const { sim } = buildRothSim({
    initialChecking: 5000,
    rothBalance: 10000,
    rothContribBasis: 10000,
  });
  sim.schedule({ date: new Date(2026, 0, 15), type: 'ROTH_EARNINGS', data: { amount: 800 } });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.checkingAccount.balance, 5000); // unchanged
});

test('EVT-4: Roth earnings are not a US or AU taxable event', () => {
  const { sim } = buildRothSim({
    rothBalance: 10000,
    rothContribBasis: 10000,
    isAuResident: true,
  });
  sim.schedule({ date: new Date(2026, 0, 15), type: 'ROTH_EARNINGS', data: { amount: 800 } });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.usOrdinaryIncomeYTD, 0);
  assert.strictEqual(sim.state.auOrdinaryIncomeYTD, 0);
});

// ══════════════════════════════════════════════════════════════════════════════
// EVT-41: Roth Rollover Contribution
// ══════════════════════════════════════════════════════════════════════════════

test('EVT-41: Roth rollover contribution increases balance and rolloverContribBasis', () => {
  const { sim } = buildRothSim({ initialChecking: 20000 });
  sim.schedule({ date: new Date(2026, 0, 15), type: 'ROTH_ROLLOVER_CONTRIBUTION', data: { amount: 10000 } });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.rothAccount.balance, 10000);
  assert.strictEqual(sim.state.rothAccount.rolloverContribBasis, 10000);
  assert.strictEqual(sim.state.rothAccount.contributionBasis, 0); // regular basis unaffected
});

test('EVT-41: Roth rollover contribution debits checking account', () => {
  const { sim } = buildRothSim({ initialChecking: 20000 });
  sim.schedule({ date: new Date(2026, 0, 15), type: 'ROTH_ROLLOVER_CONTRIBUTION', data: { amount: 10000 } });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.checkingAccount.balance, 10000);
});

test('EVT-41: Roth rollover contribution is not a US or AU taxable event', () => {
  const { sim } = buildRothSim({ initialChecking: 20000, isAuResident: true });
  sim.schedule({ date: new Date(2026, 0, 15), type: 'ROTH_ROLLOVER_CONTRIBUTION', data: { amount: 10000 } });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.usOrdinaryIncomeYTD, 0);
  assert.strictEqual(sim.state.auOrdinaryIncomeYTD, 0);
});

// ══════════════════════════════════════════════════════════════════════════════
// EVT-42: Roth Rollover Earnings
// ══════════════════════════════════════════════════════════════════════════════

test('EVT-42: Roth rollover earnings increase balance and rolloverEarningsBasis', () => {
  const { sim } = buildRothSim({
    rothBalance: 10000,
    rolloverContribBasis: 10000,
  });
  sim.schedule({ date: new Date(2026, 0, 15), type: 'ROTH_ROLLOVER_EARNINGS', data: { amount: 500 } });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.rothAccount.balance, 10500);
  assert.strictEqual(sim.state.rothAccount.rolloverEarningsBasis, 500);
  assert.strictEqual(sim.state.rothAccount.earningsBasis, 0); // regular earnings unaffected
});

test('EVT-42: Roth rollover earnings stay in account — no checking transaction', () => {
  const { sim } = buildRothSim({ initialChecking: 5000, rothBalance: 10000, rolloverContribBasis: 10000 });
  sim.schedule({ date: new Date(2026, 0, 15), type: 'ROTH_ROLLOVER_EARNINGS', data: { amount: 500 } });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.checkingAccount.balance, 5000);
});

test('EVT-42: Roth rollover earnings are not a US or AU taxable event', () => {
  const { sim } = buildRothSim({
    rothBalance: 10000,
    rolloverContribBasis: 10000,
    isAuResident: true,
  });
  sim.schedule({ date: new Date(2026, 0, 15), type: 'ROTH_ROLLOVER_EARNINGS', data: { amount: 500 } });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.usOrdinaryIncomeYTD, 0);
  assert.strictEqual(sim.state.auOrdinaryIncomeYTD, 0);
});

// ══════════════════════════════════════════════════════════════════════════════
// EVT-43: Roth Rollover Withdrawal – Contributions
// ══════════════════════════════════════════════════════════════════════════════

test('EVT-43: Roth rollover contribution withdrawal credits checking and reduces rolloverContribBasis', () => {
  const { sim } = buildRothSim({
    initialChecking: 5000,
    rothBalance: 10000,
    rolloverContribBasis: 10000,
  });
  sim.schedule({ date: new Date(2026, 0, 15), type: 'ROTH_ROLLOVER_WITHDRAWAL_CONTRIBUTIONS', data: { amount: 4000 } });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.checkingAccount.balance, 9000); // 5000 + 4000
  assert.strictEqual(sim.state.rothAccount.balance, 6000);
  assert.strictEqual(sim.state.rothAccount.rolloverContribBasis, 6000);
});

test('EVT-43: Roth rollover contribution withdrawal is not a US or AU taxable event', () => {
  const { sim } = buildRothSim({
    initialChecking: 5000,
    rothBalance: 10000,
    rolloverContribBasis: 10000,
    isAuResident: true,
  });
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
  const { sim } = buildRothSim({
    initialChecking: 5000,
    rothBalance: 10000,
    rolloverEarningsBasis: 10000,
  });
  sim.schedule({ date: new Date(2026, 0, 15), type: 'ROTH_ROLLOVER_WITHDRAWAL_EARNINGS', data: { amount: 3000 } });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.checkingAccount.balance, 8000); // 5000 + 3000
  assert.strictEqual(sim.state.rothAccount.balance, 7000);
  assert.strictEqual(sim.state.rothAccount.rolloverEarningsBasis, 7000);
});

test('EVT-44: Roth rollover earnings withdrawal has no US ordinary income or penalty', () => {
  const { sim } = buildRothSim({
    initialChecking: 5000,
    rothBalance: 10000,
    rolloverEarningsBasis: 10000,
    personBirthDate: new Date(1990, 0, 1), // under 60
  });
  sim.schedule({ date: new Date(2026, 0, 15), type: 'ROTH_ROLLOVER_WITHDRAWAL_EARNINGS', data: { amount: 3000 } });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.usOrdinaryIncomeYTD, 0);
  assert.strictEqual(sim.state.usPenaltyYTD, 0);
});

test('EVT-44: Roth rollover earnings withdrawal IS AU ordinary income if AU resident', () => {
  const { sim } = buildRothSim({
    initialChecking: 5000,
    rothBalance: 10000,
    rolloverEarningsBasis: 10000,
    isAuResident: true,
  });
  sim.schedule({ date: new Date(2026, 0, 15), type: 'ROTH_ROLLOVER_WITHDRAWAL_EARNINGS', data: { amount: 3000 } });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.auOrdinaryIncomeYTD, 3000);
  assert.ok(sim.state.ftcYTD > 0, 'FTC should be recorded for AU resident');
});

test('EVT-44: Roth rollover earnings withdrawal is NOT AU taxable if not AU resident', () => {
  const { sim } = buildRothSim({
    initialChecking: 5000,
    rothBalance: 10000,
    rolloverEarningsBasis: 10000,
    isAuResident: false,
  });
  sim.schedule({ date: new Date(2026, 0, 15), type: 'ROTH_ROLLOVER_WITHDRAWAL_EARNINGS', data: { amount: 3000 } });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.auOrdinaryIncomeYTD, 0);
  assert.strictEqual(sim.state.ftcYTD, 0);
});
