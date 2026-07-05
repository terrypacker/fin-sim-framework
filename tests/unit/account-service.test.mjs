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
 * account-service.test.mjs
 *
 * Tests for:
 *   - AccountService CRUD (createAccount, updateAccount, deleteAccount)
 *   - All typed account subclasses (CheckingAccount, SavingsAccount,
 *     BrokerageAccount, FourOhOneKAccount, RothAccount, TraditionalIRAAccount,
 *     SuperannuationAccount)
 *   - AccountBuilder fluent API for every account type
 *   - AccountService registered in ServiceRegistry
 *
 * Run with: node --test tests/unit/account-service.test.mjs
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import {
  ACCOUNT_TYPE,
  Account,
  CheckingAccount,
  SavingsAccount,
  USD,
  AUD,
} from '../../src/finance/assets/account.js';
import {
  InvestmentAccount,
  BrokerageAccount,
  FourOhOneKAccount,
  RothAccount,
  TraditionalIRAAccount,
  SuperannuationAccount,
} from '../../src/finance/assets/investment-account.js';
import { AccountService } from '../../src/finance/services/account-service.js';
import { AccountBuilder } from '../../src/finance/builders/account-builder.js';
import { ServiceRegistry } from '../../src/services/service-registry.js';
import { EventBus } from '../../src/simulation-framework/event-bus.js';
import {Graph} from "../../src/graph/graph.js";
import {GraphQueryApi} from "../../src/graph/graph-query-api.js";

// ─── ACCOUNT_TYPE constants ────────────────────────────────────────────────────

test('ACCOUNT_TYPE: contains all seven expected discriminators', () => {
  assert.strictEqual(ACCOUNT_TYPE.CHECKING,        'checking');
  assert.strictEqual(ACCOUNT_TYPE.SAVINGS,         'savings');
  assert.strictEqual(ACCOUNT_TYPE.BROKERAGE,       'brokerage');
  assert.strictEqual(ACCOUNT_TYPE.FOUR_OH_ONE_K,   '401k');
  assert.strictEqual(ACCOUNT_TYPE.ROTH,            'roth');
  assert.strictEqual(ACCOUNT_TYPE.TRADITIONAL_IRA, 'ira');
  assert.strictEqual(ACCOUNT_TYPE.SUPER,           'super');
});

test('ACCOUNT_TYPE: is frozen (cannot be mutated)', () => {
  assert.throws(() => { ACCOUNT_TYPE.NEW_TYPE = 'test'; }, TypeError);
});

// ─── transaction(): single-holding basis + zero-floor (holdings-balance fix) ─────

test('transaction: debit consumes single-holding cost basis proportionally', () => {
  const svc = new AccountService(new Graph(), new EventBus());
  const account = { balance: 100_000, holdings: [{ id: 'h1', marketValue: 100_000, costBasis: 60_000 }] };
  svc.transaction(account, -25_000, new Date());          // sell 25% of the position
  assert.strictEqual(account.balance, 75_000);
  assert.strictEqual(account.holdings[0].marketValue, 75_000);
  assert.strictEqual(account.holdings[0].costBasis, 45_000); // 60k − 25% = 45k (basis tracks)
});

test('transaction: debit floors marketValue at zero and never strands negative basis', () => {
  const svc = new AccountService(new Graph(), new EventBus());
  const account = { balance: 5_000, holdings: [{ id: 'h1', marketValue: 5_000, costBasis: 5_000 }] };
  svc.transaction(account, -8_000, new Date());           // over-draw beyond available
  assert.strictEqual(account.holdings[0].marketValue, 0); // floored, not negative
  assert.strictEqual(account.holdings[0].costBasis, 0);
});

test('transaction: credit adds basis equal to the deposited market value', () => {
  const svc = new AccountService(new Graph(), new EventBus());
  const account = { balance: 10_000, holdings: [{ id: 'h1', marketValue: 10_000, costBasis: 10_000 }] };
  svc.transaction(account, +5_000, new Date());
  assert.strictEqual(account.holdings[0].marketValue, 15_000);
  assert.strictEqual(account.holdings[0].costBasis, 15_000);
});

test('transaction: multi-holding debit pro-rates across sleeves, keeping Σmv == balance', () => {
  const svc = new AccountService(new Graph(), new EventBus());
  const account = { balance: 100_000, holdings: [
    { id: 'a', marketValue: 60_000, costBasis: 60_000 }, // 60% sleeve
    { id: 'b', marketValue: 40_000, costBasis: 40_000 }, // 40% sleeve
  ] };
  svc.transaction(account, -10_000, new Date());
  assert.strictEqual(account.balance, 90_000);
  assert.strictEqual(account.holdings[0].marketValue, 54_000); // 60% of the 10k withdrawal
  assert.strictEqual(account.holdings[1].marketValue, 36_000); // 40% (residual)
  assert.strictEqual(account.holdings[0].costBasis, 54_000);   // basis tracks value removed
  assert.strictEqual(account.holdings[1].costBasis, 36_000);
  const sumMv = account.holdings.reduce((s, h) => s + h.marketValue, 0);
  assert.strictEqual(+sumMv.toFixed(2), account.balance);      // §4.4 invariant holds
});

