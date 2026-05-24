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
 * evt-au-savings.test.mjs
 * Tests for AU Savings Account events: EVT-16 through EVT-19
 *
 * EVT-16  AU Savings contribution             +balance  out of checking  no tax
 * EVT-17  AU Savings withdrawal               -balance  into checking    no tax
 * EVT-18  AU Savings earnings as AU resident  +balance  stays in account US: ordinary income, AU: always ordinary income, FTC
 * EVT-19  AU Savings earnings as non-resident +balance  stays in account US: ordinary income, AU: always non-resident withholding, FTC
 *
 * Note: The source CSV has EVT-18 and EVT-19 AU tax types swapped.
 *       Confirmed correct treatment:
 *         - AU Resident     → AU Ordinary Income rate
 *         - AU Non-Resident → AU Non-Resident Withholding rate
 *
 * Run with: node --test tests/evt-au-savings.test.mjs
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import { Account } from '../src/finance/account.js';
import { FinancialState } from '../src/finance/financial-state.js';
import { Simulation } from '../src/simulation-framework/simulation.js';
import { TaxService } from '../src/finance/tax-service.js';
import { PeriodService } from '../src/finance/period/period-service.js';
import { buildAuFiscalYear, applyTo } from '../src/finance/period/period-builder.js';

// Jan 1 2026 falls within AU fiscal year starting Jul 1 2025 (FY2025-26).
function buildAuPeriodService() {
  const ps = new PeriodService();
  applyTo(ps, buildAuFiscalYear(2025));
  return ps;
}

function buildAuSavingsSim({
  initialChecking    = 20000,
  auSavingsBalance   = 0,
  isAuResident       = true,
} = {}) {
  const sim = new Simulation(new Date(2026, 0, 1), { initialState: new FinancialState({
    checkingAccount: new Account(initialChecking),
    auSavingsAccount: { balance: auSavingsBalance },
    isAuResident,
    usOrdinaryIncomeYTD:           0,
    auOrdinaryIncomeYTD:           0,
    auNonResidentWithholdingYTD:   0,
    ftcYTD:                        0,
  }) });
  const svc = new TaxService().registerWith(sim, ['AU'], buildAuPeriodService());

  return { sim, svc };
}

// ══════════════════════════════════════════════════════════════════════════════
// EVT-16: AU Savings Contribution
// ══════════════════════════════════════════════════════════════════════════════

test('EVT-16: AU savings contribution increases auSavingsAccount and debits checking', () => {
  const { sim } = buildAuSavingsSim({ initialChecking: 10000 });
  sim.schedule({ date: new Date(2026, 0, 15), type: 'AU_SAVINGS_CONTRIBUTION', data: { amount: 5000 } });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.auSavingsAccount.balance, 5000);
  assert.strictEqual(sim.state.checkingAccount.balance, 5000);
});

test('EVT-16: AU savings contribution is not a US or AU taxable event', () => {
  const { sim } = buildAuSavingsSim({ initialChecking: 10000, isAuResident: true });
  sim.schedule({ date: new Date(2026, 0, 15), type: 'AU_SAVINGS_CONTRIBUTION', data: { amount: 5000 } });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.usOrdinaryIncomeYTD, 0);
  assert.strictEqual(sim.state.auOrdinaryIncomeYTD, 0);
  assert.strictEqual(sim.state.auNonResidentWithholdingYTD, 0);
});

// ══════════════════════════════════════════════════════════════════════════════
// EVT-17: AU Savings Withdrawal
// ══════════════════════════════════════════════════════════════════════════════

test('EVT-17: AU savings withdrawal decreases auSavingsAccount and credits checking', () => {
  const { sim } = buildAuSavingsSim({ initialChecking: 5000, auSavingsBalance: 20000 });
  sim.schedule({ date: new Date(2026, 0, 15), type: 'AU_SAVINGS_WITHDRAWAL', data: { amount: 8000 } });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.auSavingsAccount.balance, 12000);
  assert.strictEqual(sim.state.checkingAccount.balance, 13000);
});

