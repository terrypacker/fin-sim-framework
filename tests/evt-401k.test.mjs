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
 * evt-401k.test.mjs
 * Tests for 401K events: EVT-24 and EVT-25
 *
 * EVT-24  401K Contribution  +contribution  out of checking  US: negative income (pre-tax deduction), no AU tax
 * EVT-25  401K Earnings      +earnings      stays in account US: ordinary income (always taxable),
 *                                                              10% penalty if accessed before age 59.5, no AU tax
 *
 * Note: EVT-25 says "stays in account" under earnings, but also lists "10% penalty before min age".
 *       The penalty applies when the earnings are *accessed/withdrawn*, not when they accrue.
 *       These tests model: (a) earnings accrual as non-taxable accumulation, and
 *       (b) a separate WITHDRAWAL event that triggers ordinary income tax + penalty if under 59.5.
 *
 * Run with: node --test tests/evt-401k.test.mjs
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import { Account, AccountService } from '../assets/js/finance/account.js';
import { Simulation }              from '../assets/js/simulation-framework/simulation.js';
import { PRIORITY, MetricReducer, NoOpReducer } from '../assets/js/simulation-framework/reducers.js';
import { RecordBalanceAction } from '../assets/js/simulation-framework/actions.js';

/** Returns age as a decimal (years + fractional months) for the 59.5 threshold. */
function getAgeDecimal(birthDate, asOfDate) {
  const msPerYear = 365.25 * 24 * 60 * 60 * 1000;
  return (asOfDate - birthDate) / msPerYear;
}

function build401kSim({
  initialChecking     = 20000,
  k401Balance         = 0,
  k401ContribBasis    = 0,
  k401EarningsBasis   = 0,
  personBirthDate     = new Date(1966, 0, 1), // turns 60 on 2026-01-01
} = {}) {
  const svc = new AccountService();

  const initialState = {
    checkingAccount: new Account(initialChecking),
    k401Account: {
      balance:           k401Balance,
      contributionBasis: k401ContribBasis,
      earningsBasis:     k401EarningsBasis,
    },
    personBirthDate,
    usOrdinaryIncomeYTD: 0,
    usNegativeIncomeYTD: 0,
    usPenaltyYTD:        0,
    metrics: {},
  };

  const sim = new Simulation(new Date(2026, 0, 1), { initialState });

  // EVT-24: contribution — debit checking, credit contributionBasis, US negative income
  sim.reducers.register('K401_CONTRIBUTION_APPLY', (state, action) => {
    svc.transaction(state.checkingAccount, -action.amount, null);
    const ka = state.k401Account;
    return {
      ...state,
      k401Account: {
        ...ka,
        balance:           ka.balance           + action.amount,
        contributionBasis: ka.contributionBasis + action.amount,
      },
      usNegativeIncomeYTD: state.usNegativeIncomeYTD + action.amount,
    };
  }, PRIORITY.CASH_FLOW, '401K Contribution Apply');

  // EVT-25 (earnings accrual) — stays in account, no immediate tax (deferred until withdrawal)
  sim.reducers.register('K401_EARNINGS_APPLY', (state, action) => {
    const ka = state.k401Account;
    return {
      ...state,
      k401Account: {
        ...ka,
        balance:       ka.balance       + action.amount,
        earningsBasis: ka.earningsBasis + action.amount,
      },
      // No immediate US tax — deferred until withdrawal
    };
  }, PRIORITY.CASH_FLOW, '401K Earnings Apply');

  // EVT-25 (withdrawal) — US ordinary income on full amount, 10% penalty if under 59.5
  sim.reducers.register('K401_WITHDRAWAL_APPLY', (state, action) => {
    const { amount, penaltyAmount } = action;
    const netToChecking = amount - penaltyAmount;
    svc.transaction(state.checkingAccount, netToChecking, null);
    const ka = state.k401Account;
    // Simplified: withdraw from earningsBasis first, then contributions
    const fromEarnings = Math.min(amount, ka.earningsBasis);
    const fromContrib  = amount - fromEarnings;
    return {
      ...state,
      k401Account: {
        ...ka,
        balance:           ka.balance           - amount,
        earningsBasis:     ka.earningsBasis     - fromEarnings,
        contributionBasis: ka.contributionBasis - fromContrib,
      },
      usOrdinaryIncomeYTD: state.usOrdinaryIncomeYTD + amount,
      usPenaltyYTD:        state.usPenaltyYTD        + penaltyAmount,
    };
  }, PRIORITY.CASH_FLOW, '401K Withdrawal Apply');

  new MetricReducer().registerWith(sim.reducers, 'RECORD_METRIC');
  new NoOpReducer('Balance Snapshot').registerWith(sim.reducers, 'RECORD_BALANCE');

  sim.register('K401_CONTRIBUTION', ({ data }) => [
    { type: 'K401_CONTRIBUTION_APPLY', amount: data.amount },
    new RecordBalanceAction(),
  ]);

  sim.register('K401_EARNINGS', ({ data }) => [
    { type: 'K401_EARNINGS_APPLY', amount: data.amount },
    new RecordBalanceAction(),
  ]);

  // EVT-25 withdrawal — 10% penalty if under 59.5 per US IRS rules
  sim.register('K401_WITHDRAWAL', ({ date, state, data }) => {
    const age     = getAgeDecimal(state.personBirthDate, date);
    const penalty = age < 59.5 ? data.amount * 0.10 : 0;
    return [
      { type: 'K401_WITHDRAWAL_APPLY', amount: data.amount, penaltyAmount: penalty },
      new RecordBalanceAction(),
    ];
  });

  return { sim, svc };
}