test('transaction: multi-holding credit distributes across sleeves by market value', () => {
  const svc = new AccountService(new Graph(), new EventBus());
  const account = { balance: 100_000, holdings: [
    { id: 'a', marketValue: 75_000, costBasis: 50_000 }, // 75% weight
    { id: 'b', marketValue: 25_000, costBasis: 25_000 }, // 25% weight
  ] };
  svc.transaction(account, +1_000, new Date());
  assert.strictEqual(account.balance, 101_000);
  assert.strictEqual(account.holdings[0].marketValue, 75_750); // 75% of the credit
  assert.strictEqual(account.holdings[1].marketValue, 25_250); // 25% (residual)
  // Deposited cash carries basis equal to its market value.
  assert.strictEqual(+(account.holdings[0].costBasis + account.holdings[1].costBasis).toFixed(2), 76_000);
  const sumMv = account.holdings.reduce((s, h) => s + h.marketValue, 0);
  assert.strictEqual(+sumMv.toFixed(2), account.balance);
});

test('transaction: multi-holding over-draw floors every sleeve at zero', () => {
  const svc = new AccountService(new Graph(), new EventBus());
  const account = { balance: 100_000, holdings: [
    { id: 'a', marketValue: 60_000, costBasis: 60_000 },
    { id: 'b', marketValue: 40_000, costBasis: 40_000 },
  ] };
  svc.transaction(account, -150_000, new Date());             // drains past the total
  assert.strictEqual(account.holdings[0].marketValue, 0);
  assert.strictEqual(account.holdings[1].marketValue, 0);
  assert.strictEqual(account.holdings[0].costBasis, 0);
  assert.strictEqual(account.holdings[1].costBasis, 0);
});

// Regression: a mid-year withdrawal from a multi-holding account must survive the
// year-end earnings re-sync. Before the pro-rata fix, transaction() left holdings
// untouched for multi-holding accounts, so HoldingTransactReducer._syncBalance
// (balance = Σ marketValue) snapped the balance back up and erased the withdrawal.
test('transaction: multi-holding withdrawal is NOT reversed by a year-end HOLDING_TRANSACT re-sync', async () => {
  const { HoldingTransactReducer } = await import('../../src/finance/holdings/holding-reducers.js');
  const { computeHoldingsGrowth }  = await import('../../src/finance/holdings/holdings-earnings.js');

  const svc = new AccountService(new Graph(), new EventBus());
  const account = { balance: 200_000, holdings: [
    { id: 'a', marketValue: 120_000, costBasis: 120_000, rateKey: 'EQUITY_US' },
    { id: 'b', marketValue: 80_000,  costBasis: 80_000,  rateKey: 'EQUITY_US' },
  ] };

  // Mid-year: draw 50k to fund spending.
  svc.transaction(account, -50_000, new Date('2027-06-30'));
  assert.strictEqual(account.balance, 150_000);

  // Year-end earnings: compute per-holding growth and apply the HOLDING_TRANSACTs,
  // which re-sync balance to Σ marketValue.
  const state = { usStockAccount: account, effectiveGrowthRates: { EQUITY_US: 0.05 } };
  const { amount, holdingActions } = computeHoldingsGrowth({
    state, stateKey: 'usStockAccount', fallbackRate: 0.05, fallbackRateKey: 'EQUITY_US',
  });
  const reducer = new HoldingTransactReducer();
  let s = state;
  for (const a of holdingActions) s = reducer.reduce(s, a);
  const after = s.usStockAccount;

  // Growth is 5% of the *post-withdrawal* Σmv (150k), not the pre-withdrawal 200k.
  assert.strictEqual(amount, 7_500);
  assert.strictEqual(after.balance, 157_500); // 150k + 7.5k — the 50k draw stuck
  const sumMv = after.holdings.reduce((sm, h) => sm + h.marketValue, 0);
  assert.strictEqual(+sumMv.toFixed(2), after.balance);
});

// ─── Typed account constructors ───────────────────────────────────────────────

test('CheckingAccount: type is checking', () => {
  const a = new CheckingAccount(1000);
  assert.strictEqual(a.type, ACCOUNT_TYPE.CHECKING);
  assert.ok(a instanceof Account);
});

test('CheckingAccount: default fields correct', () => {
  const a = new CheckingAccount(5000, { minimumBalance: 500 });
  assert.strictEqual(a.balance, 5000);
  assert.strictEqual(a.minimumBalance, 500);
  assert.strictEqual(a.id, null);
  assert.strictEqual(a.name, '');
  assert.strictEqual(a.ownershipType, 'sole');
});

test('CheckingAccount: is structuredClone-safe', () => {
  const a = new CheckingAccount(2000, { name: 'Primary', country: 'US', currency: USD });
  const c = structuredClone(a);
  assert.strictEqual(c.balance, 2000);
  assert.strictEqual(c.name, 'Primary');
  assert.strictEqual(c.type, 'checking');
});

test('SavingsAccount: type is savings', () => {
  const a = new SavingsAccount(3000);
  assert.strictEqual(a.type, ACCOUNT_TYPE.SAVINGS);
  assert.ok(a instanceof Account);
});

test('SavingsAccount: opts respected', () => {
  const a = new SavingsAccount(10000, { minimumBalance: 1000, country: 'AU', currency: AUD });
  assert.strictEqual(a.balance, 10000);
  assert.strictEqual(a.minimumBalance, 1000);
  assert.strictEqual(a.country, 'AU');
});

