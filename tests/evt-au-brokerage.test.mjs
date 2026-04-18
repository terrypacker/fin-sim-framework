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
 * evt-au-brokerage.test.mjs
 * Tests for AU Brokerage events: EVT-26 through EVT-32
 *
 * EVT-26  Franked dividend — AU resident     +basis  stays in account  US: ordinary, AU: franking credit, FTC
 * EVT-27  Franked dividend — AU non-resident +basis  stays in account  US: TODO (??), no AU tax
 * EVT-28  Unfranked dividend — AU resident   +basis  stays in account  US: ordinary, AU: ordinary, FTC
 * EVT-29  Unfranked dividend — non-resident  +basis  stays in account  US: ordinary, AU: NR withholding, FTC
 * EVT-30  AU Brokerage earnings (unrealized) +earn   stays in account  no tax
 * EVT-31  AU Brokerage withdrawal — resident  -      into checking     US: capital gain, AU: capital gain, FTC
 * EVT-32  AU Brokerage withdrawal — non-res   -      into checking     US: capital gain, no AU tax
 *
 * Run with: node --test tests/evt-au-brokerage.test.mjs
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import { Account } from '../assets/js/finance/account.js';
import { Simulation } from '../assets/js/simulation-framework/simulation.js';
import { TaxService } from '../assets/js/finance/tax-service.js';

function buildAuBrokerageSim({
  initialChecking        = 20000,
  auStockBalance         = 0,
  auStockContribBasis    = 0,
  auStockEarningsBasis   = 0,
  isAuResident           = true,
} = {}) {
  const initialState = {
    checkingAccount: new Account(initialChecking),
    auStockAccount: {
      balance:           auStockBalance,
      contributionBasis: auStockContribBasis,
      earningsBasis:     auStockEarningsBasis,
    },
    isAuResident,
    usOrdinaryIncomeYTD:           0,
    usCapitalGainsYTD:             0,
    auOrdinaryIncomeYTD:           0,
    auCapitalGainsYTD:             0,
    auNonResidentWithholdingYTD:   0,
    auFrankingCreditYTD:           0,
    ftcYTD:                        0,
    metrics: {},
  };

  const sim = new Simulation(new Date(2026, 0, 1), { initialState });
  const svc = new TaxService().registerWith(sim, ['AU'], 2026);

  return { sim, svc };
}

// ══════════════════════════════════════════════════════════════════════════════
// EVT-26: Franked Dividend — AU Resident
// ══════════════════════════════════════════════════════════════════════════════

test('EVT-26: Franked dividend (resident) stays in account', () => {
  const { sim } = buildAuBrokerageSim({ auStockBalance: 50000, auStockContribBasis: 50000, isAuResident: true });
  sim.schedule({ date: new Date(2026, 0, 15), type: 'AU_DIVIDEND_FRANKED_RESIDENT', data: { amount: 1000 } });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.auStockAccount.balance, 51000);
  assert.strictEqual(sim.state.checkingAccount.balance, 20000); // unchanged
});

test('EVT-26: Franked dividend (resident) is US ordinary income taxable', () => {
  const { sim } = buildAuBrokerageSim({ auStockBalance: 50000, auStockContribBasis: 50000, isAuResident: true });
  sim.schedule({ date: new Date(2026, 0, 15), type: 'AU_DIVIDEND_FRANKED_RESIDENT', data: { amount: 1000 } });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.usOrdinaryIncomeYTD, 1000);
});

test('EVT-26: Franked dividend (resident) generates AU franking credit', () => {
  const { sim } = buildAuBrokerageSim({ auStockBalance: 50000, auStockContribBasis: 50000, isAuResident: true });
  sim.schedule({ date: new Date(2026, 0, 15), type: 'AU_DIVIDEND_FRANKED_RESIDENT', data: { amount: 1000 } });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.auFrankingCreditYTD, 1000);
  assert.ok(sim.state.ftcYTD > 0, 'FTC should be recorded');
});

