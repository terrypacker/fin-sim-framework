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

import { Account, AccountService } from '../assets/js/finance/account.js';

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
