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
} from '../../src/finance/account.js';
import {
  InvestmentAccount,
  BrokerageAccount,
  FourOhOneKAccount,
  RothAccount,
  TraditionalIRAAccount,
  SuperannuationAccount,
} from '../../src/finance/investment-account.js';
import { AccountService } from '../../src/finance/services/account-service.js';
import { AccountBuilder } from '../../src/finance/builders/account-builder.js';
import { ServiceRegistry } from '../../src/services/service-registry.js';
import { EventBus } from '../../src/simulation-framework/event-bus.js';

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

test('BrokerageAccount: investment fields initialized', () => {
  const a = new BrokerageAccount(50000, { contributionBasis: 40000 });
  assert.strictEqual(a.balance, 50000);
  assert.strictEqual(a.contributionBasis, 40000);
  assert.strictEqual(a.earningsBasis, 0);
  assert.strictEqual(a.loanBalance, 0);
  assert.strictEqual(a.minimumAge, null);
  assert.strictEqual(a.balanceAtResidencyChange, null);
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
  assert.strictEqual(a.minimumAge, 60);
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
  const a = AccountBuilder.checking().initialValue(5000).name('Everyday').build();
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
  const a = AccountBuilder.savings().initialValue(10000).country('AU').currency(AUD).build();
  assert.ok(a instanceof SavingsAccount);
  assert.strictEqual(a.type, 'savings');
  assert.strictEqual(a.balance, 10000);
});

test('AccountBuilder.brokerage: builds BrokerageAccount with investment fields', () => {
  const a = AccountBuilder.brokerage()
    .initialValue(50000)
    .contributionBasis(40000)
    .drawdownPriority(4)
    .build();
  assert.ok(a instanceof BrokerageAccount);
  assert.strictEqual(a.type, 'brokerage');
  assert.strictEqual(a.contributionBasis, 40000);
  assert.strictEqual(a.drawdownPriority, 4);
});

test('AccountBuilder.fourOhOneK: builds FourOhOneKAccount with US defaults', () => {
  const a = AccountBuilder.fourOhOneK().initialValue(120000).build();
  assert.ok(a instanceof FourOhOneKAccount);
  assert.strictEqual(a.type, '401k');
  assert.strictEqual(a.minimumAge, 59.5);
  assert.strictEqual(a.country, 'US');
});

test('AccountBuilder.roth: builds RothAccount with US defaults', () => {
  const a = AccountBuilder.roth().initialValue(80000).build();
  assert.ok(a instanceof RothAccount);
  assert.strictEqual(a.type, 'roth');
  assert.strictEqual(a.minimumAge, 60);
  assert.strictEqual(a.country, 'US');
});

test('AccountBuilder.traditionalIRA: builds TraditionalIRAAccount with US defaults', () => {
  const a = AccountBuilder.traditionalIRA().initialValue(60000).build();
  assert.ok(a instanceof TraditionalIRAAccount);
  assert.strictEqual(a.type, 'ira');
  assert.strictEqual(a.minimumAge, 60);
  assert.strictEqual(a.country, 'US');
});

