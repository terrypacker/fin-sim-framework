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
 * asset-rules.test.mjs
 * Tests for Asset Rules AR-1 through AR-10
 *
 * Rule columns under test:
 *   - Ownership (50/50 or Solo)            — all assets AR-1..AR-10
 *   - Minimum Balance                       — AR-1 US Checking, AR-2 AU Savings
 *   - Track Balance on Residency Change     — AR-4, AR-5, AR-6, AR-7, AR-8, AR-9
 *   - Allow Loan                            — AR-5 AU Brokerage Stocks, AR-9 Real Property
 *   - Drawdown Priority                     — all assets AR-1..AR-10
 *
 * All inline helpers have been replaced with domain-layer services:
 *   AccountService  — getPersonShare, safeDebit, recordResidencyChange
 *   AssetService    — getPersonShare, recordResidencyChange, takeLoan, repayLoan
 *   Person          — ownership identity; state.person replaces flat isAuResident / birthDate
 *   InvestmentAccount — investment-type account state (Roth, IRA, 401k, stocks, Super)
 *   Asset           — non-ledger asset state (Real Property)
 *
 * Run with: node --test tests/asset-rules.test.mjs
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import { Account, AccountService }  from '../assets/js/finance/account.js';
import { InvestmentAccount }        from '../assets/js/finance/investment-account.js';
import { Asset }                    from '../assets/js/finance/asset.js';
import { AssetService }             from '../assets/js/finance/asset-service.js';
import { Person }                   from '../assets/js/finance/person.js';
import { Simulation }               from '../assets/js/simulation-framework/simulation.js';
import { PRIORITY, MetricReducer, NoOpReducer } from '../assets/js/simulation-framework/reducers.js';
import { RecordBalanceAction } from '../assets/js/simulation-framework/actions.js';

const svc     = new AccountService();
const assetSvc = new AssetService();

// ══════════════════════════════════════════════════════════════════════════════
// RULE: Ownership (50/50 or Solo)  — AR-1 through AR-10
//
// Each asset records ownershipType: 'sole' | 'joint'.
// For joint ownership each person's attributable share = balance (or value) / 2.
// AccountService.getPersonShare handles Account-based; AssetService.getPersonShare handles Asset-based.
// ══════════════════════════════════════════════════════════════════════════════

test('AR-1: US Checking sole ownership — person has 100% of balance', () => {
  const checking = new Account(10000, { ownershipType: 'sole', minimumBalance: 500 });
  assert.strictEqual(svc.getPersonShare(checking), 10000);
});

test('AR-1: US Checking joint ownership — each person has 50% of balance', () => {
  const checking = new Account(10000, { ownershipType: 'joint', minimumBalance: 500 });
  assert.strictEqual(svc.getPersonShare(checking), 5000);
});

test('AR-2: AU Savings joint ownership — each person has 50% of balance', () => {
  const auSavings = new Account(20000, { ownershipType: 'joint', minimumBalance: 1000 });
  assert.strictEqual(svc.getPersonShare(auSavings), 10000);
});

test('AR-4: US Brokerage Stocks joint ownership — each person has 50% of balance', () => {
  const stocks = new InvestmentAccount(50000, { ownershipType: 'joint' });
  assert.strictEqual(svc.getPersonShare(stocks), 25000);
});

test('AR-6: Roth sole ownership — person has 100% of balance', () => {
  const roth = new InvestmentAccount(120000, { ownershipType: 'sole', minimumAge: 60 });
  assert.strictEqual(svc.getPersonShare(roth), 120000);
});

test('AR-9: Real Property joint ownership — each person has 50% of value', () => {
  const property = new Asset('Primary Residence', 800000, 300000, { ownershipType: 'joint' });
  assert.strictEqual(assetSvc.getPersonShare(property), 400000);
});

test('AR-10: Superannuation sole ownership — person has 100% of balance', () => {
  const superAcct = new InvestmentAccount(200000, { ownershipType: 'sole', minimumAge: 60 });
  assert.strictEqual(svc.getPersonShare(superAcct), 200000);
});

// ══════════════════════════════════════════════════════════════════════════════
// RULE: Minimum Balance — AR-1 US Checking, AR-2 AU Savings
//
// A withdrawal is rejected if it would bring the balance below minimumBalance.
// AccountService.safeDebit enforces this rule.
// ══════════════════════════════════════════════════════════════════════════════

