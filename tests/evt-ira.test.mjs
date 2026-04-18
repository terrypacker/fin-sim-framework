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

import { Account, AccountService } from '../assets/js/finance/account.js';
import { Simulation }              from '../assets/js/simulation-framework/simulation.js';
import { PRIORITY, MetricReducer, NoOpReducer } from '../assets/js/simulation-framework/reducers.js';
import { RecordMetricAction, RecordBalanceAction } from '../assets/js/simulation-framework/actions.js';

function getAge(birthDate, asOfDate) {
  const years = asOfDate.getFullYear() - birthDate.getFullYear();
  const hadBirthday =
    asOfDate.getMonth() > birthDate.getMonth() ||
    (asOfDate.getMonth() === birthDate.getMonth() && asOfDate.getDate() >= birthDate.getDate());
  return hadBirthday ? years : years - 1;
}

function buildIraSim({
  initialChecking   = 20000,
  iraBalance        = 0,
  iraContribBasis   = 0,
  iraEarningsBasis  = 0,
  isAuResident      = false,
  personBirthDate   = new Date(1966, 0, 1), // turns 60 on 2026-01-01
} = {}) {
  const svc = new AccountService();

  const initialState = {
    checkingAccount: new Account(initialChecking),
    iraAccount: {
      balance:          iraBalance,
      contributionBasis: iraContribBasis,
      earningsBasis:    iraEarningsBasis,
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

  // EVT-5: IRA contribution — debit checking, credit iraContribBasis, US negative income
  sim.reducers.register('IRA_CONTRIBUTION_APPLY', (state, action) => {
    svc.transaction(state.checkingAccount, -action.amount, null);
    const ia = state.iraAccount;
    return {
      ...state,
      iraAccount: {
        ...ia,
        balance:           ia.balance           + action.amount,
        contributionBasis: ia.contributionBasis + action.amount,
      },
      usNegativeIncomeYTD: state.usNegativeIncomeYTD + action.amount,
    };
  }, PRIORITY.CASH_FLOW, 'IRA Contribution Apply');

  // EVT-6: IRA withdrawal-contributions — credit checking, debit iraContribBasis, US ordinary income, optional penalty
  sim.reducers.register('IRA_WITHDRAWAL_CONTRIB_APPLY', (state, action) => {
    const { amount, penaltyAmount } = action;
    const netToChecking = amount - penaltyAmount;
    svc.transaction(state.checkingAccount, netToChecking, null);
    const ia = state.iraAccount;
    return {
      ...state,
      iraAccount: {
        ...ia,
        balance:           ia.balance           - amount,
        contributionBasis: ia.contributionBasis - amount,
      },
      usOrdinaryIncomeYTD: state.usOrdinaryIncomeYTD + amount,
      usPenaltyYTD:        state.usPenaltyYTD        + penaltyAmount,
    };
  }, PRIORITY.CASH_FLOW, 'IRA Contribution Withdrawal Apply');

  // EVT-7: IRA withdrawal-earnings — credit checking, debit iraEarningsBasis, US ordinary income,
  //        AU ordinary income if resident, FTC
  sim.reducers.register('IRA_WITHDRAWAL_EARNINGS_APPLY', (state, action) => {
    const { amount, penaltyAmount, isAuResident: resident } = action;
    const netToChecking = amount - penaltyAmount;
    svc.transaction(state.checkingAccount, netToChecking, null);
    const ia = state.iraAccount;
    let newState = {
      ...state,
      iraAccount: {
        ...ia,
        balance:      ia.balance      - amount,
        earningsBasis: ia.earningsBasis - amount,
      },
      usOrdinaryIncomeYTD: state.usOrdinaryIncomeYTD + amount,
      usPenaltyYTD:        state.usPenaltyYTD        + penaltyAmount,
    };
    if (resident) {
      newState = {
        ...newState,
        auOrdinaryIncomeYTD: state.auOrdinaryIncomeYTD + amount,
        ftcYTD: state.ftcYTD + amount,
      };
    }
    return newState;
  }, PRIORITY.CASH_FLOW, 'IRA Earnings Withdrawal Apply');

  // EVT-8: IRA earnings — credit iraEarningsBasis, stays in account, no tax
  sim.reducers.register('IRA_EARNINGS_APPLY', (state, action) => {
    const ia = state.iraAccount;
    return {
      ...state,
      iraAccount: {
        ...ia,
        balance:       ia.balance       + action.amount,
        earningsBasis: ia.earningsBasis + action.amount,
      },
    };
  }, PRIORITY.CASH_FLOW, 'IRA Earnings Apply');

  new MetricReducer().registerWith(sim.reducers, 'RECORD_METRIC');
  new NoOpReducer('Balance Snapshot').registerWith(sim.reducers, 'RECORD_BALANCE');

  // EVT-5 handler
  sim.register('IRA_CONTRIBUTION', ({ data }) => [
    { type: 'IRA_CONTRIBUTION_APPLY', amount: data.amount },
    new RecordMetricAction('ira_contribution', data.amount),
    new RecordBalanceAction(),
  ]);

  // EVT-6 handler — age 60 gate, 10% penalty
  sim.register('IRA_WITHDRAWAL_CONTRIBUTIONS', ({ date, state, data }) => {
    const age     = getAge(state.personBirthDate, date);
    const penalty = age < 60 ? data.amount * 0.10 : 0;
    return [
      { type: 'IRA_WITHDRAWAL_CONTRIB_APPLY', amount: data.amount, penaltyAmount: penalty },
      new RecordMetricAction('ira_withdrawal_contributions', data.amount),
      new RecordBalanceAction(),
    ];
  });

  // EVT-7 handler — age 60 gate, 10% penalty
  sim.register('IRA_WITHDRAWAL_EARNINGS', ({ date, state, data }) => {
    const age     = getAge(state.personBirthDate, date);
    const penalty = age < 60 ? data.amount * 0.10 : 0;
    return [
      { type: 'IRA_WITHDRAWAL_EARNINGS_APPLY',
        amount: data.amount,
        penaltyAmount: penalty,
        isAuResident: state.isAuResident,
      },
      new RecordMetricAction('ira_withdrawal_earnings', data.amount),
      new RecordBalanceAction(),
    ];
  });

  // EVT-8 handler
  sim.register('IRA_EARNINGS', ({ data }) => [
    { type: 'IRA_EARNINGS_APPLY', amount: data.amount },
    new RecordMetricAction('ira_earnings', data.amount),
    new RecordBalanceAction(),
  ]);

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