// ══════════════════════════════════════════════════════════════════════════════
// EVT-27: Franked Dividend — AU Non-Resident (TODO)
// ══════════════════════════════════════════════════════════════════════════════

test('EVT-27: Franked dividend (non-resident) stays in account', () => {
  const { sim } = buildAuBrokerageSim({ auStockBalance: 50000, auStockContribBasis: 50000, isAuResident: false });
  sim.schedule({ date: new Date(2026, 0, 15), type: 'AU_DIVIDEND_FRANKED_NONRESIDENT', data: { amount: 1000 } });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.auStockAccount.balance, 51000);
  assert.strictEqual(sim.state.checkingAccount.balance, 20000);
});

test('EVT-27: Franked dividend (non-resident) has no AU tax', () => {
  const { sim } = buildAuBrokerageSim({ auStockBalance: 50000, auStockContribBasis: 50000, isAuResident: false });
  sim.schedule({ date: new Date(2026, 0, 15), type: 'AU_DIVIDEND_FRANKED_NONRESIDENT', data: { amount: 1000 } });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.auOrdinaryIncomeYTD, 0);
  assert.strictEqual(sim.state.auNonResidentWithholdingYTD, 0);
  assert.strictEqual(sim.state.auFrankingCreditYTD, 0);
});

// TODO (EVT-27): US tax treatment for non-resident franked dividends is unresolved (CSV: "Ordinary Income??").
// When clarified, add an assertion here for usOrdinaryIncomeYTD.

// ══════════════════════════════════════════════════════════════════════════════
// EVT-28: Unfranked Dividend — AU Resident
// ══════════════════════════════════════════════════════════════════════════════

test('EVT-28: Unfranked dividend (resident) stays in account', () => {
  const { sim } = buildAuBrokerageSim({ auStockBalance: 50000, auStockContribBasis: 50000, isAuResident: true });
  sim.schedule({ date: new Date(2026, 0, 15), type: 'AU_DIVIDEND_UNFRANKED_RESIDENT', data: { amount: 1000 } });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.auStockAccount.balance, 51000);
  assert.strictEqual(sim.state.checkingAccount.balance, 20000);
});

test('EVT-28: Unfranked dividend (resident) is US ordinary income taxable', () => {
  const { sim } = buildAuBrokerageSim({ auStockBalance: 50000, auStockContribBasis: 50000, isAuResident: true });
  sim.schedule({ date: new Date(2026, 0, 15), type: 'AU_DIVIDEND_UNFRANKED_RESIDENT', data: { amount: 1000 } });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.usOrdinaryIncomeYTD, 1000);
});

test('EVT-28: Unfranked dividend (resident) is AU ordinary income taxable', () => {
  const { sim } = buildAuBrokerageSim({ auStockBalance: 50000, auStockContribBasis: 50000, isAuResident: true });
  sim.schedule({ date: new Date(2026, 0, 15), type: 'AU_DIVIDEND_UNFRANKED_RESIDENT', data: { amount: 1000 } });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.auOrdinaryIncomeYTD, 1000);
  assert.ok(sim.state.ftcYTD > 0);
});

// ══════════════════════════════════════════════════════════════════════════════
// EVT-29: Unfranked Dividend — AU Non-Resident
// ══════════════════════════════════════════════════════════════════════════════

test('EVT-29: Unfranked dividend (non-resident) stays in account', () => {
  const { sim } = buildAuBrokerageSim({ auStockBalance: 50000, auStockContribBasis: 50000, isAuResident: false });
  sim.schedule({ date: new Date(2026, 0, 15), type: 'AU_DIVIDEND_UNFRANKED_NONRESIDENT', data: { amount: 1000 } });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.auStockAccount.balance, 51000);
  assert.strictEqual(sim.state.checkingAccount.balance, 20000);
});

test('EVT-29: Unfranked dividend (non-resident) is US ordinary income taxable', () => {
  const { sim } = buildAuBrokerageSim({ auStockBalance: 50000, auStockContribBasis: 50000, isAuResident: false });
  sim.schedule({ date: new Date(2026, 0, 15), type: 'AU_DIVIDEND_UNFRANKED_NONRESIDENT', data: { amount: 1000 } });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.usOrdinaryIncomeYTD, 1000);
});