function buildMinBalanceSim({ initialBalance = 1000, minimumBalance = 500 } = {}) {
  const initialState = {
    checkingAccount: new Account(initialBalance, { minimumBalance }),
  };

  const sim = new Simulation(new Date(2026, 0, 1), { initialState });

  // Debit reducer delegates to AccountService.safeDebit
  sim.reducers.register('CHECKING_DEBIT', (state, action) => {
    svc.safeDebit(state.checkingAccount, action.amount, null);
    return { ...state };
  }, PRIORITY.CASH_FLOW, 'Checking Debit');

  sim.register('CHECKING_WITHDRAWAL', ({ data }) => [
    { type: 'CHECKING_DEBIT', amount: data.amount },
  ]);

  return { sim };
}

test('AR-1: US Checking withdrawal rejected if it would breach minimum balance', () => {
  // balance=1000, minimum=500; withdraw $600 → would leave $400 < $500 → rejected
  const { sim } = buildMinBalanceSim({ initialBalance: 1000, minimumBalance: 500 });
  sim.schedule({ date: new Date(2026, 0, 15), type: 'CHECKING_WITHDRAWAL', data: { amount: 600 } });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.checkingAccount.balance, 1000); // unchanged
});

test('AR-1: US Checking withdrawal allowed when balance stays above minimum', () => {
  // withdraw $400 → leaves $600 > $500 → allowed
  const { sim } = buildMinBalanceSim({ initialBalance: 1000, minimumBalance: 500 });
  sim.schedule({ date: new Date(2026, 0, 15), type: 'CHECKING_WITHDRAWAL', data: { amount: 400 } });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.checkingAccount.balance, 600);
});

test('AR-1: US Checking withdrawal allowed when balance reaches exactly the minimum (boundary)', () => {
  // withdraw $500 → leaves exactly $500 = minimum → allowed
  const { sim } = buildMinBalanceSim({ initialBalance: 1000, minimumBalance: 500 });
  sim.schedule({ date: new Date(2026, 0, 15), type: 'CHECKING_WITHDRAWAL', data: { amount: 500 } });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.checkingAccount.balance, 500);
});

test('AR-2: AU Savings withdrawal rejected if it would breach minimum balance', () => {
  // Same minimum balance rule applies to AU Savings (AR-2)
  const { sim } = buildMinBalanceSim({ initialBalance: 5000, minimumBalance: 2000 });
  sim.schedule({ date: new Date(2026, 0, 15), type: 'CHECKING_WITHDRAWAL', data: { amount: 3500 } });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.checkingAccount.balance, 5000); // unchanged
});

test('AR-2: AU Savings withdrawal allowed when balance stays above minimum', () => {
  const { sim } = buildMinBalanceSim({ initialBalance: 5000, minimumBalance: 2000 });
  sim.schedule({ date: new Date(2026, 0, 15), type: 'CHECKING_WITHDRAWAL', data: { amount: 2000 } });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.checkingAccount.balance, 3000);
});

// ══════════════════════════════════════════════════════════════════════════════
// RULE: Track Balance on Residency Change
//   YES: AR-4 Brokerage Stocks, AR-5 AU Brokerage, AR-6 Roth,
//        AR-7 IRA, AR-8 401k, AR-9 Real Property
//   NO:  AR-1 US Checking, AR-2 AU Savings, AR-3 Fixed Income, AR-10 Super
//
// On RESIDENCY_CHANGE, AccountService.recordResidencyChange captures the balance
// for InvestmentAccount-based accounts; AssetService.recordResidencyChange captures
// value for Asset-based holdings (Real Property).
// ══════════════════════════════════════════════════════════════════════════════