test('BrokerageAccount: type is brokerage and extends InvestmentAccount', () => {
  const a = new BrokerageAccount(50000);
  assert.strictEqual(a.type, ACCOUNT_TYPE.BROKERAGE);
  assert.ok(a instanceof InvestmentAccount);
  assert.ok(a instanceof Account);
});

test('BrokerageAccount: holdings-only investment fields (no basis ledger)', () => {
  const a = new BrokerageAccount(50000);
  assert.strictEqual(a.balance, 50000);
  assert.strictEqual(a.loanBalance, 0);
  assert.strictEqual(a.balanceAtResidencyChange, null);
  // Design 53 §2: the contribution/earnings ledger and age gate moved to
  // RetirementAccount; brokerage carries neither (CGT comes from holdings FIFO).
  assert.ok(!('contributionBasis' in a));
  assert.ok(!('earningsBasis' in a));
  assert.ok(!('minimumAge' in a));
});

test('FourOhOneKAccount: type, country, currency, minimumAge defaults', () => {
  const a = new FourOhOneKAccount(100000);
  assert.strictEqual(a.type, ACCOUNT_TYPE.FOUR_OH_ONE_K);
  assert.strictEqual(a.country, 'US');
  assert.deepStrictEqual(a.currency, USD);
  assert.strictEqual(a.minimumAge, 59.5);
  assert.ok(a instanceof InvestmentAccount);
});

test('FourOhOneKAccount: opts override defaults', () => {
  const a = new FourOhOneKAccount(0, { minimumAge: 55 });
  assert.strictEqual(a.minimumAge, 55);
});

test('RothAccount: type, country, currency, minimumAge defaults', () => {
  const a = new RothAccount(80000);
  assert.strictEqual(a.type, ACCOUNT_TYPE.ROTH);
  assert.strictEqual(a.country, 'US');
  assert.deepStrictEqual(a.currency, USD);
  assert.strictEqual(a.minimumAge, 59.5);
  assert.ok(a instanceof InvestmentAccount);
});

test('TraditionalIRAAccount: type, country, currency, minimumAge defaults', () => {
  const a = new TraditionalIRAAccount(60000);
  assert.strictEqual(a.type, ACCOUNT_TYPE.TRADITIONAL_IRA);
  assert.strictEqual(a.country, 'US');
  assert.deepStrictEqual(a.currency, USD);
  assert.strictEqual(a.minimumAge, 60);
  assert.ok(a instanceof InvestmentAccount);
});

test('SuperannuationAccount: type, country, currency, minimumAge defaults', () => {
  const a = new SuperannuationAccount(200000);
  assert.strictEqual(a.type, ACCOUNT_TYPE.SUPER);
  assert.strictEqual(a.country, 'AU');
  assert.deepStrictEqual(a.currency, AUD);
  assert.strictEqual(a.minimumAge, 60);
  assert.ok(a instanceof InvestmentAccount);
});

test('SuperannuationAccount: opts override country/currency', () => {
  const a = new SuperannuationAccount(0, { country: 'US', currency: USD });
  assert.strictEqual(a.country, 'US');
});

// US-only account types do not accept AU country by default
test('FourOhOneKAccount country defaults to US (cannot be AU by accident)', () => {
  const a = new FourOhOneKAccount(0);
  assert.strictEqual(a.country, 'US');
});

// ─── AccountBuilder ────────────────────────────────────────────────────────────

test('AccountBuilder.checking: builds CheckingAccount with correct type', () => {
  const a = AccountBuilder.checking().balance(5000).name('Everyday').build();
  assert.ok(a instanceof CheckingAccount);
  assert.strictEqual(a.type, 'checking');
  assert.strictEqual(a.balance, 5000);
  assert.strictEqual(a.name, 'Everyday');
});

test('AccountBuilder.checking: minimumBalance and country flow through', () => {
  const a = AccountBuilder.checking()
    .minimumBalance(500)
    .country('US')
    .currency(USD)
    .build();
  assert.strictEqual(a.minimumBalance, 500);
  assert.strictEqual(a.country, 'US');
  assert.deepStrictEqual(a.currency, USD);
});

test('AccountBuilder.savings: builds SavingsAccount', () => {
  const a = AccountBuilder.savings().balance(10000).country('AU').currency(AUD).build();
  assert.ok(a instanceof SavingsAccount);
  assert.strictEqual(a.type, 'savings');
  assert.strictEqual(a.balance, 10000);
});

test('AccountBuilder.brokerage: builds BrokerageAccount (holdings-only, loan supported)', () => {
  const a = AccountBuilder.brokerage()
    .balance(50000)
    .loanBalance(10000)
    .drawdownPriority(4)
    .build();
  assert.ok(a instanceof BrokerageAccount);
  assert.strictEqual(a.type, 'brokerage');
  assert.strictEqual(a.loanBalance, 10000);
  assert.strictEqual(a.drawdownPriority, 4);
  assert.ok(!('contributionBasis' in a)); // design 53 §2: no basis ledger on brokerage
});

test('AccountBuilder.fourOhOneK: builds FourOhOneKAccount with US defaults', () => {
  const a = AccountBuilder.fourOhOneK().balance(120000).build();
  assert.ok(a instanceof FourOhOneKAccount);
  assert.strictEqual(a.type, '401k');
  assert.strictEqual(a.minimumAge, 59.5);
  assert.strictEqual(a.country, 'US');
});