test('EVT-29: Unfranked dividend (non-resident) is AU non-resident withholding taxable', () => {
  const { sim } = buildAuBrokerageSim({ auStockBalance: 50000, auStockContribBasis: 50000, isAuResident: false });
  sim.schedule({ date: new Date(2026, 0, 15), type: 'AU_DIVIDEND_UNFRANKED_NONRESIDENT', data: { amount: 1000 } });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.auNonResidentWithholdingYTD, 1000);
  assert.strictEqual(sim.state.auOrdinaryIncomeYTD, 0);
  assert.ok(sim.state.ftcYTD > 0);
});

// ══════════════════════════════════════════════════════════════════════════════
// EVT-30: AU Brokerage Earnings (Unrealized)
// ══════════════════════════════════════════════════════════════════════════════

test('EVT-30: AU stock earnings stay in account, no tax event', () => {
  const { sim } = buildAuBrokerageSim({
    initialChecking: 5000,
    auStockBalance: 50000,
    auStockContribBasis: 50000,
    isAuResident: true,
  });
  sim.schedule({ date: new Date(2026, 0, 15), type: 'AU_STOCK_EARNINGS', data: { amount: 5000 } });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.auStockAccount.balance, 55000);
  assert.strictEqual(sim.state.auStockAccount.earningsBasis, 5000);
  assert.strictEqual(sim.state.checkingAccount.balance, 5000);   // unchanged
  assert.strictEqual(sim.state.usOrdinaryIncomeYTD, 0);
  assert.strictEqual(sim.state.auOrdinaryIncomeYTD, 0);
  assert.strictEqual(sim.state.usCapitalGainsYTD, 0);
});

// ══════════════════════════════════════════════════════════════════════════════
// EVT-31: AU Brokerage Withdrawal — AU Resident
// ══════════════════════════════════════════════════════════════════════════════

test('EVT-31: AU stock sale (resident) credits checking with sale proceeds', () => {
  const { sim } = buildAuBrokerageSim({
    initialChecking: 5000,
    auStockBalance: 30000,
    auStockContribBasis: 20000,
    auStockEarningsBasis: 10000,
    isAuResident: true,
  });
  sim.schedule({ date: new Date(2026, 0, 15), type: 'AU_STOCK_WITHDRAWAL',
    data: { salePrice: 15000, costBasis: 10000 } });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.checkingAccount.balance, 20000); // 5000 + 15000
});

test('EVT-31: AU stock sale (resident) records US and AU capital gains', () => {
  const { sim } = buildAuBrokerageSim({
    auStockBalance: 30000,
    auStockContribBasis: 20000,
    auStockEarningsBasis: 10000,
    isAuResident: true,
  });
  sim.schedule({ date: new Date(2026, 0, 15), type: 'AU_STOCK_WITHDRAWAL',
    data: { salePrice: 15000, costBasis: 10000 } });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.usCapitalGainsYTD, 5000);
  assert.strictEqual(sim.state.auCapitalGainsYTD, 5000);
  assert.ok(sim.state.ftcYTD > 0);
});

// ══════════════════════════════════════════════════════════════════════════════
// EVT-32: AU Brokerage Withdrawal — AU Non-Resident
// ══════════════════════════════════════════════════════════════════════════════

test('EVT-32: AU stock sale (non-resident) records US capital gain only — no AU tax', () => {
  const { sim } = buildAuBrokerageSim({
    auStockBalance: 30000,
    auStockContribBasis: 20000,
    auStockEarningsBasis: 10000,
    isAuResident: false,
  });
  sim.schedule({ date: new Date(2026, 0, 15), type: 'AU_STOCK_WITHDRAWAL',
    data: { salePrice: 15000, costBasis: 10000 } });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.usCapitalGainsYTD, 5000);
  assert.strictEqual(sim.state.auCapitalGainsYTD, 0);
  assert.strictEqual(sim.state.ftcYTD, 0);
});
