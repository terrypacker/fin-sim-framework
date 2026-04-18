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
 * evt-us-brokerage.test.mjs
 * Tests for US Brokerage events: EVT-9 through EVT-15
 *
 * EVT-9   Fixed Income contribution    +balance    out of checking  no tax
 * EVT-10  Fixed Income withdrawal      -balance    into checking    no tax
 * EVT-11  Fixed Income earnings        +balance    stays in account US: ordinary income, AU: ordinary if resident, FTC
 * EVT-12  Stocks contribution          +contrib basis out of checking no tax
 * EVT-13  Stocks dividend yield        +contrib+earn basis stays in account US: ordinary income, AU: ordinary if resident, FTC
 * EVT-14  Stocks earnings (unrealized) +earn basis stays in account no tax
 * EVT-15  Stocks withdrawal (sale)     -earn or contrib into checking US: capital gain, AU: capital gain if resident, FTC
 *
 * Run with: node --test tests/evt-us-brokerage.test.mjs
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import { Account, AccountService } from '../assets/js/finance/account.js';
import { Simulation }              from '../assets/js/simulation-framework/simulation.js';
import { PRIORITY, MetricReducer, NoOpReducer } from '../assets/js/simulation-framework/reducers.js';
import { RecordMetricAction, RecordBalanceAction } from '../assets/js/simulation-framework/actions.js';

