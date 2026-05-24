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
 * investment-account.test.mjs
 * Tests for InvestmentAccount
 * Run with: node --test tests/investment-account.test.mjs
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import { InvestmentAccount } from '../../src/finance/investment-account.js';

// ── Construction ──────────────────────────────────────────────────────────────

test('InvestmentAccount: sets balance from initialValue', () => {
  const a = new InvestmentAccount(50000);
  assert.strictEqual(a.balance, 50000);
});

test('InvestmentAccount: contributionBasis defaults to initialValue', () => {
  const a = new InvestmentAccount(50000);
  assert.strictEqual(a.contributionBasis, 50000);
});

test('InvestmentAccount: earningsBasis defaults to 0', () => {
  const a = new InvestmentAccount(50000);
  assert.strictEqual(a.earningsBasis, 0);
});

test('InvestmentAccount: balanceAtResidencyChange is null by default', () => {
  const a = new InvestmentAccount(50000);
  assert.strictEqual(a.balanceAtResidencyChange, null);
});

test('InvestmentAccount: loanBalance defaults to 0', () => {
  const a = new InvestmentAccount(50000);
  assert.strictEqual(a.loanBalance, 0);
});

test('InvestmentAccount: minimumAge defaults to null', () => {
  const a = new InvestmentAccount(50000);
  assert.strictEqual(a.minimumAge, null);
});

test('InvestmentAccount: opts override contributionBasis and earningsBasis', () => {
  const a = new InvestmentAccount(80000, { contributionBasis: 60000, earningsBasis: 20000 });
  assert.strictEqual(a.contributionBasis, 60000);
  assert.strictEqual(a.earningsBasis, 20000);
});

test('InvestmentAccount: opts set minimumAge', () => {
  const roth = new InvestmentAccount(100000, { minimumAge: 60 });
  assert.strictEqual(roth.minimumAge, 60);

  const k401 = new InvestmentAccount(200000, { minimumAge: 59.5 });
  assert.strictEqual(k401.minimumAge, 59.5);
});

test('InvestmentAccount: opts set loanBalance for accounts that allow loans', () => {
  const a = new InvestmentAccount(100000, { loanBalance: 20000 });
  assert.strictEqual(a.loanBalance, 20000);
});

// ── Inheritance from Account ──────────────────────────────────────────────────

test('InvestmentAccount: inherits credits and debits arrays from Account', () => {
  const a = new InvestmentAccount(50000);
  assert.deepStrictEqual(a.credits, []);
  assert.deepStrictEqual(a.debits,  []);
});

test('InvestmentAccount: inherits ownershipType from Account (default sole)', () => {
  const a = new InvestmentAccount(50000);
  assert.strictEqual(a.ownershipType, 'sole');
});

test('InvestmentAccount: opts ownershipType passed through to Account', () => {
  const a = new InvestmentAccount(50000, { ownershipType: 'joint' });
  assert.strictEqual(a.ownershipType, 'joint');
});

test('InvestmentAccount: inherits minimumBalance and drawdownPriority from Account', () => {
  const a = new InvestmentAccount(50000, { minimumBalance: 1000, drawdownPriority: 5 });
  assert.strictEqual(a.minimumBalance, 1000);
  assert.strictEqual(a.drawdownPriority, 5);
});

// ── structuredClone safety ────────────────────────────────────────────────────

test('InvestmentAccount: is structuredClone-safe', () => {
  const a  = new InvestmentAccount(50000, {
    contributionBasis: 40000,
    earningsBasis:     10000,
    minimumAge:        60,
    loanBalance:       5000,
    ownershipType:     'joint',
  });
  const a2 = structuredClone(a);

  assert.strictEqual(a2.balance,                  50000);
  assert.strictEqual(a2.contributionBasis,         40000);
  assert.strictEqual(a2.earningsBasis,             10000);
  assert.strictEqual(a2.balanceAtResidencyChange,  null);
  assert.strictEqual(a2.minimumAge,                60);
  assert.strictEqual(a2.loanBalance,               5000);
  assert.strictEqual(a2.ownershipType,             'joint');
  assert.deepStrictEqual(a2.credits, []);
  assert.deepStrictEqual(a2.debits,  []);
});
