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

import { Account, AccountService } from '../assets/js/finance/account.js';
import { Simulation }              from '../assets/js/simulation-framework/simulation.js';
import { PRIORITY, MetricReducer, NoOpReducer } from '../assets/js/simulation-framework/reducers.js';
import { RecordBalanceAction } from '../assets/js/simulation-framework/actions.js';

const SUPER_CONTRIBUTIONS_TAX_RATE = 0.15;

function getAge(birthDate, asOfDate) {
  const years = asOfDate.getFullYear() - birthDate.getFullYear();
  const hadBirthday =
    asOfDate.getMonth() > birthDate.getMonth() ||
    (asOfDate.getMonth() === birthDate.getMonth() && asOfDate.getDate() >= birthDate.getDate());
  return hadBirthday ? years : years - 1;
}

function buildSuperSim({
  initialChecking    = 20000,
  superBalance       = 0,
  superContribBasis  = 0,
  superEarningsBasis = 0,
  personBirthDate    = new Date(1966, 0, 1), // turns 60 on 2026-01-01
} = {}) {
  const svc = new AccountService();

  const initialState = {
    checkingAccount: new Account(initialChecking),
    superAccount: {
      balance:           superBalance,
      contributionBasis: superContribBasis,
      earningsBasis:     superEarningsBasis,
    },
    personBirthDate,
    usOrdinaryIncomeYTD:  0,
    auSuperTaxYTD:        0,
    // Tracks whether a withdrawal was blocked due to age restriction
    superWithdrawalBlocked: false,
    metrics: {},
  };

  const sim = new Simulation(new Date(2026, 0, 1), { initialState });

  // EVT-20: contribution — debit checking, credit superContribBasis, AU super tax (15%)
  sim.reducers.register('SUPER_CONTRIBUTION_APPLY', (state, action) => {
    const { amount } = action;
    const superTax = amount * SUPER_CONTRIBUTIONS_TAX_RATE;
    svc.transaction(state.checkingAccount, -amount, null);
    const sa = state.superAccount;
    return {
      ...state,
      superAccount: {
        ...sa,
        balance:           sa.balance           + amount,
        contributionBasis: sa.contributionBasis + amount,
      },
      auSuperTaxYTD: state.auSuperTaxYTD + superTax,
    };
  }, PRIORITY.CASH_FLOW, 'Super Contribution Apply');

  // EVT-21: withdrawal of contributions — age-gated (no penalty; withdrawal simply blocked before 60)
  sim.reducers.register('SUPER_WITHDRAWAL_CONTRIB_APPLY', (state, action) => {
    const { amount, blocked } = action;
    if (blocked) {
      return { ...state, superWithdrawalBlocked: true };
    }
    svc.transaction(state.checkingAccount, amount, null);
    const sa = state.superAccount;
    return {
      ...state,
      superWithdrawalBlocked: false,
      superAccount: {
        ...sa,
        balance:           sa.balance           - amount,
        contributionBasis: sa.contributionBasis - amount,
      },
      // No US tax, no AU tax
    };
  }, PRIORITY.CASH_FLOW, 'Super Contribution Withdrawal Apply');

  // EVT-22: withdrawal of earnings — age-gated, US ordinary income
  sim.reducers.register('SUPER_WITHDRAWAL_EARNINGS_APPLY', (state, action) => {
    const { amount, blocked } = action;
    if (blocked) {
      return { ...state, superWithdrawalBlocked: true };
    }
    svc.transaction(state.checkingAccount, amount, null);
    const sa = state.superAccount;
    return {
      ...state,
      superWithdrawalBlocked: false,
      superAccount: {
        ...sa,
        balance:       sa.balance       - amount,
        earningsBasis: sa.earningsBasis - amount,
      },
      usOrdinaryIncomeYTD: state.usOrdinaryIncomeYTD + amount,
      // No AU tax
    };
  }, PRIORITY.CASH_FLOW, 'Super Earnings Withdrawal Apply');

  // EVT-23: earnings — stays in account, AU super tax, no US tax
  sim.reducers.register('SUPER_EARNINGS_APPLY', (state, action) => {
    const { amount } = action;
    const superTax = amount * SUPER_CONTRIBUTIONS_TAX_RATE;
    const sa = state.superAccount;
    return {
      ...state,
      superAccount: {
        ...sa,
        balance:       sa.balance       + amount,
        earningsBasis: sa.earningsBasis + amount,
      },
      auSuperTaxYTD: state.auSuperTaxYTD + superTax,
    };
  }, PRIORITY.CASH_FLOW, 'Super Earnings Apply');

  new MetricReducer().registerWith(sim.reducers, 'RECORD_METRIC');
  new NoOpReducer('Balance Snapshot').registerWith(sim.reducers, 'RECORD_BALANCE');

  sim.register('SUPER_CONTRIBUTION', ({ data }) => [
    { type: 'SUPER_CONTRIBUTION_APPLY', amount: data.amount },
    new RecordBalanceAction(),
  ]);

  // EVT-21 handler — enforces age 60 gate (no penalty amount, just blocked)
  sim.register('SUPER_WITHDRAWAL_CONTRIBUTIONS', ({ date, state, data }) => {
    const age     = getAge(state.personBirthDate, date);
    const blocked = age < 60;
    return [
      { type: 'SUPER_WITHDRAWAL_CONTRIB_APPLY', amount: data.amount, blocked },
      new RecordBalanceAction(),
    ];
  });

  // EVT-22 handler — enforces age 60 gate
  sim.register('SUPER_WITHDRAWAL_EARNINGS', ({ date, state, data }) => {
    const age     = getAge(state.personBirthDate, date);
    const blocked = age < 60;
    return [
      { type: 'SUPER_WITHDRAWAL_EARNINGS_APPLY', amount: data.amount, blocked },
      new RecordBalanceAction(),
    ];
  });

  sim.register('SUPER_EARNINGS', ({ data }) => [
    { type: 'SUPER_EARNINGS_APPLY', amount: data.amount },
    new RecordBalanceAction(),
  ]);

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