test('AccountBuilder.super: builds SuperannuationAccount with AU defaults', () => {
  const a = AccountBuilder.super().initialValue(200000).build();
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

test('AccountService: can be constructed without a bus (backward compat)', () => {
  const svc = new AccountService();
  assert.ok(svc);
});

test('AccountService.createAccount: assigns ac-prefixed id', () => {
  const svc = new AccountService(new EventBus());
  const a = new CheckingAccount(1000);
  svc.createAccount(a);
  assert.ok(a.id.startsWith('ac'), `expected id to start with 'ac', got ${a.id}`);
});

test('AccountService.createAccount: registers in service map', () => {
  const svc = new AccountService(new EventBus());
  const a = new SavingsAccount(5000, { name: 'AU Savings' });
  svc.createAccount(a);
  assert.strictEqual(svc.get(a.id), a);
});

test('AccountService.createAccount: publishes CREATE event', () => {
  const bus = new EventBus();
  const svc = new AccountService(bus);
  let fired = false;
  bus.subscribe('SERVICE_ACTION', msg => {
    if (msg.actionType === 'CREATE' && msg.classType === 'Account') fired = true;
  });
  svc.createAccount(new CheckingAccount(0));
  assert.ok(fired);
});

test('AccountService.getAll: returns all registered accounts', () => {
  const svc = new AccountService(new EventBus());
  svc.createAccount(new CheckingAccount(1000));
  svc.createAccount(new SavingsAccount(2000));
  svc.createAccount(new RothAccount(50000));
  assert.strictEqual(svc.getAll().length, 3);
});

test('AccountService.updateAccount: applies changes and publishes UPDATE', () => {
  const bus = new EventBus();
  const svc = new AccountService(bus);
  const a = new CheckingAccount(1000, { name: 'Old Name' });
  svc.createAccount(a);

  let updateFired = false;
  bus.subscribe('SERVICE_ACTION', msg => {
    if (msg.actionType === 'UPDATE' && msg.classType === 'Account') updateFired = true;
  });

  svc.updateAccount(a.id, { name: 'New Name', minimumBalance: 200 });
  assert.strictEqual(a.name, 'New Name');
  assert.strictEqual(a.minimumBalance, 200);
  assert.ok(updateFired);
});

test('AccountService.deleteAccount: removes from map and publishes DELETE', () => {
  const bus = new EventBus();
  const svc = new AccountService(bus);
  const a = new SavingsAccount(3000);
  svc.createAccount(a);

  let deleteFired = false;
  bus.subscribe('SERVICE_ACTION', msg => {
    if (msg.actionType === 'DELETE' && msg.classType === 'Account') deleteFired = true;
  });

  svc.deleteAccount(a.id);
  assert.strictEqual(svc.get(a.id), null);
  assert.ok(deleteFired);
});

test('AccountService: id counter advances so multiple creates get unique ids', () => {
  const svc = new AccountService(new EventBus());
  const a1 = new CheckingAccount(0);
  const a2 = new SavingsAccount(0);
  svc.createAccount(a1);
  svc.createAccount(a2);
  assert.notStrictEqual(a1.id, a2.id);
});

test('AccountService.register: accepts pre-built account and preserves id', () => {
  const svc = new AccountService(new EventBus());
  const a = new FourOhOneKAccount(100000);
  a.id = 'ac-401k-primary';
  svc.register(a);
  assert.strictEqual(svc.get('ac-401k-primary'), a);
});

// ─── AccountService domain methods ────────────────────────────────────────────

test('AccountService.transaction: positive amount credits the account', () => {
  const svc = new AccountService();
  const a = new CheckingAccount(0);
  svc.transaction(a, 500, new Date());
  assert.strictEqual(a.balance, 500);
  assert.strictEqual(a.credits.length, 1);
});

test('AccountService.transaction: negative amount debits the account', () => {
  const svc = new AccountService();
  const a = new CheckingAccount(1000);
  svc.transaction(a, -300, new Date());
  assert.strictEqual(a.balance, 700);
  assert.strictEqual(a.debits.length, 1);
});

test('AccountService.canDebit: true when above minimum after debit', () => {
  const svc = new AccountService();
  const a = new CheckingAccount(1000, { minimumBalance: 500 });
  assert.ok(svc.canDebit(a, 400));
});

test('AccountService.canDebit: false when debit would breach minimum', () => {
  const svc = new AccountService();
  const a = new CheckingAccount(1000, { minimumBalance: 500 });
  assert.ok(!svc.canDebit(a, 600));
});

test('AccountService.safeDebit: applies debit and returns true when allowed', () => {
  const svc = new AccountService();
  const a = new SavingsAccount(5000, { minimumBalance: 1000 });
  const ok = svc.safeDebit(a, 3000, new Date());
  assert.ok(ok);
  assert.strictEqual(a.balance, 2000);
});

test('AccountService.safeDebit: rejects and returns false when breach minimum', () => {
  const svc = new AccountService();
  const a = new SavingsAccount(5000, { minimumBalance: 1000 });
  const ok = svc.safeDebit(a, 4500, new Date());
  assert.ok(!ok);
  assert.strictEqual(a.balance, 5000); // unchanged
});

test('AccountService.recordResidencyChange: snapshots InvestmentAccount balance', () => {
  const svc = new AccountService();
  const a = new BrokerageAccount(75000);
  svc.recordResidencyChange(a);
  assert.strictEqual(a.balanceAtResidencyChange, 75000);
});

test('AccountService.recordResidencyChange: no-op on plain Account', () => {
  const svc = new AccountService();
  const a = new CheckingAccount(5000);
  svc.recordResidencyChange(a); // should not throw
  assert.strictEqual(a.balanceAtResidencyChange, undefined);
});

test('AccountService.recordResidencyChange: second call does not overwrite first snapshot', () => {
  const svc = new AccountService();
  const a = new RothAccount(80000);
  svc.recordResidencyChange(a);
  svc.transaction(a, 10000, new Date());  // balance now 90000
  svc.recordResidencyChange(a);           // should be no-op
  assert.strictEqual(a.balanceAtResidencyChange, 80000);
});

test('AccountService.isWithdrawalEligible: true for account with no minimumAge', () => {
  const svc = new AccountService();
  const a = new BrokerageAccount(50000);
  const person = { birthDate: new Date(1990, 0, 1) };
  assert.ok(svc.isWithdrawalEligible(a, person, new Date(2026, 0, 1)));
});

test('AccountService.isWithdrawalEligible: false for FourOhOneKAccount below 59.5', () => {
  const svc = new AccountService();
  const a = new FourOhOneKAccount(100000);
  const person = { birthDate: new Date(1990, 0, 1) }; // age ~36 in 2026
  assert.ok(!svc.isWithdrawalEligible(a, person, new Date(2026, 0, 15)));
});

test('AccountService.isWithdrawalEligible: true for FourOhOneKAccount at 59.5+', () => {
  const svc = new AccountService();
  const a = new FourOhOneKAccount(100000);
  const person = { birthDate: new Date(1966, 6, 1) }; // age ~60 in 2026
  assert.ok(svc.isWithdrawalEligible(a, person, new Date(2026, 6, 1)));
});

test('AccountService.isWithdrawalEligible: false for RothAccount below 60', () => {
  const svc = new AccountService();
  const a = new RothAccount(80000);
  const person = { birthDate: new Date(1990, 0, 1) }; // age ~36
  assert.ok(!svc.isWithdrawalEligible(a, person, new Date(2026, 0, 1)));
});

test('AccountService.isWithdrawalEligible: true for SuperannuationAccount at 60', () => {
  const svc = new AccountService();
  const a = new SuperannuationAccount(200000);
  const person = { birthDate: new Date(1966, 0, 1) }; // turns 60 in 2026
  assert.ok(svc.isWithdrawalEligible(a, person, new Date(2026, 6, 1)));
});

test('AccountService.getPersonShare: sole returns full balance', () => {
  const svc = new AccountService();
  const a = new CheckingAccount(10000);
  assert.strictEqual(svc.getPersonShare(a), 10000);
});

test('AccountService.getPersonShare: joint returns half balance', () => {
  const svc = new AccountService();
  const a = new CheckingAccount(10000, { ownershipType: 'joint' });
  assert.strictEqual(svc.getPersonShare(a), 5000);
});

// ─── ServiceRegistry integration ──────────────────────────────────────────────

test('ServiceRegistry: exposes accountService', () => {
  ServiceRegistry.reset();
  const registry = ServiceRegistry.getInstance();
  assert.ok(registry.accountService instanceof AccountService);
  ServiceRegistry.reset();
});

test('ServiceRegistry.accountService: shares the same bus as other services', () => {
  ServiceRegistry.reset();
  const registry = ServiceRegistry.getInstance();
  const events = [];
  registry.bus.subscribe('SERVICE_ACTION', e => events.push(e));

  const a = new CheckingAccount(5000, { name: 'Test' });
  registry.accountService.createAccount(a);

  const created = events.find(e => e.actionType === 'CREATE' && e.classType === 'Account');
  assert.ok(created, 'CREATE event should have been published on the shared bus');
  ServiceRegistry.reset();
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