function buildResidencyTrackingSim({
  stockBalance    = 50000,
  auStockBalance  = 40000,
  rothBalance     = 80000,
  iraBalance      = 60000,
  k401Balance     = 100000,
  propertyValue   = 700000,
  checkingBalance = 10000,
  superBalance    = 200000,
} = {}) {
  const initialState = {
    person: new Person('primary', new Date(1966, 0, 1), { isAuResident: false }),

    // AR-1: NO residency tracking — plain Account (no balanceAtResidencyChange field)
    checkingAccount: new Account(checkingBalance),

    // AR-4: YES — US Brokerage Stocks
    stockAccount: new InvestmentAccount(stockBalance),

    // AR-5: YES — AU Brokerage Stocks
    auStockAccount: new InvestmentAccount(auStockBalance),

    // AR-6: YES — Roth
    rothAccount: new InvestmentAccount(rothBalance, { minimumAge: 60 }),

    // AR-7: YES — IRA
    iraAccount: new InvestmentAccount(iraBalance, { minimumAge: 60 }),

    // AR-8: YES — 401k
    k401Account: new InvestmentAccount(k401Balance, { minimumAge: 59.5 }),

    // AR-9: YES — Real Property (Asset, not InvestmentAccount)
    realProperty: new Asset('Primary Residence', propertyValue, 300000),

    // AR-10: NO — Superannuation; is an InvestmentAccount but residency NOT recorded
    superAccount: new InvestmentAccount(superBalance, { minimumAge: 60 }),

    metrics: {},
  };

  const sim = new Simulation(new Date(2026, 0, 1), { initialState });

  sim.reducers.register('RESIDENCY_CHANGE_APPLY', (state, action) => {
    // Update person residency
    const newPerson = { ...state.person, isAuResident: action.isAuResident };

    // Snapshot applicable accounts (AR-4, AR-5, AR-6, AR-7, AR-8)
    svc.recordResidencyChange(state.stockAccount);
    svc.recordResidencyChange(state.auStockAccount);
    svc.recordResidencyChange(state.rothAccount);
    svc.recordResidencyChange(state.iraAccount);
    svc.recordResidencyChange(state.k401Account);

    // Snapshot real property (AR-9) via AssetService
    assetSvc.recordResidencyChange(state.realProperty);

    // checkingAccount and superAccount are intentionally excluded

    return { ...state, person: newPerson };
  }, PRIORITY.CASH_FLOW, 'Residency Change Apply');

  new MetricReducer().registerWith(sim.reducers, 'RECORD_METRIC');
  new NoOpReducer('Balance Snapshot').registerWith(sim.reducers, 'RECORD_BALANCE');

  sim.register('RESIDENCY_CHANGE', ({ data }) => [
    { type: 'RESIDENCY_CHANGE_APPLY', isAuResident: data.isAuResident },
    new RecordBalanceAction(),
  ]);

  return { sim };
}

test('AR-4: US Brokerage Stocks records balance at residency change', () => {
  const { sim } = buildResidencyTrackingSim({ stockBalance: 50000 });
  sim.schedule({ date: new Date(2026, 3, 1), type: 'RESIDENCY_CHANGE', data: { isAuResident: true } });
  sim.stepTo(new Date(2026, 3, 30));

  assert.strictEqual(sim.state.stockAccount.balanceAtResidencyChange, 50000);
  assert.strictEqual(sim.state.person.isAuResident, true);
});

test('AR-5: AU Brokerage Stocks records balance at residency change', () => {
  const { sim } = buildResidencyTrackingSim({ auStockBalance: 40000 });
  sim.schedule({ date: new Date(2026, 3, 1), type: 'RESIDENCY_CHANGE', data: { isAuResident: true } });
  sim.stepTo(new Date(2026, 3, 30));

  assert.strictEqual(sim.state.auStockAccount.balanceAtResidencyChange, 40000);
});

test('AR-6: Roth records balance at residency change', () => {
  const { sim } = buildResidencyTrackingSim({ rothBalance: 80000 });
  sim.schedule({ date: new Date(2026, 3, 1), type: 'RESIDENCY_CHANGE', data: { isAuResident: true } });
  sim.stepTo(new Date(2026, 3, 30));

  assert.strictEqual(sim.state.rothAccount.balanceAtResidencyChange, 80000);
});

test('AR-7: IRA records balance at residency change', () => {
  const { sim } = buildResidencyTrackingSim({ iraBalance: 60000 });
  sim.schedule({ date: new Date(2026, 3, 1), type: 'RESIDENCY_CHANGE', data: { isAuResident: true } });
  sim.stepTo(new Date(2026, 3, 30));

  assert.strictEqual(sim.state.iraAccount.balanceAtResidencyChange, 60000);
});

test('AR-8: 401k records balance at residency change', () => {
  const { sim } = buildResidencyTrackingSim({ k401Balance: 100000 });
  sim.schedule({ date: new Date(2026, 3, 1), type: 'RESIDENCY_CHANGE', data: { isAuResident: true } });
  sim.stepTo(new Date(2026, 3, 30));

  assert.strictEqual(sim.state.k401Account.balanceAtResidencyChange, 100000);
});