test('AccountBuilder.roth: builds RothAccount with US defaults', () => {
  const a = AccountBuilder.roth().balance(80000).build();
  assert.ok(a instanceof RothAccount);
  assert.strictEqual(a.type, 'roth');
  assert.strictEqual(a.minimumAge, 59.5);
  assert.strictEqual(a.country, 'US');
});

test('AccountBuilder.traditionalIRA: builds TraditionalIRAAccount with US defaults', () => {
  const a = AccountBuilder.traditionalIRA().balance(60000).build();
  assert.ok(a instanceof TraditionalIRAAccount);
  assert.strictEqual(a.type, 'ira');
  assert.strictEqual(a.minimumAge, 60);
  assert.strictEqual(a.country, 'US');
});

test('AccountBuilder.super: builds SuperannuationAccount with AU defaults', () => {
  const a = AccountBuilder.super().balance(200000).build();
  assert.ok(a instanceof SuperannuationAccount);
  assert.strictEqual(a.type, 'super');
  assert.strictEqual(a.minimumAge, 60);
  assert.strictEqual(a.country, 'AU');
  assert.deepStrictEqual(a.currency, AUD);
});

test('AccountBuilder: ownershipType joint is respected', () => {
  const a = AccountBuilder.checking().ownershipType('joint').build();
  assert.strictEqual(a.ownershipType, 'joint');
});

test('AccountBuilder: pre-assigned id is preserved', () => {
  const a = AccountBuilder.savings().id('ac-test-1').build();
  assert.strictEqual(a.id, 'ac-test-1');
});

// ─── AccountService CRUD ──────────────────────────────────────────────────────

test('AccountService.createAccount: assigns ac-prefixed id', () => {
  const graph = new Graph();
  const svc = new AccountService(graph, new GraphQueryApi(graph), new EventBus());
  const a = new CheckingAccount(1000);
  svc.createAccount(a);
  assert.ok(a.id.startsWith('ac'), `expected id to start with 'ac', got ${a.id}`);
});

test('AccountService.createAccount: registers in service map', () => {
  const graph = new Graph();
  const svc = new AccountService(graph, new GraphQueryApi(graph), new EventBus());
  const a = new SavingsAccount(5000, { name: 'AU Savings' });
  svc.createAccount(a);
  assert.strictEqual(svc.get(a.id), a);
});

test('AccountService.createAccount: publishes CREATE event', () => {
  const bus = new EventBus();
  const graph = new Graph();
  const svc = new AccountService(graph, new GraphQueryApi(graph), bus);
  let fired = false;
  bus.subscribe('SERVICE_ACTION', msg => {
    if (msg.actionType === 'CREATE' && msg.item instanceof Account) fired = true;
  });
  svc.createAccount(new CheckingAccount(0));
  assert.ok(fired);
});

test('AccountService.getAll: returns all registered accounts', () => {
  const graph = new Graph();
  const svc = new AccountService(graph, new GraphQueryApi(graph), new EventBus());
  svc.createAccount(new CheckingAccount(1000));
  svc.createAccount(new SavingsAccount(2000));
  svc.createAccount(new RothAccount(50000));
  assert.strictEqual(svc.getAll().length, 3);
});

test('AccountService.updateAccount: applies changes and publishes UPDATE', () => {
  const bus = new EventBus();
  const graph = new Graph();
  const svc = new AccountService(graph, new GraphQueryApi(graph), bus);
  const a = new CheckingAccount(1000, { name: 'Old Name' });
  svc.createAccount(a);

  let updateFired = false;
  bus.subscribe('SERVICE_ACTION', msg => {
    if (msg.actionType === 'UPDATE' && msg.item instanceof Account) updateFired = true;
  });

  svc.updateAccount(a.id, { name: 'New Name', minimumBalance: 200 });
  assert.strictEqual(a.name, 'New Name');
  assert.strictEqual(a.minimumBalance, 200);
  assert.ok(updateFired);
});

test('AccountService.deleteAccount: removes from map and publishes DELETE', () => {
  const bus = new EventBus();
  const graph = new Graph();
  const svc = new AccountService(graph, new GraphQueryApi(graph), bus);
  const a = new SavingsAccount(3000);
  svc.createAccount(a);

  let deleteFired = false;
  bus.subscribe('SERVICE_ACTION', msg => {
    if (msg.actionType === 'DELETE' && msg.item instanceof Account) deleteFired = true;
  });

  svc.deleteAccount(a.id);
  assert.strictEqual(svc.get(a.id), null);
  assert.ok(deleteFired);
});

test('AccountService: id counter advances so multiple creates get unique ids', () => {
  const bus = new EventBus();
  const graph = new Graph();
  const svc = new AccountService(graph, new GraphQueryApi(graph), bus);
  const a1 = new CheckingAccount(0);
  const a2 = new SavingsAccount(0);
  svc.createAccount(a1);
  svc.createAccount(a2);
  assert.notStrictEqual(a1.id, a2.id);
});