test('EVT-17: AU savings withdrawal is not a US or AU taxable event', () => {
  const { sim } = buildAuSavingsSim({ initialChecking: 5000, auSavingsBalance: 20000, isAuResident: true });
  sim.schedule({ date: new Date(2026, 0, 15), type: 'AU_SAVINGS_WITHDRAWAL', data: { amount: 8000 } });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.usOrdinaryIncomeYTD, 0);
  assert.strictEqual(sim.state.auOrdinaryIncomeYTD, 0);
  assert.strictEqual(sim.state.auNonResidentWithholdingYTD, 0);
});

// ══════════════════════════════════════════════════════════════════════════════
// EVT-18: AU Savings Earnings — as AU Resident
// ══════════════════════════════════════════════════════════════════════════════

test('EVT-18: AU savings earnings (resident) stay in account', () => {
  const { sim } = buildAuSavingsSim({
    initialChecking: 5000,
    auSavingsBalance: 20000,
    isAuResident: true,
  });
  sim.schedule({ date: new Date(2026, 0, 15), type: 'AU_SAVINGS_EARNINGS', data: { amount: 600 } });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.auSavingsAccount.balance, 20600);
  assert.strictEqual(sim.state.checkingAccount.balance, 5000); // unchanged
});

test('EVT-18: AU savings earnings (resident) are US ordinary income taxable', () => {
  const { sim } = buildAuSavingsSim({ auSavingsBalance: 20000, isAuResident: true });
  sim.schedule({ date: new Date(2026, 0, 15), type: 'AU_SAVINGS_EARNINGS', data: { amount: 600 } });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.usOrdinaryIncomeYTD, 600);
});

test('EVT-18: AU savings earnings (resident) are ALWAYS AU taxable at ordinary income rate', () => {
  const { sim } = buildAuSavingsSim({ auSavingsBalance: 20000, isAuResident: true });
  sim.schedule({ date: new Date(2026, 0, 15), type: 'AU_SAVINGS_EARNINGS', data: { amount: 600 } });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.auOrdinaryIncomeYTD, 600);
  assert.strictEqual(sim.state.auNonResidentWithholdingYTD, 0); // resident pays ordinary rate
  assert.ok(sim.state.ftcYTD > 0, 'FTC should be recorded');
});

// ══════════════════════════════════════════════════════════════════════════════
// EVT-19: AU Savings Earnings — as AU Non-Resident
// ══════════════════════════════════════════════════════════════════════════════

test('EVT-19: AU savings earnings (non-resident) stay in account', () => {
  const { sim } = buildAuSavingsSim({
    initialChecking: 5000,
    auSavingsBalance: 20000,
    isAuResident: false,
  });
  sim.schedule({ date: new Date(2026, 0, 15), type: 'AU_SAVINGS_EARNINGS', data: { amount: 600 } });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.auSavingsAccount.balance, 20600);
  assert.strictEqual(sim.state.checkingAccount.balance, 5000); // unchanged
});

test('EVT-19: AU savings earnings (non-resident) are US ordinary income taxable', () => {
  const { sim } = buildAuSavingsSim({ auSavingsBalance: 20000, isAuResident: false });
  sim.schedule({ date: new Date(2026, 0, 15), type: 'AU_SAVINGS_EARNINGS', data: { amount: 600 } });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.usOrdinaryIncomeYTD, 600);
});

test('EVT-19: AU savings earnings (non-resident) are ALWAYS AU taxable at non-resident withholding rate', () => {
  const { sim } = buildAuSavingsSim({ auSavingsBalance: 20000, isAuResident: false });
  sim.schedule({ date: new Date(2026, 0, 15), type: 'AU_SAVINGS_EARNINGS', data: { amount: 600 } });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.auNonResidentWithholdingYTD, 600);
  assert.strictEqual(sim.state.auOrdinaryIncomeYTD, 0); // non-resident pays withholding rate
  assert.ok(sim.state.ftcYTD > 0, 'FTC should be recorded');
});