function buildBrokerageSim({
  initialChecking        = 20000,
  fixedIncomeBalance     = 0,
  stockBalance           = 0,
  stockContribBasis      = 0,
  stockEarningsBasis     = 0,
  isAuResident           = false,
} = {}) {
  const svc = new AccountService();

  const initialState = {
    checkingAccount: new Account(initialChecking),
    fixedIncomeAccount: { balance: fixedIncomeBalance },
    stockAccount: {
      balance:           stockBalance,
      contributionBasis: stockContribBasis,
      earningsBasis:     stockEarningsBasis,
    },
    isAuResident,
    usOrdinaryIncomeYTD: 0,
    usNegativeIncomeYTD: 0,
    usCapitalGainsYTD:   0,
    auOrdinaryIncomeYTD: 0,
    auCapitalGainsYTD:   0,
    ftcYTD:              0,
    metrics: {},
  };

  const sim = new Simulation(new Date(2026, 0, 1), { initialState });

  // ── Fixed Income reducers ──────────────────────────────────────────────────

  // EVT-9: contribution — debit checking, credit fixedIncomeAccount
  sim.reducers.register('FIXED_INCOME_CONTRIBUTION_APPLY', (state, action) => {
    svc.transaction(state.checkingAccount, -action.amount, null);
    return { ...state, fixedIncomeAccount: { balance: state.fixedIncomeAccount.balance + action.amount } };
  }, PRIORITY.CASH_FLOW, 'Fixed Income Contribution');

  // EVT-10: withdrawal — debit fixedIncomeAccount, credit checking
  sim.reducers.register('FIXED_INCOME_WITHDRAWAL_APPLY', (state, action) => {
    svc.transaction(state.checkingAccount, action.amount, null);
    return { ...state, fixedIncomeAccount: { balance: state.fixedIncomeAccount.balance - action.amount } };
  }, PRIORITY.CASH_FLOW, 'Fixed Income Withdrawal');

  // EVT-11: earnings — stays in account, US ordinary income, AU ordinary if resident, FTC
  sim.reducers.register('FIXED_INCOME_EARNINGS_APPLY', (state, action) => {
    const { amount, isAuResident: resident } = action;
    let newState = {
      ...state,
      fixedIncomeAccount: { balance: state.fixedIncomeAccount.balance + amount },
      usOrdinaryIncomeYTD: state.usOrdinaryIncomeYTD + amount,
    };
    if (resident) {
      newState = {
        ...newState,
        auOrdinaryIncomeYTD: state.auOrdinaryIncomeYTD + amount,
        ftcYTD: state.ftcYTD + amount,
      };
    }
    return newState;
  }, PRIORITY.CASH_FLOW, 'Fixed Income Earnings');

  // ── Stock reducers ─────────────────────────────────────────────────────────

  // EVT-12: stock contribution — debit checking, credit contributionBasis
  sim.reducers.register('STOCK_CONTRIBUTION_APPLY', (state, action) => {
    svc.transaction(state.checkingAccount, -action.amount, null);
    const sa = state.stockAccount;
    return {
      ...state,
      stockAccount: {
        ...sa,
        balance:           sa.balance           + action.amount,
        contributionBasis: sa.contributionBasis + action.amount,
      },
    };
  }, PRIORITY.CASH_FLOW, 'Stock Contribution');

  // EVT-13: dividend yield — stays in account, increases both bases, US ordinary income, AU if resident, FTC
  sim.reducers.register('STOCK_DIVIDEND_APPLY', (state, action) => {
    const { amount, isAuResident: resident } = action;
    const sa = state.stockAccount;
    let newState = {
      ...state,
      stockAccount: {
        ...sa,
        balance:           sa.balance           + amount,
        contributionBasis: sa.contributionBasis + amount,
        earningsBasis:     sa.earningsBasis     + amount,
      },
      usOrdinaryIncomeYTD: state.usOrdinaryIncomeYTD + amount,
    };
    if (resident) {
      newState = {
        ...newState,
        auOrdinaryIncomeYTD: state.auOrdinaryIncomeYTD + amount,
        ftcYTD: state.ftcYTD + amount,
      };
    }
    return newState;
  }, PRIORITY.CASH_FLOW, 'Stock Dividend');

  // EVT-14: stock earnings (unrealized) — stays in account, no tax
  sim.reducers.register('STOCK_EARNINGS_APPLY', (state, action) => {
    const sa = state.stockAccount;
    return {
      ...state,
      stockAccount: {
        ...sa,
        balance:       sa.balance       + action.amount,
        earningsBasis: sa.earningsBasis + action.amount,
      },
    };
  }, PRIORITY.CASH_FLOW, 'Stock Earnings (Unrealized)');

  // EVT-15: stock withdrawal (sale) — gain = sale price - basis, US capital gain, AU if resident, FTC
  sim.reducers.register('STOCK_WITHDRAWAL_APPLY', (state, action) => {
    const { salePrice, costBasis, isAuResident: resident } = action;
    const gain = Math.max(0, salePrice - costBasis);

    svc.transaction(state.checkingAccount, salePrice, null);

    // Remove the sold amount from the account (simplified: remove from earningsBasis first, then contrib)
    const sa = state.stockAccount;
    const newBalance = sa.balance - salePrice;
    const newEarnings = Math.max(0, sa.earningsBasis - gain);
    const newContrib  = newBalance - newEarnings;

    let newState = {
      ...state,
      stockAccount: {
        ...sa,
        balance:           newBalance,
        contributionBasis: newContrib,
        earningsBasis:     newEarnings,
      },
      usCapitalGainsYTD: state.usCapitalGainsYTD + gain,
    };
    if (resident) {
      newState = {
        ...newState,
        auCapitalGainsYTD: state.auCapitalGainsYTD + gain,
        ftcYTD: state.ftcYTD + gain,
      };
    }
    return newState;
  }, PRIORITY.CASH_FLOW, 'Stock Withdrawal');

  new MetricReducer().registerWith(sim.reducers, 'RECORD_METRIC');
  new NoOpReducer('Balance Snapshot').registerWith(sim.reducers, 'RECORD_BALANCE');

  // ── Handlers ────────────────────────────────────────────────────────────────

  sim.register('FIXED_INCOME_CONTRIBUTION', ({ data }) => [
    { type: 'FIXED_INCOME_CONTRIBUTION_APPLY', amount: data.amount },
    new RecordBalanceAction(),
  ]);

  sim.register('FIXED_INCOME_WITHDRAWAL', ({ data }) => [
    { type: 'FIXED_INCOME_WITHDRAWAL_APPLY', amount: data.amount },
    new RecordBalanceAction(),
  ]);

  sim.register('FIXED_INCOME_EARNINGS', ({ data, state }) => [
    { type: 'FIXED_INCOME_EARNINGS_APPLY', amount: data.amount, isAuResident: state.isAuResident },
    new RecordBalanceAction(),
  ]);

  sim.register('STOCK_CONTRIBUTION', ({ data }) => [
    { type: 'STOCK_CONTRIBUTION_APPLY', amount: data.amount },
    new RecordBalanceAction(),
  ]);

  sim.register('STOCK_DIVIDEND', ({ data, state }) => [
    { type: 'STOCK_DIVIDEND_APPLY', amount: data.amount, isAuResident: state.isAuResident },
    new RecordBalanceAction(),
  ]);

  sim.register('STOCK_EARNINGS', ({ data }) => [
    { type: 'STOCK_EARNINGS_APPLY', amount: data.amount },
    new RecordBalanceAction(),
  ]);

  sim.register('STOCK_WITHDRAWAL', ({ data, state }) => [
    { type: 'STOCK_WITHDRAWAL_APPLY',
      salePrice: data.salePrice,
      costBasis: data.costBasis,
      isAuResident: state.isAuResident,
    },
    new RecordBalanceAction(),
  ]);

  return { sim, svc };
}

// ══════════════════════════════════════════════════════════════════════════════
// EVT-9: Fixed Income Contribution
// ══════════════════════════════════════════════════════════════════════════════