test('AccountService.register: accepts pre-built account and preserves id', () => {
  const bus = new EventBus();
  const graph = new Graph();
  const svc = new AccountService(graph, new GraphQueryApi(graph), bus);
  const a = new FourOhOneKAccount(100000);
  a.id = 'ac-401k-primary';
  svc.register(a);
  assert.strictEqual(svc.get('ac-401k-primary'), a);
});

// ─── AccountService domain methods ────────────────────────────────────────────

test('AccountService.transaction: positive amount credits the account', () => {
  const bus = new EventBus();
  const graph = new Graph();
  const svc = new AccountService(graph, new GraphQueryApi(graph), bus);
  const a = new CheckingAccount(0);
  svc.transaction(a, 500, new Date());
  assert.strictEqual(a.balance, 500);
});

test('AccountService.transaction: negative amount debits the account', () => {
  const bus = new EventBus();
  const graph = new Graph();
  const svc = new AccountService(graph, new GraphQueryApi(graph), bus);
  const a = new CheckingAccount(1000);
  svc.transaction(a, -300, new Date());
  assert.strictEqual(a.balance, 700);
});

test('AccountService.canDebit: true when above minimum after debit', () => {
  const bus = new EventBus();
  const graph = new Graph();
  const svc = new AccountService(graph, new GraphQueryApi(graph), bus);
  const a = new CheckingAccount(1000, { minimumBalance: 500 });
  assert.ok(svc.canDebit(a, 400));
});

test('AccountService.canDebit: false when debit would breach minimum', () => {
  const bus = new EventBus();
  const graph = new Graph();
  const svc = new AccountService(graph, new GraphQueryApi(graph), bus);
  const a = new CheckingAccount(1000, { minimumBalance: 500 });
  assert.ok(!svc.canDebit(a, 600));
});

test('AccountService.safeDebit: applies debit and returns true when allowed', () => {
  const bus = new EventBus();
  const graph = new Graph();
  const svc = new AccountService(graph, new GraphQueryApi(graph), bus);
  const a = new SavingsAccount(5000, { minimumBalance: 1000 });
  const ok = svc.safeDebit(a, 3000, new Date());
  assert.ok(ok);
  assert.strictEqual(a.balance, 2000);
});

test('AccountService.safeDebit: rejects and returns false when breach minimum', () => {
  const bus = new EventBus();
  const graph = new Graph();
  const svc = new AccountService(graph, new GraphQueryApi(graph), bus);
  const a = new SavingsAccount(5000, { minimumBalance: 1000 });
  const ok = svc.safeDebit(a, 4500, new Date());
  assert.ok(!ok);
  assert.strictEqual(a.balance, 5000); // unchanged
});

test('AccountService.recordResidencyChange: snapshots InvestmentAccount balance', () => {
  const bus = new EventBus();
  const graph = new Graph();
  const svc = new AccountService(graph, new GraphQueryApi(graph), bus);
  const a = new BrokerageAccount(75000);
  svc.recordResidencyChange(a);
  assert.strictEqual(a.balanceAtResidencyChange, 75000);
});

test('AccountService.recordResidencyChange: no-op on plain Account', () => {
  const bus = new EventBus();
  const graph = new Graph();
  const svc = new AccountService(graph, new GraphQueryApi(graph), bus);
  const a = new CheckingAccount(5000);
  svc.recordResidencyChange(a); // should not throw
  assert.strictEqual(a.balanceAtResidencyChange, undefined);
});

test('AccountService.recordResidencyChange: second call does not overwrite first snapshot', () => {
  const bus = new EventBus();
  const graph = new Graph();
  const svc = new AccountService(graph, new GraphQueryApi(graph), bus);
  const a = new RothAccount(80000);
  svc.recordResidencyChange(a);
  svc.transaction(a, 10000, new Date());  // balance now 90000
  svc.recordResidencyChange(a);           // should be no-op
  assert.strictEqual(a.balanceAtResidencyChange, 80000);
});

test('AccountService.isWithdrawalEligible: true for account with no minimumAge', () => {
  const bus = new EventBus();
  const graph = new Graph();
  const svc = new AccountService(graph, new GraphQueryApi(graph), bus);
  const a = new BrokerageAccount(50000);
  const person = { birthDate: new Date(1990, 0, 1) };
  assert.ok(svc.isWithdrawalEligible(a, person, new Date(2026, 0, 1)));
});

test('AccountService.isWithdrawalEligible: false for FourOhOneKAccount below 59.5', () => {
  const bus = new EventBus();
  const graph = new Graph();
  const svc = new AccountService(graph, new GraphQueryApi(graph), bus);
  const a = new FourOhOneKAccount(100000);
  const person = { birthDate: new Date(1990, 0, 1) }; // age ~36 in 2026
  assert.ok(!svc.isWithdrawalEligible(a, person, new Date(2026, 0, 15)));
});

test('AccountService.isWithdrawalEligible: true for FourOhOneKAccount at 59.5+', () => {
  const bus = new EventBus();
  const graph = new Graph();
  const svc = new AccountService(graph, new GraphQueryApi(graph), bus);
  const a = new FourOhOneKAccount(100000);
  const person = { birthDate: new Date(1966, 6, 1) }; // age ~60 in 2026
  assert.ok(svc.isWithdrawalEligible(a, person, new Date(2026, 6, 1)));
});