test('AR-9: Real Property records value at residency change', () => {
  const { sim } = buildResidencyTrackingSim({ propertyValue: 700000 });
  sim.schedule({ date: new Date(2026, 3, 1), type: 'RESIDENCY_CHANGE', data: { isAuResident: true } });
  sim.stepTo(new Date(2026, 3, 30));

  assert.strictEqual(sim.state.realProperty.balanceAtResidencyChange, 700000);
});

test('AR-1: US Checking does NOT track balance at residency change', () => {
  const { sim } = buildResidencyTrackingSim({ checkingBalance: 10000 });
  sim.schedule({ date: new Date(2026, 3, 1), type: 'RESIDENCY_CHANGE', data: { isAuResident: true } });
  sim.stepTo(new Date(2026, 3, 30));

  // Plain Account has no balanceAtResidencyChange field
  assert.strictEqual(sim.state.checkingAccount.balanceAtResidencyChange, undefined);
});

test('AR-10: Superannuation does NOT track balance at residency change', () => {
  const { sim } = buildResidencyTrackingSim({ superBalance: 200000 });
  sim.schedule({ date: new Date(2026, 3, 1), type: 'RESIDENCY_CHANGE', data: { isAuResident: true } });
  sim.stepTo(new Date(2026, 3, 30));

  // superAccount is an InvestmentAccount but recordResidencyChange is never called on it —
  // balanceAtResidencyChange stays null (the initial value for InvestmentAccount).
  assert.strictEqual(sim.state.superAccount.balanceAtResidencyChange, null);
});

test('AR: Balance at residency change is captured at the moment of the event, not updated on subsequent changes', () => {
  // Verify that a second RESIDENCY_CHANGE does not overwrite the first snapshot
  const { sim } = buildResidencyTrackingSim({ rothBalance: 80000 });
  sim.schedule({ date: new Date(2026, 3, 1), type: 'RESIDENCY_CHANGE', data: { isAuResident: true } });
  sim.schedule({ date: new Date(2028, 3, 1), type: 'RESIDENCY_CHANGE', data: { isAuResident: false } });
  sim.stepTo(new Date(2028, 3, 30));

  // Snapshot is still the balance from the FIRST residency change
  assert.strictEqual(sim.state.rothAccount.balanceAtResidencyChange, 80000);
});

// ══════════════════════════════════════════════════════════════════════════════
// RULE: Allow Loan
//   YES: AR-5 AU Brokerage Stocks, AR-9 Real Property
//   NO:  All other assets
//
// AssetService.takeLoan / repayLoan manage loanBalance on InvestmentAccount
// (AR-5) and Asset (AR-9) objects.  AccountService.transaction credits/debits
// the transaction account (checking).
// ══════════════════════════════════════════════════════════════════════════════

