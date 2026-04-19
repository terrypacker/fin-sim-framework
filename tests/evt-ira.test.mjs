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
 * evt-ira.test.mjs
 * Tests for Traditional IRA events: EVT-5 through EVT-8
 *
 * EVT-5  IRA Contribution             +contribution  out of checking  US: negative income (deduction), no AU tax
 * EVT-6  IRA Withdrawal-Contributions -contribution  into checking    age 60 gate, 10% penalty before 60,
 *                                                                       US: ordinary income, no AU tax
 * EVT-7  IRA Withdrawal-Earnings      -earnings      into checking    age 60 gate, 10% penalty before 60,
 *                                                                       US: ordinary income, AU: ordinary if resident, FTC
 * EVT-8  IRA Earnings                 +earnings      stays in account no tax
 *
 * Run with: node --test tests/evt-ira.test.mjs
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import { Account } from '../src/finance/account.js';
import { Simulation } from '../src/simulation-framework/simulation.js';
import { TaxService } from '../src/finance/tax-service.js';
import { PeriodService } from '../src/finance/period/period-service.js';
import { buildUsCalendarYear, applyTo } from '../src/finance/period/period-builder.js';

function buildUsPeriodService(year) {
  const ps = new PeriodService();
  applyTo(ps, buildUsCalendarYear(year));
  return ps;
}

function buildIraSim({
  initialChecking   = 20000,
  iraBalance        = 0,
  iraContribBasis   = 0,
  iraEarningsBasis  = 0,
  isAuResident      = false,
  personBirthDate   = new Date(1966, 0, 1), // turns 60 on 2026-01-01
} = {}) {
  const initialState = {
    checkingAccount: new Account(initialChecking),
    iraAccount: {
      balance:           iraBalance,
      contributionBasis: iraContribBasis,
      earningsBasis:     iraEarningsBasis,
    },
    isAuResident,
    personBirthDate,
    usOrdinaryIncomeYTD: 0,
    usNegativeIncomeYTD: 0,
    usCapitalGainsYTD:   0,
    usPenaltyYTD:        0,
    auOrdinaryIncomeYTD: 0,
    ftcYTD:              0,
    metrics: {},
  };

  const sim = new Simulation(new Date(2026, 0, 1), { initialState });
  const svc = new TaxService().registerWith(sim, ['US'], buildUsPeriodService(2026));

  return { sim, svc };
}

// ══════════════════════════════════════════════════════════════════════════════
// EVT-5: IRA Contribution
// ══════════════════════════════════════════════════════════════════════════════

test('EVT-5: IRA contribution increases iraAccount balance and contributionBasis', () => {
  const { sim } = buildIraSim({ initialChecking: 10000 });
  sim.schedule({ date: new Date(2026, 0, 15), type: 'IRA_CONTRIBUTION', data: { amount: 6500 } });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.iraAccount.balance, 6500);
  assert.strictEqual(sim.state.iraAccount.contributionBasis, 6500);
  assert.strictEqual(sim.state.iraAccount.earningsBasis, 0);
});

test('EVT-5: IRA contribution debits checking account', () => {
  const { sim } = buildIraSim({ initialChecking: 10000 });
  sim.schedule({ date: new Date(2026, 0, 15), type: 'IRA_CONTRIBUTION', data: { amount: 6500 } });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.checkingAccount.balance, 3500);
});

test('EVT-5: IRA contribution is a US negative income (deduction) event', () => {
  const { sim } = buildIraSim({ initialChecking: 10000 });
  sim.schedule({ date: new Date(2026, 0, 15), type: 'IRA_CONTRIBUTION', data: { amount: 6500 } });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.usNegativeIncomeYTD, 6500);
  assert.strictEqual(sim.state.usOrdinaryIncomeYTD, 0);
});