test('AccountService.isWithdrawalEligible: false for RothAccount below 60', () => {
  const bus = new EventBus();
  const graph = new Graph();
  const svc = new AccountService(graph, new GraphQueryApi(graph), bus);
  const a = new RothAccount(80000);
  const person = { birthDate: new Date(1990, 0, 1) }; // age ~36
  assert.ok(!svc.isWithdrawalEligible(a, person, new Date(2026, 0, 1)));
});

test('AccountService.isWithdrawalEligible: true for SuperannuationAccount at 60', () => {
  const bus = new EventBus();
  const graph = new Graph();
  const svc = new AccountService(graph, new GraphQueryApi(graph), bus);
  const a = new SuperannuationAccount(200000);
  const person = { birthDate: new Date(1966, 0, 1) }; // turns 60 in 2026
  assert.ok(svc.isWithdrawalEligible(a, person, new Date(2026, 6, 1)));
});

test('AccountService.getPersonShare: sole returns full balance', () => {
  const bus = new EventBus();
  const graph = new Graph();
  const svc = new AccountService(graph, new GraphQueryApi(graph), bus);
  const a = new CheckingAccount(10000);
  assert.strictEqual(svc.getPersonShare(a), 10000);
});

test('AccountService.getPersonShare: joint returns half balance', () => {
  const bus = new EventBus();
  const graph = new Graph();
  const svc = new AccountService(graph, new GraphQueryApi(graph), bus);
  const a = new CheckingAccount(10000, { ownershipType: 'joint' });
  assert.strictEqual(svc.getPersonShare(a), 5000);
});

// ─── ServiceRegistry integration ──────────────────────────────────────────────

test('ServiceRegistry: exposes accountService', () => {
  ServiceRegistry.resetAll();
  const registry = ServiceRegistry.getInstance();
  assert.ok(registry.accountService instanceof AccountService);
  ServiceRegistry.resetAll();
});

test('ServiceRegistry.accountService: shares the same bus as other services', () => {
  ServiceRegistry.resetAll();
  const registry = ServiceRegistry.getInstance();
  const events = [];
  registry.bus.subscribe('SERVICE_ACTION', e => events.push(e));

  const a = new CheckingAccount(5000, { name: 'Test' });
  registry.accountService.createAccount(a);

  const created = events.find(e => e.actionType === 'CREATE' && e.item instanceof Account);
  assert.ok(created, 'CREATE event should have been published on the shared bus');
  ServiceRegistry.resetAll();
});

// ─── Account type country/currency coverage ────────────────────────────────────

test('US-only types default to US country', () => {
  for (const acct of [new FourOhOneKAccount(0), new RothAccount(0), new TraditionalIRAAccount(0)]) {
    assert.strictEqual(acct.country, 'US', `${acct.type} should default to US`);
    assert.deepStrictEqual(acct.currency, USD, `${acct.type} should default to USD`);
  }
});

test('AU-only type defaults to AU country', () => {
  const a = new SuperannuationAccount(0);
  assert.strictEqual(a.country, 'AU');
  assert.deepStrictEqual(a.currency, AUD);
});

test('US+AU types have no default country (caller sets)', () => {
  for (const acct of [new CheckingAccount(0), new SavingsAccount(0), new BrokerageAccount(0)]) {
    assert.strictEqual(acct.country, null, `${acct.type} should have null country by default`);
  }
});

// ─── AccountService.replenishSavings ──────────────────────────────────────────

test('replenishSavings: returns keys of accounts drawn from', () => {
  const bus = new EventBus();
  const graph = new Graph();
  const svc = new AccountService(graph, new GraphQueryApi(graph), bus);
  const date  = new Date(2026, 0, 1);
  const savings  = new CheckingAccount(0, { country: 'US', currency: USD });
  const brokerage = new BrokerageAccount(50000, { country: 'US', currency: USD, drawdownPriority: 1 });
  const state = {
    savingsAccount:   savings,
    brokerageAccount: brokerage,
    personBirthDate:  new Date(1970, 0, 1),
  };

  const { drawnKeys } = svc.replenishSavings(state, 'savingsAccount', 10000, date);
  assert.deepStrictEqual(drawnKeys, ['brokerageAccount']);
  assert.strictEqual(savings.balance,   10000);
  assert.strictEqual(brokerage.balance, 40000);
});

test('replenishSavings: returns multiple keys when deficit spans accounts', () => {
  const bus = new EventBus();
  const graph = new Graph();
  const svc = new AccountService(graph, new GraphQueryApi(graph), bus);
  const date = new Date(2026, 0, 1);
  const savings    = new CheckingAccount(0, { country: 'US', currency: USD });
  const accountA   = new BrokerageAccount(3000,  { country: 'US', currency: USD, drawdownPriority: 1 });
  const accountB   = new BrokerageAccount(20000, { country: 'US', currency: USD, drawdownPriority: 2 });
  const state = {
    savingsAccount: savings,
    accountA,
    accountB,
    personBirthDate: new Date(1970, 0, 1),
  };

  const { drawnKeys } = svc.replenishSavings(state, 'savingsAccount', 5000, date);
  assert.deepStrictEqual(drawnKeys, ['accountA', 'accountB']);
});