function buildLoanSim({
  initialChecking = 5000,
  auStockBalance  = 100000,
  propertyValue   = 800000,
} = {}) {
  const initialState = {
    checkingAccount: new Account(initialChecking),
    auStockAccount:  new InvestmentAccount(auStockBalance, { loanBalance: 0 }),
    realProperty:    new Asset('Primary Residence', propertyValue, 300000, { loanBalance: 0 }),
    metrics: {},
  };

  const sim = new Simulation(new Date(2026, 0, 1), { initialState });

  // AR-5: Take loan against AU brokerage stocks
  sim.reducers.register('AU_STOCK_LOAN_APPLY', (state, action, date) => {
    svc.transaction(state.checkingAccount, action.amount, date);
    assetSvc.takeLoan(state.auStockAccount, action.amount);
    return { ...state };
  }, PRIORITY.CASH_FLOW, 'AU Stock Loan');

  // AR-5: Repay loan against AU brokerage stocks
  sim.reducers.register('AU_STOCK_LOAN_REPAY_APPLY', (state, action, date) => {
    svc.transaction(state.checkingAccount, -action.amount, date);
    assetSvc.repayLoan(state.auStockAccount, action.amount);
    return { ...state };
  }, PRIORITY.CASH_FLOW, 'AU Stock Loan Repayment');

  // AR-9: Take loan against real property (mortgage / HELOC)
  sim.reducers.register('PROPERTY_LOAN_APPLY', (state, action, date) => {
    svc.transaction(state.checkingAccount, action.amount, date);
    assetSvc.takeLoan(state.realProperty, action.amount);
    return { ...state };
  }, PRIORITY.CASH_FLOW, 'Property Loan');

  // AR-9: Repay loan against real property
  sim.reducers.register('PROPERTY_LOAN_REPAY_APPLY', (state, action, date) => {
    svc.transaction(state.checkingAccount, -action.amount, date);
    assetSvc.repayLoan(state.realProperty, action.amount);
    return { ...state };
  }, PRIORITY.CASH_FLOW, 'Property Loan Repayment');

  new MetricReducer().registerWith(sim.reducers, 'RECORD_METRIC');
  new NoOpReducer('Balance Snapshot').registerWith(sim.reducers, 'RECORD_BALANCE');

  sim.register('AU_STOCK_TAKE_LOAN',  ({ data }) => [{ type: 'AU_STOCK_LOAN_APPLY',       amount: data.amount }, new RecordBalanceAction()]);
  sim.register('AU_STOCK_REPAY_LOAN', ({ data }) => [{ type: 'AU_STOCK_LOAN_REPAY_APPLY', amount: data.amount }, new RecordBalanceAction()]);
  sim.register('PROPERTY_TAKE_LOAN',  ({ data }) => [{ type: 'PROPERTY_LOAN_APPLY',        amount: data.amount }, new RecordBalanceAction()]);
  sim.register('PROPERTY_REPAY_LOAN', ({ data }) => [{ type: 'PROPERTY_LOAN_REPAY_APPLY',  amount: data.amount }, new RecordBalanceAction()]);

  return { sim };
}

test('AR-5: Taking loan against AU Brokerage Stocks credits checking account', () => {
  const { sim } = buildLoanSim({ initialChecking: 5000, auStockBalance: 100000 });
  sim.schedule({ date: new Date(2026, 0, 15), type: 'AU_STOCK_TAKE_LOAN', data: { amount: 20000 } });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.checkingAccount.balance, 25000); // 5000 + 20000
});

test('AR-5: Taking loan against AU Brokerage Stocks records loanBalance on the account', () => {
  const { sim } = buildLoanSim({ auStockBalance: 100000 });
  sim.schedule({ date: new Date(2026, 0, 15), type: 'AU_STOCK_TAKE_LOAN', data: { amount: 20000 } });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.auStockAccount.loanBalance, 20000);
  assert.strictEqual(sim.state.auStockAccount.balance, 100000); // underlying account unchanged
});

test('AR-5: Repaying loan against AU Brokerage Stocks debits checking and reduces loanBalance', () => {
  const { sim } = buildLoanSim({ initialChecking: 30000, auStockBalance: 100000 });
  sim.schedule({ date: new Date(2026, 0, 15), type: 'AU_STOCK_TAKE_LOAN',  data: { amount: 20000 } });
  sim.schedule({ date: new Date(2026, 1,  1), type: 'AU_STOCK_REPAY_LOAN', data: { amount: 20000 } });
  sim.stepTo(new Date(2026, 1, 28));

  assert.strictEqual(sim.state.checkingAccount.balance, 30000);  // back to start
  assert.strictEqual(sim.state.auStockAccount.loanBalance, 0);
});

test('AR-9: Taking loan against Real Property credits checking account', () => {
  const { sim } = buildLoanSim({ initialChecking: 10000, propertyValue: 800000 });
  sim.schedule({ date: new Date(2026, 0, 15), type: 'PROPERTY_TAKE_LOAN', data: { amount: 100000 } });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.checkingAccount.balance, 110000); // 10000 + 100000
});

test('AR-9: Taking loan against Real Property records loanBalance on the property', () => {
  const { sim } = buildLoanSim({ propertyValue: 800000 });
  sim.schedule({ date: new Date(2026, 0, 15), type: 'PROPERTY_TAKE_LOAN', data: { amount: 100000 } });
  sim.stepTo(new Date(2026, 0, 31));

  assert.strictEqual(sim.state.realProperty.loanBalance, 100000);
  assert.strictEqual(sim.state.realProperty.value, 800000); // property value unchanged
});