test('EVT-9: Fixed income contribution increases fixedIncomeAccount and debits checking', () => {
  const { sim } = buildBrokerageSim({ initialChecking: 10000 });
  sim.schedule({ date: new Date(2026, 0, 15), type: 'FIXED_INCOME_CONTRIBUTION', data: { amount: 5000 } });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.fixedIncomeAccount.balance, 5000);
  assert.strictEqual(sim.state.checkingAccount.balance, 5000);
  assert.strictEqual(sim.state.usOrdinaryIncomeYTD, 0);
});

// ══════════════════════════════════════════════════════════════════════════════
// EVT-10: Fixed Income Withdrawal
// ══════════════════════════════════════════════════════════════════════════════

test('EVT-10: Fixed income withdrawal decreases fixedIncomeAccount and credits checking', () => {
  const { sim } = buildBrokerageSim({ initialChecking: 5000, fixedIncomeBalance: 20000 });
  sim.schedule({ date: new Date(2026, 0, 15), type: 'FIXED_INCOME_WITHDRAWAL', data: { amount: 8000 } });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.fixedIncomeAccount.balance, 12000);
  assert.strictEqual(sim.state.checkingAccount.balance, 13000);
  assert.strictEqual(sim.state.usOrdinaryIncomeYTD, 0);
});

// ══════════════════════════════════════════════════════════════════════════════
// EVT-11: Fixed Income Earnings
// ══════════════════════════════════════════════════════════════════════════════

test('EVT-11: Fixed income earnings stay in account', () => {
  const { sim } = buildBrokerageSim({ initialChecking: 5000, fixedIncomeBalance: 20000 });
  sim.schedule({ date: new Date(2026, 0, 15), type: 'FIXED_INCOME_EARNINGS', data: { amount: 400 } });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.fixedIncomeAccount.balance, 20400);
  assert.strictEqual(sim.state.checkingAccount.balance, 5000);
});

test('EVT-11: Fixed income earnings are US ordinary income taxable', () => {
  const { sim } = buildBrokerageSim({ fixedIncomeBalance: 20000 });
  sim.schedule({ date: new Date(2026, 0, 15), type: 'FIXED_INCOME_EARNINGS', data: { amount: 400 } });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.usOrdinaryIncomeYTD, 400);
});

test('EVT-11: Fixed income earnings ARE AU taxable if person is AU resident', () => {
  const { sim } = buildBrokerageSim({ fixedIncomeBalance: 20000, isAuResident: true });
  sim.schedule({ date: new Date(2026, 0, 15), type: 'FIXED_INCOME_EARNINGS', data: { amount: 400 } });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.auOrdinaryIncomeYTD, 400);
  assert.ok(sim.state.ftcYTD > 0, 'FTC should be recorded');
});

test('EVT-11: Fixed income earnings are NOT AU taxable if person is not AU resident', () => {
  const { sim } = buildBrokerageSim({ fixedIncomeBalance: 20000, isAuResident: false });
  sim.schedule({ date: new Date(2026, 0, 15), type: 'FIXED_INCOME_EARNINGS', data: { amount: 400 } });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.auOrdinaryIncomeYTD, 0);
  assert.strictEqual(sim.state.ftcYTD, 0);
});

// ══════════════════════════════════════════════════════════════════════════════
// EVT-12: Stock Contribution
// ══════════════════════════════════════════════════════════════════════════════

test('EVT-12: Stock contribution increases stockAccount contributionBasis and debits checking', () => {
  const { sim } = buildBrokerageSim({ initialChecking: 10000 });
  sim.schedule({ date: new Date(2026, 0, 15), type: 'STOCK_CONTRIBUTION', data: { amount: 5000 } });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.stockAccount.balance, 5000);
  assert.strictEqual(sim.state.stockAccount.contributionBasis, 5000);
  assert.strictEqual(sim.state.stockAccount.earningsBasis, 0);
  assert.strictEqual(sim.state.checkingAccount.balance, 5000);
  assert.strictEqual(sim.state.usOrdinaryIncomeYTD, 0);
});

// ══════════════════════════════════════════════════════════════════════════════
// EVT-13: Stock Dividend Yield
// ══════════════════════════════════════════════════════════════════════════════

test('EVT-13: Stock dividend stays in account and increases both basis fields', () => {
  const { sim } = buildBrokerageSim({
    initialChecking: 5000,
    stockBalance: 50000,
    stockContribBasis: 50000,
  });
  sim.schedule({ date: new Date(2026, 0, 15), type: 'STOCK_DIVIDEND', data: { amount: 1000 } });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.stockAccount.balance, 51000);
  assert.strictEqual(sim.state.stockAccount.contributionBasis, 51000);
  assert.strictEqual(sim.state.stockAccount.earningsBasis, 1000);
  assert.strictEqual(sim.state.checkingAccount.balance, 5000); // unchanged
});