test('EVT-5: IRA contribution is not an AU taxable event', () => {
  const { sim } = buildIraSim({ initialChecking: 10000, isAuResident: true });
  sim.schedule({ date: new Date(2026, 0, 15), type: 'IRA_CONTRIBUTION', data: { amount: 6500 } });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.auOrdinaryIncomeYTD, 0);
});

// ══════════════════════════════════════════════════════════════════════════════
// EVT-6: IRA Withdrawal — Contributions
// ══════════════════════════════════════════════════════════════════════════════

test('EVT-6: IRA contribution withdrawal at age 60+ has no penalty', () => {
  const { sim } = buildIraSim({
    initialChecking: 5000,
    iraBalance: 20000,
    iraContribBasis: 20000,
    personBirthDate: new Date(1966, 0, 1), // age 60 in 2026
  });
  sim.schedule({ date: new Date(2026, 1, 1), type: 'IRA_WITHDRAWAL_CONTRIBUTIONS', data: { amount: 5000 } });
  sim.stepTo(new Date(2026, 1, 28));

  assert.strictEqual(sim.state.usPenaltyYTD, 0);
  assert.strictEqual(sim.state.checkingAccount.balance, 10000);
});

test('EVT-6: IRA contribution withdrawal before age 60 incurs 10% penalty', () => {
  const { sim } = buildIraSim({
    initialChecking: 5000,
    iraBalance: 20000,
    iraContribBasis: 20000,
    personBirthDate: new Date(1990, 0, 1), // age 36 in 2026
  });
  sim.schedule({ date: new Date(2026, 0, 15), type: 'IRA_WITHDRAWAL_CONTRIBUTIONS', data: { amount: 5000 } });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.usPenaltyYTD, 500); // 10% of 5000
  assert.strictEqual(sim.state.checkingAccount.balance, 9500); // 5000 + 4500 net
});

test('EVT-6: IRA contribution withdrawal is US ordinary income taxable', () => {
  const { sim } = buildIraSim({
    initialChecking: 5000,
    iraBalance: 20000,
    iraContribBasis: 20000,
    personBirthDate: new Date(1966, 0, 1),
  });
  sim.schedule({ date: new Date(2026, 1, 1), type: 'IRA_WITHDRAWAL_CONTRIBUTIONS', data: { amount: 5000 } });
  sim.stepTo(new Date(2026, 1, 28));

  assert.strictEqual(sim.state.usOrdinaryIncomeYTD, 5000);
});

test('EVT-6: IRA contribution withdrawal is not AU taxable', () => {
  const { sim } = buildIraSim({
    initialChecking: 5000,
    iraBalance: 20000,
    iraContribBasis: 20000,
    isAuResident: true,
    personBirthDate: new Date(1966, 0, 1),
  });
  sim.schedule({ date: new Date(2026, 1, 1), type: 'IRA_WITHDRAWAL_CONTRIBUTIONS', data: { amount: 5000 } });
  sim.stepTo(new Date(2026, 1, 28));

  assert.strictEqual(sim.state.auOrdinaryIncomeYTD, 0);
});

// ══════════════════════════════════════════════════════════════════════════════
// EVT-7: IRA Withdrawal — Earnings
// ══════════════════════════════════════════════════════════════════════════════

test('EVT-7: IRA earnings withdrawal at age 60+ has no penalty', () => {
  const { sim } = buildIraSim({
    initialChecking: 5000,
    iraBalance: 20000,
    iraEarningsBasis: 20000,
    personBirthDate: new Date(1966, 0, 1),
  });
  sim.schedule({ date: new Date(2026, 1, 1), type: 'IRA_WITHDRAWAL_EARNINGS', data: { amount: 5000 } });
  sim.stepTo(new Date(2026, 1, 28));

  assert.strictEqual(sim.state.usPenaltyYTD, 0);
  assert.strictEqual(sim.state.checkingAccount.balance, 10000);
});