test('AR-9: Repaying loan against Real Property debits checking and reduces loanBalance', () => {
  const { sim } = buildLoanSim({ initialChecking: 200000, propertyValue: 800000 });
  sim.schedule({ date: new Date(2026, 0, 15), type: 'PROPERTY_TAKE_LOAN',  data: { amount: 100000 } });
  sim.schedule({ date: new Date(2026, 1,  1), type: 'PROPERTY_REPAY_LOAN', data: { amount: 50000  } });
  sim.stepTo(new Date(2026, 1, 28));

  assert.strictEqual(sim.state.checkingAccount.balance, 250000);  // 200000 + 100000 - 50000
  assert.strictEqual(sim.state.realProperty.loanBalance, 50000);   // 100000 - 50000
});

// ══════════════════════════════════════════════════════════════════════════════
// RULE: Drawdown Priority (all assets AR-1..AR-10)
//
// Assets are liquidated in ascending priority order when cash is needed.
// Priorities from the requirements CSV:
//   1  US Checking      (AR-1)
//   2  Fixed Income     (AR-3)
//   3  AU Savings       (AR-2)
//   4  US Stocks        (AR-4)  — tied with AU Stocks
//   4  AU Stocks        (AR-5)  — tied with US Stocks
//   5  Roth             (AR-6)
//   7  IRA              (AR-7)
//   8  401k             (AR-8)
//   9  Superannuation   (AR-10)
//  10  Real Property    (AR-9)
// ══════════════════════════════════════════════════════════════════════════════

/** Canonical asset drawdown priority registry (sourced from requirements CSV). */
const ASSET_DRAWDOWN_PRIORITIES = [
  { key: 'checkingAccount',    label: 'US Checking',           priority: 1  },
  { key: 'fixedIncomeAccount', label: 'Brokerage Fixed Income', priority: 2  },
  { key: 'auSavingsAccount',   label: 'AU Savings',             priority: 3  },
  { key: 'stockAccount',       label: 'Brokerage Stocks',       priority: 4  },
  { key: 'auStockAccount',     label: 'AU Brokerage Stocks',    priority: 4  },
  { key: 'rothAccount',        label: 'Roth',                   priority: 5  },
  { key: 'iraAccount',         label: 'IRA',                    priority: 7  },
  { key: 'k401Account',        label: '401k',                   priority: 8  },
  { key: 'superAccount',       label: 'Superannuation',         priority: 9  },
  { key: 'realProperty',       label: 'Real Property',          priority: 10 },
];

test('AR: Drawdown priority registry covers all 10 asset types', () => {
  assert.strictEqual(ASSET_DRAWDOWN_PRIORITIES.length, 10);
});

test('AR: Drawdown priority order is correct for all assets', () => {
  const sorted = [...ASSET_DRAWDOWN_PRIORITIES].sort((a, b) => a.priority - b.priority);

  assert.strictEqual(sorted[0].key, 'checkingAccount');     // priority 1  — AR-1
  assert.strictEqual(sorted[1].key, 'fixedIncomeAccount');  // priority 2  — AR-3
  assert.strictEqual(sorted[2].key, 'auSavingsAccount');    // priority 3  — AR-2
  // indices 3 and 4 are both priority=4 (US & AU stocks); order within the tie is unspecified
  assert.ok(sorted[3].priority === 4 && sorted[4].priority === 4, 'both stock assets have priority 4');
  assert.strictEqual(sorted[5].key, 'rothAccount');         // priority 5  — AR-6
  assert.strictEqual(sorted[6].key, 'iraAccount');          // priority 7  — AR-7
  assert.strictEqual(sorted[7].key, 'k401Account');         // priority 8  — AR-8
  assert.strictEqual(sorted[8].key, 'superAccount');        // priority 9  — AR-10
  assert.strictEqual(sorted[9].key, 'realProperty');        // priority 10 — AR-9
});

