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
 * account.test.mjs
 * Tests for Account and AccountService
 * Run with: node --test tests/account.test.mjs
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import { Account, AccountService } from '../../src/finance/account.js';
import { InvestmentAccount }       from '../../src/finance/investment-account.js';
import { Person }                  from '../../src/finance/person.js';

const DATE = new Date(2025, 0, 1);

// ─── Account construction ─────────────────────────────────────────────────────

test('Account: default initial balance is 0', () => {
  const a = new Account();
  assert.strictEqual(a.balance, 0);
});

test('Account: accepts a non-zero initial balance', () => {
  const a = new Account(500);
  assert.strictEqual(a.balance, 500);
});

test('Account: starts with empty credits and debits arrays', () => {
  const a = new Account(0);
  assert.deepStrictEqual(a.credits, []);
  assert.deepStrictEqual(a.debits,  []);
});

// ─── AccountService: credits (positive amounts) ───────────────────────────────

test('AccountService.transaction: positive amount increases balance', () => {
  const svc = new AccountService();
  const acc = new Account(0);

  svc.transaction(acc, 200, DATE);

  assert.strictEqual(acc.balance, 200);
});

test('AccountService.transaction: positive amount appends to credits', () => {
  const svc = new AccountService();
  const acc = new Account(0);

  svc.transaction(acc, 200, DATE);

  assert.strictEqual(acc.credits.length, 1);
  assert.strictEqual(acc.credits[0].amount, 200);
  assert.strictEqual(acc.credits[0].date,   DATE);
});

test('AccountService.transaction: positive amount does not touch debits', () => {
  const svc = new AccountService();
  const acc = new Account(0);

  svc.transaction(acc, 200, DATE);

  assert.strictEqual(acc.debits.length, 0);
});

test('AccountService.transaction: multiple credits accumulate correctly', () => {
  const svc  = new AccountService();
  const acc  = new Account(0);
  const d2   = new Date(2025, 3, 1);

  svc.transaction(acc, 100, DATE);
  svc.transaction(acc, 250, d2);

  assert.strictEqual(acc.balance, 350);
  assert.strictEqual(acc.credits.length, 2);
  assert.strictEqual(acc.credits[1].amount, 250);
  assert.strictEqual(acc.credits[1].date,   d2);
});

// ─── AccountService: debits (negative amounts) ────────────────────────────────

test('AccountService.transaction: negative amount decreases balance', () => {
  const svc = new AccountService();
  const acc = new Account(1000);

  svc.transaction(acc, -300, DATE);

  assert.strictEqual(acc.balance, 700);
});

test('AccountService.transaction: negative amount appends to debits', () => {
  const svc = new AccountService();
  const acc = new Account(1000);

  svc.transaction(acc, -300, DATE);

  assert.strictEqual(acc.debits.length, 1);
  assert.strictEqual(acc.debits[0].amount, -300);
  assert.strictEqual(acc.debits[0].date,    DATE);
});

test('AccountService.transaction: negative amount does not touch credits', () => {
  const svc = new AccountService();
  const acc = new Account(1000);

  svc.transaction(acc, -300, DATE);

  assert.strictEqual(acc.credits.length, 0);
});

test('AccountService.transaction: multiple debits reduce balance correctly', () => {
  const svc = new AccountService();
  const acc = new Account(1000);

  svc.transaction(acc, -100, DATE);
  svc.transaction(acc, -200, DATE);

  assert.strictEqual(acc.balance, 700);
  assert.strictEqual(acc.debits.length, 2);
});

test('AccountService.transaction: debit can reduce balance below zero', () => {
  const svc = new AccountService();
  const acc = new Account(100);

  svc.transaction(acc, -150, DATE);

  assert.strictEqual(acc.balance, -50);
});

// ─── AccountService: zero amount ──────────────────────────────────────────────

test('AccountService.transaction: zero amount leaves balance unchanged', () => {
  const svc = new AccountService();
  const acc = new Account(500);

  svc.transaction(acc, 0, DATE);

  assert.strictEqual(acc.balance,        500);
  assert.strictEqual(acc.credits.length, 0);
  assert.strictEqual(acc.debits.length,  0);
});

// ─── AccountService: mixed credits and debits ─────────────────────────────────

test('AccountService.transaction: interleaved credits and debits reach correct balance', () => {
  const svc = new AccountService();
  const acc = new Account(0);

  svc.transaction(acc,  1000, DATE);   // +1000 → 1000
  svc.transaction(acc,  -300, DATE);   //  -300 →  700
  svc.transaction(acc,   500, DATE);   //  +500 → 1200
  svc.transaction(acc,  -200, DATE);   //  -200 → 1000

  assert.strictEqual(acc.balance,        1000);
  assert.strictEqual(acc.credits.length, 2);
  assert.strictEqual(acc.debits.length,  2);
});

test('AccountService.transaction: non-zero initial balance is included in running total', () => {
  const svc = new AccountService();
  const acc = new Account(500);

  svc.transaction(acc, 200, DATE);
  svc.transaction(acc, -100, DATE);

  assert.strictEqual(acc.balance, 600);
});

// ─── Account opts (ownership, minimum balance, drawdown priority) ─────────────

test('Account: default ownershipType is sole', () => {
  assert.strictEqual(new Account(0).ownershipType, 'sole');
});

test('Account: opts.ownershipType sets joint ownership', () => {
  assert.strictEqual(new Account(0, { ownershipType: 'joint' }).ownershipType, 'joint');
});