test('EVT-13: Stock dividend is US ordinary income taxable', () => {
  const { sim } = buildBrokerageSim({ stockBalance: 50000, stockContribBasis: 50000 });
  sim.schedule({ date: new Date(2026, 0, 15), type: 'STOCK_DIVIDEND', data: { amount: 1000 } });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.usOrdinaryIncomeYTD, 1000);
});

test('EVT-13: Stock dividend IS AU taxable if person is AU resident', () => {
  const { sim } = buildBrokerageSim({ stockBalance: 50000, stockContribBasis: 50000, isAuResident: true });
  sim.schedule({ date: new Date(2026, 0, 15), type: 'STOCK_DIVIDEND', data: { amount: 1000 } });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.auOrdinaryIncomeYTD, 1000);
  assert.ok(sim.state.ftcYTD > 0);
});

test('EVT-13: Stock dividend is NOT AU taxable if person is not AU resident', () => {
  const { sim } = buildBrokerageSim({ stockBalance: 50000, stockContribBasis: 50000, isAuResident: false });
  sim.schedule({ date: new Date(2026, 0, 15), type: 'STOCK_DIVIDEND', data: { amount: 1000 } });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.auOrdinaryIncomeYTD, 0);
});

// ══════════════════════════════════════════════════════════════════════════════
// EVT-14: Stock Earnings (Unrealized)
// ══════════════════════════════════════════════════════════════════════════════

test('EVT-14: Stock earnings stay in account, increase earningsBasis, no tax', () => {
  const { sim } = buildBrokerageSim({
    initialChecking: 5000,
    stockBalance: 50000,
    stockContribBasis: 50000,
    isAuResident: true,
  });
  sim.schedule({ date: new Date(2026, 0, 15), type: 'STOCK_EARNINGS', data: { amount: 5000 } });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.stockAccount.balance, 55000);
  assert.strictEqual(sim.state.stockAccount.earningsBasis, 5000);
  assert.strictEqual(sim.state.checkingAccount.balance, 5000);    // unchanged
  assert.strictEqual(sim.state.usOrdinaryIncomeYTD, 0);
  assert.strictEqual(sim.state.auOrdinaryIncomeYTD, 0);
  assert.strictEqual(sim.state.usCapitalGainsYTD, 0);
});

// ══════════════════════════════════════════════════════════════════════════════
// EVT-15: Stock Withdrawal (Sale)
// ══════════════════════════════════════════════════════════════════════════════

test('EVT-15: Stock sale proceeds credit checking', () => {
  const { sim } = buildBrokerageSim({
    initialChecking: 5000,
    stockBalance: 20000,
    stockContribBasis: 10000,
    stockEarningsBasis: 10000,
  });
  sim.schedule({ date: new Date(2026, 0, 15), type: 'STOCK_WITHDRAWAL',
    data: { salePrice: 15000, costBasis: 10000 } });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.checkingAccount.balance, 20000); // 5000 + 15000
});

test('EVT-15: Stock sale records US capital gain (sale price - cost basis)', () => {
  const { sim } = buildBrokerageSim({
    stockBalance: 20000,
    stockContribBasis: 10000,
    stockEarningsBasis: 10000,
  });
  sim.schedule({ date: new Date(2026, 0, 15), type: 'STOCK_WITHDRAWAL',
    data: { salePrice: 15000, costBasis: 10000 } });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.usCapitalGainsYTD, 5000); // 15000 - 10000
});

test('EVT-15: Stock sale IS AU capital gains taxable if person is AU resident', () => {
  const { sim } = buildBrokerageSim({
    stockBalance: 20000,
    stockContribBasis: 10000,
    stockEarningsBasis: 10000,
    isAuResident: true,
  });
  sim.schedule({ date: new Date(2026, 0, 15), type: 'STOCK_WITHDRAWAL',
    data: { salePrice: 15000, costBasis: 10000 } });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.auCapitalGainsYTD, 5000);
  assert.ok(sim.state.ftcYTD > 0);
});

test('EVT-15: Stock sale is NOT AU taxable if person is not AU resident', () => {
  const { sim } = buildBrokerageSim({
    stockBalance: 20000,
    stockContribBasis: 10000,
    stockEarningsBasis: 10000,
    isAuResident: false,
  });
  sim.schedule({ date: new Date(2026, 0, 15), type: 'STOCK_WITHDRAWAL',
    data: { salePrice: 15000, costBasis: 10000 } });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.auCapitalGainsYTD, 0);
});