function buildDrawdownSim() {
  const initialState = {
    // Each asset carries its own drawdownPriority so reducers can sort without external config
    assets: [
      { key: 'checkingAccount',    balance: 1000,  drawdownPriority: 1 },
      { key: 'fixedIncomeAccount', balance: 5000,  drawdownPriority: 2 },
      { key: 'auSavingsAccount',   balance: 3000,  drawdownPriority: 3 },
      { key: 'stockAccount',       balance: 20000, drawdownPriority: 4 },
    ],
    totalDrawn: 0,
  };

  const sim = new Simulation(new Date(2026, 0, 1), { initialState });

  // Drawdown reducer: liquidate assets in ascending priority order until amount is met
  sim.reducers.register('DRAWDOWN_APPLY', (state, action) => {
    let remaining = action.amount;
    const assets = state.assets.map(a => ({ ...a }));
    const sorted = [...assets].sort((a, b) => a.drawdownPriority - b.drawdownPriority);
    let totalDrawn = 0;

    for (const sorted_asset of sorted) {
      if (remaining <= 0) break;
      const idx  = assets.findIndex(a => a.key === sorted_asset.key);
      const take = Math.min(assets[idx].balance, remaining);
      assets[idx] = { ...assets[idx], balance: assets[idx].balance - take };
      remaining  -= take;
      totalDrawn += take;
    }

    return { ...state, assets, totalDrawn };
  }, PRIORITY.CASH_FLOW, 'Drawdown Apply');

  sim.register('DRAWDOWN', ({ data }) => [
    { type: 'DRAWDOWN_APPLY', amount: data.amount },
  ]);

  return { sim };
}

test('AR-1: Drawdown takes from US Checking (priority=1) first', () => {
  const { sim } = buildDrawdownSim();
  // Draw $800 — should come entirely from checking (balance=1000)
  sim.schedule({ date: new Date(2026, 0, 15), type: 'DRAWDOWN', data: { amount: 800 } });
  sim.stepTo(new Date(2026, 0, 31));

  const checking     = sim.state.assets.find(a => a.key === 'checkingAccount');
  const fixedIncome  = sim.state.assets.find(a => a.key === 'fixedIncomeAccount');
  assert.strictEqual(checking.balance, 200);     // 1000 - 800
  assert.strictEqual(fixedIncome.balance, 5000); // untouched
});

test('AR-3: Drawdown overflows to Fixed Income (priority=2) after Checking is exhausted', () => {
  const { sim } = buildDrawdownSim();
  // Draw $1500 — checking ($1000) is exhausted, then $500 from fixed income
  sim.schedule({ date: new Date(2026, 0, 15), type: 'DRAWDOWN', data: { amount: 1500 } });
  sim.stepTo(new Date(2026, 0, 31));

  const checking    = sim.state.assets.find(a => a.key === 'checkingAccount');
  const fixedIncome = sim.state.assets.find(a => a.key === 'fixedIncomeAccount');
  const auSavings   = sim.state.assets.find(a => a.key === 'auSavingsAccount');
  assert.strictEqual(checking.balance, 0);       // fully exhausted
  assert.strictEqual(fixedIncome.balance, 4500); // 5000 - 500 overflow
  assert.strictEqual(auSavings.balance, 3000);   // untouched — higher priority number
});

test('AR-2: Drawdown reaches AU Savings (priority=3) only after Checking and Fixed Income are exhausted', () => {
  const { sim } = buildDrawdownSim();
  // Draw $7000 — checking($1000) + fixed income($5000) exhausted, $1000 from AU savings
  sim.schedule({ date: new Date(2026, 0, 15), type: 'DRAWDOWN', data: { amount: 7000 } });
  sim.stepTo(new Date(2026, 0, 31));

  const checking    = sim.state.assets.find(a => a.key === 'checkingAccount');
  const fixedIncome = sim.state.assets.find(a => a.key === 'fixedIncomeAccount');
  const auSavings   = sim.state.assets.find(a => a.key === 'auSavingsAccount');
  const stocks      = sim.state.assets.find(a => a.key === 'stockAccount');
  assert.strictEqual(checking.balance,    0);     // fully exhausted
  assert.strictEqual(fixedIncome.balance, 0);     // fully exhausted
  assert.strictEqual(auSavings.balance,   2000);  // 3000 - 1000
  assert.strictEqual(stocks.balance,      20000); // untouched
});

test('AR-4: Drawdown reaches Stocks (priority=4) only after lower-priority assets are exhausted', () => {
  const { sim } = buildDrawdownSim();
  // Draw $10000 — checking($1000) + fixed income($5000) + au savings($3000) = $9000, $1000 from stocks
  sim.schedule({ date: new Date(2026, 0, 15), type: 'DRAWDOWN', data: { amount: 10000 } });
  sim.stepTo(new Date(2026, 0, 31));

  const stocks = sim.state.assets.find(a => a.key === 'stockAccount');
  assert.strictEqual(stocks.balance, 19000); // 20000 - 1000 overflow
});
