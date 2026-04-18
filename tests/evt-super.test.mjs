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
 * evt-super.test.mjs
 * Tests for Superannuation events: EVT-20 through EVT-23
 *
 * EVT-20  Super Contribution          +contribution  out of checking  AU: always super tax (15%), no US tax, no FTC
 * EVT-21  Super Withdrawal-Contrib    -contribution  into checking    min age 60 (enforced, no numeric penalty),
 *                                                                       no US tax, no AU tax
 * EVT-22  Super Withdrawal-Earnings   -earnings      into checking    min age 60 (enforced),
 *                                                                       US: ordinary income, no AU tax
 * EVT-23  Super Earnings              +earnings      stays in account AU: always super tax, no US tax, no FTC
 *
 * Run with: node --test tests/evt-super.test.mjs
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import { Account } from '../assets/js/finance/account.js';
import { Simulation } from '../assets/js/simulation-framework/simulation.js';
import { TaxService } from '../assets/js/finance/tax-service.js';

function buildSuperSim({
  initialChecking    = 20000,
  superBalance       = 0,
  superContribBasis  = 0,
  superEarningsBasis = 0,
  personBirthDate    = new Date(1966, 0, 1), // turns 60 on 2026-01-01
} = {}) {
  const initialState = {
    checkingAccount: new Account(initialChecking),
    superAccount: {
      balance:           superBalance,
      contributionBasis: superContribBasis,
      earningsBasis:     superEarningsBasis,
    },
    personBirthDate,
    usOrdinaryIncomeYTD:    0,
    auSuperTaxYTD:          0,
    superWithdrawalBlocked: false,
    metrics: {},
  };

  const sim = new Simulation(new Date(2026, 0, 1), { initialState });
  const svc = new TaxService().registerWith(sim, ['AU'], 2026);

  return { sim, svc };
}

// ══════════════════════════════════════════════════════════════════════════════
// EVT-20: Superannuation Contribution
// ══════════════════════════════════════════════════════════════════════════════

test('EVT-20: Super contribution increases superAccount balance and contributionBasis', () => {
  const { sim } = buildSuperSim({ initialChecking: 10000 });
  sim.schedule({ date: new Date(2026, 0, 15), type: 'SUPER_CONTRIBUTION', data: { amount: 5000 } });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.superAccount.balance, 5000);
  assert.strictEqual(sim.state.superAccount.contributionBasis, 5000);
  assert.strictEqual(sim.state.superAccount.earningsBasis, 0);
});

test('EVT-20: Super contribution debits checking', () => {
  const { sim } = buildSuperSim({ initialChecking: 10000 });
  sim.schedule({ date: new Date(2026, 0, 15), type: 'SUPER_CONTRIBUTION', data: { amount: 5000 } });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.checkingAccount.balance, 5000);
});

test('EVT-20: Super contribution is always AU super taxable (15%)', () => {
  const { sim } = buildSuperSim({ initialChecking: 10000 });
  sim.schedule({ date: new Date(2026, 0, 15), type: 'SUPER_CONTRIBUTION', data: { amount: 5000 } });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.auSuperTaxYTD, 750); // 15% of 5000
});

test('EVT-20: Super contribution is not a US taxable event', () => {
  const { sim } = buildSuperSim({ initialChecking: 10000 });
  sim.schedule({ date: new Date(2026, 0, 15), type: 'SUPER_CONTRIBUTION', data: { amount: 5000 } });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.usOrdinaryIncomeYTD, 0);
});

// ══════════════════════════════════════════════════════════════════════════════
// EVT-21: Super Withdrawal — Contributions
// ══════════════════════════════════════════════════════════════════════════════

test('EVT-21: Super contribution withdrawal at age 60+ succeeds', () => {
  const { sim } = buildSuperSim({
    initialChecking: 5000,
    superBalance: 20000,
    superContribBasis: 20000,
    personBirthDate: new Date(1966, 0, 1), // age 60 in 2026
  });
  sim.schedule({ date: new Date(2026, 1, 1), type: 'SUPER_WITHDRAWAL_CONTRIBUTIONS', data: { amount: 5000 } });
  sim.stepTo(new Date(2026, 1, 28));

  assert.strictEqual(sim.state.superWithdrawalBlocked, false);
  assert.strictEqual(sim.state.checkingAccount.balance, 10000);
  assert.strictEqual(sim.state.superAccount.balance, 15000);
});

test('EVT-21: Super contribution withdrawal before age 60 is blocked', () => {
  const { sim } = buildSuperSim({
    initialChecking: 5000,
    superBalance: 20000,
    superContribBasis: 20000,
    personBirthDate: new Date(1990, 0, 1), // age 36 in 2026
  });
  sim.schedule({ date: new Date(2026, 0, 15), type: 'SUPER_WITHDRAWAL_CONTRIBUTIONS', data: { amount: 5000 } });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.superWithdrawalBlocked, true);
  assert.strictEqual(sim.state.checkingAccount.balance, 5000); // unchanged
  assert.strictEqual(sim.state.superAccount.balance, 20000);   // unchanged
});