// ══════════════════════════════════════════════════════════════════════════════
// EVT-24: 401K Contribution
// ══════════════════════════════════════════════════════════════════════════════

test('EVT-24: 401K contribution increases k401Account balance and contributionBasis', () => {
  const { sim } = build401kSim({ initialChecking: 10000 });
  sim.schedule({ date: new Date(2026, 0, 15), type: 'K401_CONTRIBUTION', data: { amount: 7000 } });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.k401Account.balance, 7000);
  assert.strictEqual(sim.state.k401Account.contributionBasis, 7000);
  assert.strictEqual(sim.state.k401Account.earningsBasis, 0);
});

test('EVT-24: 401K contribution debits checking account', () => {
  const { sim } = build401kSim({ initialChecking: 10000 });
  sim.schedule({ date: new Date(2026, 0, 15), type: 'K401_CONTRIBUTION', data: { amount: 7000 } });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.checkingAccount.balance, 3000);
});

test('EVT-24: 401K contribution is a US negative income (deduction) event', () => {
  const { sim } = build401kSim({ initialChecking: 10000 });
  sim.schedule({ date: new Date(2026, 0, 15), type: 'K401_CONTRIBUTION', data: { amount: 7000 } });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.usNegativeIncomeYTD, 7000);
  assert.strictEqual(sim.state.usOrdinaryIncomeYTD, 0);
});

// ══════════════════════════════════════════════════════════════════════════════
// EVT-25: 401K Earnings (accrual)
// ══════════════════════════════════════════════════════════════════════════════

test('EVT-25: 401K earnings increase k401Account balance and earningsBasis', () => {
  const { sim } = build401kSim({ k401Balance: 50000, k401ContribBasis: 50000 });
  sim.schedule({ date: new Date(2026, 0, 15), type: 'K401_EARNINGS', data: { amount: 4000 } });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.k401Account.balance, 54000);
  assert.strictEqual(sim.state.k401Account.earningsBasis, 4000);
  assert.strictEqual(sim.state.k401Account.contributionBasis, 50000); // unchanged
});

test('EVT-25: 401K earnings stay in account — no checking transaction', () => {
  const { sim } = build401kSim({ initialChecking: 5000, k401Balance: 50000, k401ContribBasis: 50000 });
  sim.schedule({ date: new Date(2026, 0, 15), type: 'K401_EARNINGS', data: { amount: 4000 } });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.checkingAccount.balance, 5000);
});

// ══════════════════════════════════════════════════════════════════════════════
// EVT-25: 401K Withdrawal (age-gated access to earnings)
// ══════════════════════════════════════════════════════════════════════════════

test('EVT-25: 401K withdrawal at age 59.5+ has no penalty and is US ordinary income taxable', () => {
  // Person born 1966-07-01: turns 59.5 on 2026-01-01
  const { sim } = build401kSim({
    initialChecking: 5000,
    k401Balance: 50000,
    k401EarningsBasis: 50000,
    personBirthDate: new Date(1966, 6, 1), // July 1, 1966 → age 59.5 on Jan 1, 2026
  });
  sim.schedule({ date: new Date(2026, 6, 1), type: 'K401_WITHDRAWAL', data: { amount: 10000 } });
  sim.stepTo(new Date(2026, 6, 30));

  assert.strictEqual(sim.state.usPenaltyYTD, 0);
  assert.strictEqual(sim.state.usOrdinaryIncomeYTD, 10000);
  assert.strictEqual(sim.state.checkingAccount.balance, 15000);
});

test('EVT-25: 401K withdrawal before age 59.5 incurs 10% penalty', () => {
  // Person born 1990 — age 36 in 2026
  const { sim } = build401kSim({
    initialChecking: 5000,
    k401Balance: 50000,
    k401EarningsBasis: 50000,
    personBirthDate: new Date(1990, 0, 1),
  });
  sim.schedule({ date: new Date(2026, 0, 15), type: 'K401_WITHDRAWAL', data: { amount: 10000 } });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.usPenaltyYTD, 1000);      // 10% of 10000
  assert.strictEqual(sim.state.usOrdinaryIncomeYTD, 10000); // full amount still taxable
  assert.strictEqual(sim.state.checkingAccount.balance, 14000); // 5000 + 9000 net
});

test('EVT-25: 401K withdrawal is always US ordinary income taxable (no AU tax)', () => {
  const { sim } = build401kSim({
    initialChecking: 5000,
    k401Balance: 50000,
    k401EarningsBasis: 50000,
    personBirthDate: new Date(1966, 0, 1),
  });
  sim.schedule({ date: new Date(2026, 1, 1), type: 'K401_WITHDRAWAL', data: { amount: 10000 } });
  sim.stepTo(new Date(2026, 1, 28));

  assert.strictEqual(sim.state.usOrdinaryIncomeYTD, 10000);
  // No AU tax fields exist in this sim — ordinary income is US-only per requirements
});