test('replenishSavings: phase-1 draws eligible accounts before early-withdrawal accounts', () => {
  const bus = new EventBus();
  const graph = new Graph();
  const svc = new AccountService(graph, new GraphQueryApi(graph), bus);
  const date = new Date(2026, 0, 1);
  const savings  = new CheckingAccount(0, { country: 'US', currency: USD });
  // 401k is below minimumAge — will only be drawn if eligible account is insufficient
  const locked   = new FourOhOneKAccount(50000, { country: 'US', currency: USD, drawdownPriority: 1 });
  const eligible = new BrokerageAccount(20000,   { country: 'US', currency: USD, drawdownPriority: 2 });
  const state = {
    savingsAccount: savings,
    lockedAccount:  locked,
    eligibleAccount: eligible,
    personBirthDate: new Date(1990, 0, 1), // age 36, below 401k minimumAge 59.5
  };

  const { drawnKeys } = svc.replenishSavings(state, 'savingsAccount', 5000, date);
  assert.deepStrictEqual(drawnKeys, ['eligibleAccount']);
  assert.strictEqual(locked.balance, 50000); // untouched — eligible account covered the deficit
});

test('replenishSavings: spouse super account age-gate uses spouse birthDate, not primary', () => {
  // Regression: replenishSavings was using the target account owner's birthDate for ALL
  // source accounts, so a spouse's super account (minimumAge=60) was unlocked when the
  // PRIMARY person turned 60 even if the spouse was still 55.
  const bus = new EventBus();
  const graph = new Graph();
  const svc = new AccountService(graph, new GraphQueryApi(graph), bus);
  // Primary is 60, spouse is 55 — sim date is primary's 60th birthday year.
  const simDate    = new Date(2026, 6, 1);
  const primaryDOB = new Date(1966, 0, 1);  // age ~60
  const spouseDOB  = new Date(1971, 0, 1);  // age ~55

  const auSavings   = new SavingsAccount(0,      { country: 'AU', currency: AUD, ownerId: 'primary' });
  const spouseSuper = new SuperannuationAccount(100_000, { country: 'AU', currency: AUD, drawdownPriority: 1, ownerId: 'spouse' });
  const state = {
    auSavings,
    spouseSuper,
    people: {
      primary: { birthDate: primaryDOB, residency: 'AU' },
      spouse:  { birthDate: spouseDOB,  residency: 'AU' },
    },
  };

  // The deficit cannot be covered — spouse super should be blocked (spouse < 60).
  assert.throws(
    () => svc.replenishSavings(state, 'auSavings', 10_000, simDate),
    /InsufficientFunds/,
    'spouse super must be blocked because the spouse is under 60'
  );
  assert.strictEqual(spouseSuper.balance, 100_000, 'spouse super balance must be unchanged');
});

// ─── reduceLedgerForWithdrawal (design 43 §3) ─────────────────────────────────

const mkSvc = () => {
  const graph = new Graph();
  return new AccountService(graph, new GraphQueryApi(graph), new EventBus());
};

test('reduceLedgerForWithdrawal: ROTH draws contributions first, then earnings', () => {
  const svc = mkSvc();
  const roth = new RothAccount(100_000, { contributionBasis: 60_000, earningsBasis: 40_000 });
  svc.reduceLedgerForWithdrawal(roth, 50_000); // wholly from contributions
  assert.strictEqual(roth.contributionBasis, 10_000);
  assert.strictEqual(roth.earningsBasis,     40_000);
  svc.reduceLedgerForWithdrawal(roth, 30_000); // 10k contrib remaining, then 20k earnings
  assert.strictEqual(roth.contributionBasis, 0);
  assert.strictEqual(roth.earningsBasis,     20_000);
});

test('reduceLedgerForWithdrawal: 401k draws earnings first, then contributions', () => {
  const svc = mkSvc();
  const k = new FourOhOneKAccount(100_000, { contributionBasis: 70_000, earningsBasis: 30_000 });
  svc.reduceLedgerForWithdrawal(k, 50_000);
  assert.strictEqual(k.earningsBasis,     0);
  assert.strictEqual(k.contributionBasis, 50_000);
});

test('reduceLedgerForWithdrawal: super reduces both components proportionally', () => {
  const svc = mkSvc();
  const s = new SuperannuationAccount(200_000, { contributionBasis: 150_000, earningsBasis: 50_000 });
  svc.reduceLedgerForWithdrawal(s, 100_000); // 75% / 25% split
  assert.strictEqual(s.contributionBasis, 75_000);
  assert.strictEqual(s.earningsBasis,     25_000);
});

test('reduceLedgerForWithdrawal: draw exceeding the ledger floors both at zero', () => {
  const svc = mkSvc();
  const s = new SuperannuationAccount(40_000, { contributionBasis: 30_000, earningsBasis: 10_000 });
  svc.reduceLedgerForWithdrawal(s, 1_000_000);
  assert.strictEqual(s.contributionBasis, 0);
  assert.strictEqual(s.earningsBasis,     0);
});

test('reduceLedgerForWithdrawal: no-op on a plain cash account (no ledger fields)', () => {
  const svc = mkSvc();
  const cash = new CheckingAccount(50_000, { country: 'US', currency: USD });
  assert.doesNotThrow(() => svc.reduceLedgerForWithdrawal(cash, 10_000));
  assert.ok(!('contributionBasis' in cash), 'must not add ledger fields to a cash account');
});