test('Account: default minimumBalance is 0', () => {
  assert.strictEqual(new Account(0).minimumBalance, 0);
});

test('Account: opts.minimumBalance is set correctly', () => {
  assert.strictEqual(new Account(1000, { minimumBalance: 500 }).minimumBalance, 500);
});

test('Account: default drawdownPriority is null', () => {
  assert.strictEqual(new Account(0).drawdownPriority, null);
});

test('Account: opts.drawdownPriority is set correctly', () => {
  assert.strictEqual(new Account(0, { drawdownPriority: 1 }).drawdownPriority, 1);
});

test('Account: default ownerId is null', () => {
  assert.strictEqual(new Account(0).ownerId, null);
});

// ─── AccountService.getPersonShare ───────────────────────────────────────────

test('AccountService.getPersonShare: sole ownership returns full balance', () => {
  const svc = new AccountService();
  const acc = new Account(10000, { ownershipType: 'sole' });
  assert.strictEqual(svc.getPersonShare(acc), 10000);
});

test('AccountService.getPersonShare: joint ownership returns half the balance', () => {
  const svc = new AccountService();
  const acc = new Account(10000, { ownershipType: 'joint' });
  assert.strictEqual(svc.getPersonShare(acc), 5000);
});

test('AccountService.getPersonShare: joint with zero balance returns 0', () => {
  const svc = new AccountService();
  const acc = new Account(0, { ownershipType: 'joint' });
  assert.strictEqual(svc.getPersonShare(acc), 0);
});

// ─── AccountService.canDebit ──────────────────────────────────────────────────

test('AccountService.canDebit: returns true when debit keeps balance above minimum', () => {
  const svc = new AccountService();
  const acc = new Account(1000, { minimumBalance: 500 });
  assert.strictEqual(svc.canDebit(acc, 400), true); // 1000 - 400 = 600 > 500
});

test('AccountService.canDebit: returns true when debit reaches exactly minimum', () => {
  const svc = new AccountService();
  const acc = new Account(1000, { minimumBalance: 500 });
  assert.strictEqual(svc.canDebit(acc, 500), true); // 1000 - 500 = 500 = min
});

test('AccountService.canDebit: returns false when debit would breach minimum', () => {
  const svc = new AccountService();
  const acc = new Account(1000, { minimumBalance: 500 });
  assert.strictEqual(svc.canDebit(acc, 600), false); // 1000 - 600 = 400 < 500
});

test('AccountService.canDebit: no minimum (default 0) allows any non-negative debit', () => {
  const svc = new AccountService();
  const acc = new Account(100);
  assert.strictEqual(svc.canDebit(acc, 100), true);
  assert.strictEqual(svc.canDebit(acc, 101), false); // would go negative
});

// ─── AccountService.safeDebit ─────────────────────────────────────────────────

test('AccountService.safeDebit: applies debit and returns true when allowed', () => {
  const svc = new AccountService();
  const acc = new Account(1000, { minimumBalance: 500 });
  const result = svc.safeDebit(acc, 400, DATE);
  assert.strictEqual(result, true);
  assert.strictEqual(acc.balance, 600);
});

test('AccountService.safeDebit: rejects debit and returns false when it would breach minimum', () => {
  const svc = new AccountService();
  const acc = new Account(1000, { minimumBalance: 500 });
  const result = svc.safeDebit(acc, 600, DATE);
  assert.strictEqual(result, false);
  assert.strictEqual(acc.balance, 1000); // unchanged
  assert.strictEqual(acc.debits.length, 0); // no entry recorded
});

// ─── AccountService.isWithdrawalEligible ─────────────────────────────────────

test('AccountService.isWithdrawalEligible: returns true when account has no minimumAge', () => {
  const svc2 = new AccountService();
  const acct = new InvestmentAccount(50000); // minimumAge = null
  const p    = new Person('p1', new Date(1990, 0, 1));
  assert.strictEqual(svc2.isWithdrawalEligible(acct, p, new Date(2026, 0, 1)), true);
});

test('AccountService.isWithdrawalEligible: returns false below minimumAge', () => {
  const svc2  = new AccountService();
  const roth  = new InvestmentAccount(50000, { minimumAge: 60 });
  const young = new Person('p1', new Date(1990, 0, 1)); // age 36 in 2026
  assert.strictEqual(svc2.isWithdrawalEligible(roth, young, new Date(2026, 0, 15)), false);
});

test('AccountService.isWithdrawalEligible: returns true at or above minimumAge', () => {
  const svc2 = new AccountService();
  const roth = new InvestmentAccount(50000, { minimumAge: 60 });
  const p    = new Person('p1', new Date(1966, 0, 1)); // turns 60 on 2026-01-01
  assert.strictEqual(svc2.isWithdrawalEligible(roth, p, new Date(2026, 1, 1)), true);
});

test('AccountService.isWithdrawalEligible: 59.5 gate for 401k style accounts', () => {
  const svc2 = new AccountService();
  const k401 = new InvestmentAccount(100000, { minimumAge: 59.5 });
  // Clearly above 59.5 — born 1966, age ~60 in 2026
  const older   = new Person('p1', new Date(1966, 0, 1));
  assert.strictEqual(svc2.isWithdrawalEligible(k401, older, new Date(2026, 3, 1)), true);
  // Clearly below 59.5 — born 1990, age ~36 in 2026
  const younger = new Person('p2', new Date(1990, 0, 1));
  assert.strictEqual(svc2.isWithdrawalEligible(k401, younger, new Date(2026, 0, 15)), false);
});