test('EVT-7: IRA earnings withdrawal before age 60 incurs 10% penalty', () => {
  const { sim } = buildIraSim({
    initialChecking: 5000,
    iraBalance: 20000,
    iraEarningsBasis: 20000,
    personBirthDate: new Date(1990, 0, 1),
  });
  sim.schedule({ date: new Date(2026, 0, 15), type: 'IRA_WITHDRAWAL_EARNINGS', data: { amount: 5000 } });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.usPenaltyYTD, 500);
});

test('EVT-7: IRA earnings withdrawal is US ordinary income taxable', () => {
  const { sim } = buildIraSim({
    initialChecking: 5000,
    iraBalance: 20000,
    iraEarningsBasis: 20000,
    personBirthDate: new Date(1966, 0, 1),
  });
  sim.schedule({ date: new Date(2026, 1, 1), type: 'IRA_WITHDRAWAL_EARNINGS', data: { amount: 5000 } });
  sim.stepTo(new Date(2026, 1, 28));

  assert.strictEqual(sim.state.usOrdinaryIncomeYTD, 5000);
});

test('EVT-7: IRA earnings withdrawal IS AU taxable if person is AU resident', () => {
  const { sim } = buildIraSim({
    initialChecking: 5000,
    iraBalance: 20000,
    iraEarningsBasis: 20000,
    personBirthDate: new Date(1966, 0, 1),
    isAuResident: true,
  });
  sim.schedule({ date: new Date(2026, 1, 1), type: 'IRA_WITHDRAWAL_EARNINGS', data: { amount: 5000 } });
  sim.stepTo(new Date(2026, 1, 28));

  assert.strictEqual(sim.state.auOrdinaryIncomeYTD, 5000);
  assert.ok(sim.state.ftcYTD > 0, 'FTC should be recorded when AU tax applies');
});

test('EVT-7: IRA earnings withdrawal is NOT AU taxable if person is not AU resident', () => {
  const { sim } = buildIraSim({
    initialChecking: 5000,
    iraBalance: 20000,
    iraEarningsBasis: 20000,
    personBirthDate: new Date(1966, 0, 1),
    isAuResident: false,
  });
  sim.schedule({ date: new Date(2026, 1, 1), type: 'IRA_WITHDRAWAL_EARNINGS', data: { amount: 5000 } });
  sim.stepTo(new Date(2026, 1, 28));

  assert.strictEqual(sim.state.auOrdinaryIncomeYTD, 0);
  assert.strictEqual(sim.state.ftcYTD, 0);
});

// ══════════════════════════════════════════════════════════════════════════════
// EVT-8: IRA Earnings
// ══════════════════════════════════════════════════════════════════════════════

test('EVT-8: IRA earnings increase iraAccount balance and earningsBasis', () => {
  const { sim } = buildIraSim({ iraBalance: 50000, iraContribBasis: 50000 });
  sim.schedule({ date: new Date(2026, 0, 15), type: 'IRA_EARNINGS', data: { amount: 3000 } });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.iraAccount.balance, 53000);
  assert.strictEqual(sim.state.iraAccount.earningsBasis, 3000);
  assert.strictEqual(sim.state.iraAccount.contributionBasis, 50000); // unchanged
});

test('EVT-8: IRA earnings stay in account — no checking transaction', () => {
  const { sim } = buildIraSim({ initialChecking: 5000, iraBalance: 50000, iraContribBasis: 50000 });
  sim.schedule({ date: new Date(2026, 0, 15), type: 'IRA_EARNINGS', data: { amount: 3000 } });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.checkingAccount.balance, 5000);
});

test('EVT-8: IRA earnings are not a US or AU taxable event', () => {
  const { sim } = buildIraSim({
    iraBalance: 50000,
    iraContribBasis: 50000,
    isAuResident: true,
  });
  sim.schedule({ date: new Date(2026, 0, 15), type: 'IRA_EARNINGS', data: { amount: 3000 } });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.usOrdinaryIncomeYTD, 0);
  assert.strictEqual(sim.state.auOrdinaryIncomeYTD, 0);
});