test('replenishSavings: eligible super drawdown keeps the ledger tied to balance (design 43)', () => {
  // Trigger regression: an age-eligible super/IRA/401k drawn via the drawdown
  // engine moved `balance` but left contributionBasis/earningsBasis frozen,
  // producing e.g. contributionBasis 180k vs balance 39k.
  const svc = mkSvc();
  const simDate = new Date(2026, 6, 1);
  const dob = new Date(1956, 0, 1); // age ~70, past the 60 preservation age

  const auSavings = new SavingsAccount(0, { country: 'AU', currency: AUD, ownerId: 'primary' });
  const superAcct = new SuperannuationAccount(100_000, {
    country: 'AU', currency: AUD, drawdownPriority: 1, ownerId: 'primary',
    contributionBasis: 80_000, earningsBasis: 20_000,
  });
  const state = {
    auSavings,
    superAcct,
    people: { primary: { birthDate: dob, residency: 'AU' } },
  };

  svc.replenishSavings(state, 'auSavings', 30_000, simDate);

  assert.strictEqual(superAcct.balance, 70_000);
  assert.ok(
    Math.abs((superAcct.contributionBasis + superAcct.earningsBasis) - superAcct.balance) < 0.01,
    'contributionBasis + earningsBasis must equal balance after an eligible super draw'
  );
  assert.strictEqual(superAcct.contributionBasis, 56_000); // 80% of 70k (proportional)
  assert.strictEqual(superAcct.earningsBasis,     14_000); // 20% of 70k
});

// ─── eligible-withdrawal tax actions (design 44 Gap B) ────────────────────────

const eligibleState = (sourceKey, sourceAcct, residency = 'US', targetCcy = USD, targetCountry = 'US') => ({
  targetSavings: new SavingsAccount(0, { country: targetCountry, currency: targetCcy, ownerId: 'primary' }),
  [sourceKey]:   sourceAcct,
  people: { primary: { birthDate: new Date(1956, 0, 1), residency } }, // age ~70, eligible everywhere
});

test('replenishSavings: eligible IRA draw emits ordinary-income tax actions (contrib + earnings)', () => {
  const svc = mkSvc();
  const ira = new TraditionalIRAAccount(100_000, {
    country: 'US', currency: USD, drawdownPriority: 1, ownerId: 'primary',
    contributionBasis: 60_000, earningsBasis: 40_000,
  });
  const state = eligibleState('ira', ira);
  const { pendingTaxActions } = svc.replenishSavings(state, 'targetSavings', 80_000, new Date(2026, 6, 1));
  const contrib  = pendingTaxActions.find(a => a.type === 'IRA_WITHDRAWAL_CONTRIB_TAX');
  const earnings = pendingTaxActions.find(a => a.type === 'IRA_WITHDRAWAL_EARNINGS_TAX');
  assert.ok(contrib && earnings, 'both IRA tax actions emitted');
  assert.strictEqual(contrib.amount,  60_000);  // contributions drawn first
  assert.strictEqual(earnings.amount, 20_000);  // then earnings
  assert.strictEqual(contrib.penaltyAmount, 0); // no penalty when eligible
  assert.strictEqual(earnings.penaltyAmount, 0);
});

test('replenishSavings: eligible 401k draw emits a single ordinary-income tax action on the gross', () => {
  const svc = mkSvc();
  const k = new FourOhOneKAccount(100_000, {
    country: 'US', currency: USD, drawdownPriority: 1, ownerId: 'primary',
    contributionBasis: 70_000, earningsBasis: 30_000,
  });
  const state = eligibleState('k401', k);
  const { pendingTaxActions } = svc.replenishSavings(state, 'targetSavings', 40_000, new Date(2026, 6, 1));
  const tax = pendingTaxActions.filter(a => a.type === 'K401_WITHDRAWAL_TAX');
  assert.strictEqual(tax.length, 1);
  assert.strictEqual(tax[0].amount, 40_000);
  assert.strictEqual(tax[0].penaltyAmount, 0);
});

test('replenishSavings: eligible super draw taxes only the earnings portion', () => {
  const svc = mkSvc();
  const superAcct = new SuperannuationAccount(100_000, {
    country: 'AU', currency: AUD, drawdownPriority: 1, ownerId: 'primary',
    contributionBasis: 80_000, earningsBasis: 20_000,
  });
  const state = eligibleState('superAcct', superAcct, 'AU', AUD, 'AU');
  const { pendingTaxActions } = svc.replenishSavings(state, 'targetSavings', 30_000, new Date(2026, 6, 1));
  const tax = pendingTaxActions.filter(a => a.type === 'SUPER_WITHDRAWAL_EARNINGS_TAX');
  assert.strictEqual(tax.length, 1);
  assert.strictEqual(tax[0].amount, 6_000); // 20% of 30k (proportional earnings portion)
});

test('replenishSavings: eligible (qualified) Roth draw emits NO tax action', () => {
  const svc = mkSvc();
  const roth = new RothAccount(100_000, {
    country: 'US', currency: USD, drawdownPriority: 1, ownerId: 'primary',
    contributionBasis: 60_000, earningsBasis: 40_000,
  });
  const state = eligibleState('roth', roth);
  const { pendingTaxActions } = svc.replenishSavings(state, 'targetSavings', 50_000, new Date(2026, 6, 1));
  assert.strictEqual(pendingTaxActions.length, 0, 'qualified Roth withdrawal is tax-free');
});