test('EVT-21: Super contribution withdrawal has no US or AU tax', () => {
  const { sim } = buildSuperSim({
    initialChecking: 5000,
    superBalance: 20000,
    superContribBasis: 20000,
    personBirthDate: new Date(1966, 0, 1),
  });
  sim.schedule({ date: new Date(2026, 1, 1), type: 'SUPER_WITHDRAWAL_CONTRIBUTIONS', data: { amount: 5000 } });
  sim.stepTo(new Date(2026, 1, 28));

  assert.strictEqual(sim.state.usOrdinaryIncomeYTD, 0);
  assert.strictEqual(sim.state.auSuperTaxYTD, 0);
});

// ══════════════════════════════════════════════════════════════════════════════
// EVT-22: Super Withdrawal — Earnings
// ══════════════════════════════════════════════════════════════════════════════

test('EVT-22: Super earnings withdrawal at age 60+ succeeds', () => {
  const { sim } = buildSuperSim({
    initialChecking: 5000,
    superBalance: 20000,
    superEarningsBasis: 20000,
    personBirthDate: new Date(1966, 0, 1),
  });
  sim.schedule({ date: new Date(2026, 1, 1), type: 'SUPER_WITHDRAWAL_EARNINGS', data: { amount: 5000 } });
  sim.stepTo(new Date(2026, 1, 28));

  assert.strictEqual(sim.state.superWithdrawalBlocked, false);
  assert.strictEqual(sim.state.checkingAccount.balance, 10000);
});

test('EVT-22: Super earnings withdrawal before age 60 is blocked', () => {
  const { sim } = buildSuperSim({
    initialChecking: 5000,
    superBalance: 20000,
    superEarningsBasis: 20000,
    personBirthDate: new Date(1990, 0, 1),
  });
  sim.schedule({ date: new Date(2026, 0, 15), type: 'SUPER_WITHDRAWAL_EARNINGS', data: { amount: 5000 } });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.superWithdrawalBlocked, true);
  assert.strictEqual(sim.state.checkingAccount.balance, 5000);
});

test('EVT-22: Super earnings withdrawal is US ordinary income taxable', () => {
  const { sim } = buildSuperSim({
    initialChecking: 5000,
    superBalance: 20000,
    superEarningsBasis: 20000,
    personBirthDate: new Date(1966, 0, 1),
  });
  sim.schedule({ date: new Date(2026, 1, 1), type: 'SUPER_WITHDRAWAL_EARNINGS', data: { amount: 5000 } });
  sim.stepTo(new Date(2026, 1, 28));

  assert.strictEqual(sim.state.usOrdinaryIncomeYTD, 5000);
});

test('EVT-22: Super earnings withdrawal has no AU tax', () => {
  const { sim } = buildSuperSim({
    initialChecking: 5000,
    superBalance: 20000,
    superEarningsBasis: 20000,
    personBirthDate: new Date(1966, 0, 1),
  });
  sim.schedule({ date: new Date(2026, 1, 1), type: 'SUPER_WITHDRAWAL_EARNINGS', data: { amount: 5000 } });
  sim.stepTo(new Date(2026, 1, 28));

  assert.strictEqual(sim.state.auSuperTaxYTD, 0);
});

// ══════════════════════════════════════════════════════════════════════════════
// EVT-23: Super Earnings
// ══════════════════════════════════════════════════════════════════════════════

test('EVT-23: Super earnings increase superAccount balance and earningsBasis', () => {
  const { sim } = buildSuperSim({ superBalance: 100000, superContribBasis: 100000 });
  sim.schedule({ date: new Date(2026, 0, 15), type: 'SUPER_EARNINGS', data: { amount: 7000 } });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.superAccount.balance, 107000);
  assert.strictEqual(sim.state.superAccount.earningsBasis, 7000);
  assert.strictEqual(sim.state.superAccount.contributionBasis, 100000); // unchanged
});

test('EVT-23: Super earnings stay in account — no checking transaction', () => {
  const { sim } = buildSuperSim({
    initialChecking: 5000,
    superBalance: 100000,
    superContribBasis: 100000,
  });
  sim.schedule({ date: new Date(2026, 0, 15), type: 'SUPER_EARNINGS', data: { amount: 7000 } });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.checkingAccount.balance, 5000);
});

test('EVT-23: Super earnings are always AU super taxable (15%)', () => {
  const { sim } = buildSuperSim({ superBalance: 100000, superContribBasis: 100000 });
  sim.schedule({ date: new Date(2026, 0, 15), type: 'SUPER_EARNINGS', data: { amount: 7000 } });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.auSuperTaxYTD, 1050); // 15% of 7000
});

test('EVT-23: Super earnings are not US taxable', () => {
  const { sim } = buildSuperSim({ superBalance: 100000, superContribBasis: 100000 });
  sim.schedule({ date: new Date(2026, 0, 15), type: 'SUPER_EARNINGS', data: { amount: 7000 } });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.usOrdinaryIncomeYTD, 0);
});
