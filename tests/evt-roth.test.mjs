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
 * Tests for Roth IRA events: EVT-1 through EVT-4
 *
 * EVT-1  Roth Contribution             +contribution  out of checking  no tax
 * EVT-2  Roth Withdrawal-Contributions -contribution  into checking    no tax, no age gate
 * EVT-3  Roth Withdrawal-Earnings      -earnings      into checking    age 60 gate, 10% penalty before 60,
 *                                                                       no US income tax, AU ordinary income if resident, FTC
 * EVT-4  Roth Earnings                 +earnings      stays in account no tax
 *
 * Run with: node --test tests/evt-roth.test.mjs
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import { Account, AccountService } from '../assets/js/finance/account.js';
import { Simulation }              from '../assets/js/simulation-framework/simulation.js';
import { PRIORITY, MetricReducer, NoOpReducer } from '../assets/js/simulation-framework/reducers.js';
import { RecordMetricAction, RecordBalanceAction } from '../assets/js/simulation-framework/actions.js';

// ── Shared helpers ─────────────────────────────────────────────────────────────

/** Returns age in whole years as of asOfDate. */
function getAge(birthDate, asOfDate) {
  const years = asOfDate.getFullYear() - birthDate.getFullYear();
  const hadBirthday =
    asOfDate.getMonth() > birthDate.getMonth() ||
    (asOfDate.getMonth() === birthDate.getMonth() && asOfDate.getDate() >= birthDate.getDate());
  return hadBirthday ? years : years - 1;
}

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
  initialChecking   = 20000,
  rothBalance       = 0,
  rothContribBasis  = 0,
  rothEarningsBasis = 0,
  isAuResident      = false,
  personBirthDate   = new Date(1966, 0, 1),   // turns 60 on 2026-01-01
} = {}) {
  const svc = new AccountService();

  const initialState = {
    checkingAccount:  new Account(initialChecking),
    rothAccount: {
      balance:          rothBalance,
      contributionBasis: rothContribBasis,
      earningsBasis:    rothEarningsBasis,
    },
    isAuResident,
    personBirthDate,
    // Tax YTD buckets
    usOrdinaryIncomeYTD: 0,
    usNegativeIncomeYTD: 0,
    usCapitalGainsYTD:   0,
    usPenaltyYTD:        0,
    auOrdinaryIncomeYTD: 0,
    ftcYTD:              0,
    metrics: {},
  };

  const sim = new Simulation(new Date(2026, 0, 1), { initialState });

  // ── Reducers ────────────────────────────────────────────────────────────────

  // EVT-1: credit Roth contributionBasis, debit checking
  sim.reducers.register('ROTH_CONTRIBUTION_APPLY', (state, action) => {
    svc.transaction(state.checkingAccount, -action.amount, null);
    const ra = state.rothAccount;
    return {
      ...state,
      rothAccount: {
        ...ra,
        balance:           ra.balance           + action.amount,
        contributionBasis: ra.contributionBasis + action.amount,
      },
    };
  }, PRIORITY.CASH_FLOW, 'Roth Contribution Apply');

  // EVT-2: debit Roth contributionBasis, credit checking (no tax)
  sim.reducers.register('ROTH_WITHDRAWAL_CONTRIB_APPLY', (state, action) => {
    svc.transaction(state.checkingAccount, action.amount, null);
    const ra = state.rothAccount;
    return {
      ...state,
      rothAccount: {
        ...ra,
        balance:           ra.balance           - action.amount,
        contributionBasis: ra.contributionBasis - action.amount,
      },
    };
  }, PRIORITY.CASH_FLOW, 'Roth Contribution Withdrawal Apply');

  // EVT-3: debit Roth earningsBasis, credit checking (minus penalty), apply AU tax if resident
  sim.reducers.register('ROTH_WITHDRAWAL_EARNINGS_APPLY', (state, action) => {
    const { amount, penaltyAmount, isAuResident: resident } = action;
    const netToChecking = amount - penaltyAmount;

    svc.transaction(state.checkingAccount, netToChecking, null);

    const ra = state.rothAccount;
    let newState = {
      ...state,
      rothAccount: {
        ...ra,
        balance:      ra.balance      - amount,
        earningsBasis: ra.earningsBasis - amount,
      },
      usPenaltyYTD: state.usPenaltyYTD + penaltyAmount,
      // EVT-3: NOT a US income taxable event
    };

    if (resident) {
      // AU: ordinary income if AU resident; FTC applies
      newState = {
        ...newState,
        auOrdinaryIncomeYTD: state.auOrdinaryIncomeYTD + amount,
        ftcYTD: state.ftcYTD + amount,   // simplified: full amount eligible for FTC
      };
    }

    return newState;
  }, PRIORITY.CASH_FLOW, 'Roth Earnings Withdrawal Apply');

  // EVT-4: credit Roth earningsBasis (stays in account, no cash flow, no tax)
  sim.reducers.register('ROTH_EARNINGS_APPLY', (state, action) => {
    const ra = state.rothAccount;
    return {
      ...state,
      rothAccount: {
        ...ra,
        balance:       ra.balance       + action.amount,
        earningsBasis: ra.earningsBasis + action.amount,
      },
    };
  }, PRIORITY.CASH_FLOW, 'Roth Earnings Apply');

  new MetricReducer().registerWith(sim.reducers, 'RECORD_METRIC');
  new NoOpReducer('Balance Snapshot').registerWith(sim.reducers, 'RECORD_BALANCE');

  // ── Handlers ────────────────────────────────────────────────────────────────

  // EVT-1: Roth contribution — no tax event
  sim.register('ROTH_CONTRIBUTION', ({ data }) => [
    { type: 'ROTH_CONTRIBUTION_APPLY', amount: data.amount },
    new RecordMetricAction('roth_contribution', data.amount),
    new RecordBalanceAction(),
  ]);

  // EVT-2: Roth withdrawal of contributions — no age gate, no tax
  sim.register('ROTH_WITHDRAWAL_CONTRIBUTIONS', ({ data }) => [
    { type: 'ROTH_WITHDRAWAL_CONTRIB_APPLY', amount: data.amount },
    new RecordMetricAction('roth_withdrawal_contributions', data.amount),
    new RecordBalanceAction(),
  ]);

  // EVT-3: Roth withdrawal of earnings — age 60 gate, 10% penalty if before 60
  sim.register('ROTH_WITHDRAWAL_EARNINGS', ({ date, state, data }) => {
    const age       = getAge(state.personBirthDate, date);
    const penalized = age < 60;
    const penalty   = penalized ? data.amount * 0.10 : 0;
    return [
      { type: 'ROTH_WITHDRAWAL_EARNINGS_APPLY',
        amount: data.amount,
        penaltyAmount: penalty,
        isAuResident: state.isAuResident,
      },
      new RecordMetricAction('roth_withdrawal_earnings', data.amount),
      new RecordBalanceAction(),
    ];
  });

  // EVT-4: Roth earnings — stays in account, no tax
  sim.register('ROTH_EARNINGS', ({ data }) => [
    { type: 'ROTH_EARNINGS_APPLY', amount: data.amount },
    new RecordMetricAction('roth_earnings', data.amount),
    new RecordBalanceAction(),
  ]);

  return { sim, svc };
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

test('EVT-2: Roth contribution withdrawal has no age restriction (person under 60)', () => {
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

test('EVT-3: Roth earnings withdrawal at age 60+ has no penalty', () => {
  // personBirthDate default = 1966-01-01, simulation date = 2026-01-15 → age 60
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

test('EVT-3: Roth earnings withdrawal before age 60 incurs 10% penalty', () => {
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
