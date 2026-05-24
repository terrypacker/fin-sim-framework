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
 * asset-service.test.mjs
 * Tests for AssetService
 * Run with: node --test tests/asset-service.test.mjs
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import { Asset }        from '../src/finance/asset.js';
import { AssetService } from '../src/finance/asset-service.js';

const svc = new AssetService();

// ── getPersonShare ────────────────────────────────────────────────────────────

test('AssetService.getPersonShare: sole ownership returns full value', () => {
  const a = new Asset('House', 800000, 300000, { ownershipType: 'sole' });
  assert.strictEqual(svc.getPersonShare(a), 800000);
});

test('AssetService.getPersonShare: joint ownership returns half the value', () => {
  const a = new Asset('House', 800000, 300000, { ownershipType: 'joint' });
  assert.strictEqual(svc.getPersonShare(a), 400000);
});

test('AssetService.getPersonShare: joint with zero value returns 0', () => {
  const a = new Asset('Lot', 0, 0, { ownershipType: 'joint' });
  assert.strictEqual(svc.getPersonShare(a), 0);
});

// ── recordResidencyChange ─────────────────────────────────────────────────────

test('AssetService.recordResidencyChange: snapshots current value when null', () => {
  const a = new Asset('House', 700000, 300000);
  assert.strictEqual(a.balanceAtResidencyChange, null);
  svc.recordResidencyChange(a);
  assert.strictEqual(a.balanceAtResidencyChange, 700000);
});

test('AssetService.recordResidencyChange: does not overwrite existing snapshot', () => {
  const a = new Asset('House', 700000, 300000);
  svc.recordResidencyChange(a);        // first change — snapshots 700000
  a.value = 800000;                    // value increases
  svc.recordResidencyChange(a);        // second call — should be no-op
  assert.strictEqual(a.balanceAtResidencyChange, 700000); // still first snapshot
});

// ── takeLoan ──────────────────────────────────────────────────────────────────

test('AssetService.takeLoan: increases loanBalance by the loan amount', () => {
  const a = new Asset('House', 800000, 300000, { loanBalance: 0 });
  svc.takeLoan(a, 100000);
  assert.strictEqual(a.loanBalance, 100000);
});

test('AssetService.takeLoan: accumulates multiple loan draws', () => {
  const a = new Asset('House', 800000, 300000, { loanBalance: 50000 });
  svc.takeLoan(a, 30000);
  assert.strictEqual(a.loanBalance, 80000);
});

test('AssetService.takeLoan: does not change the asset value', () => {
  const a = new Asset('House', 800000, 300000);
  svc.takeLoan(a, 100000);
  assert.strictEqual(a.value, 800000); // unchanged
});

// ── repayLoan ─────────────────────────────────────────────────────────────────

test('AssetService.repayLoan: decreases loanBalance by the repayment amount', () => {
  const a = new Asset('House', 800000, 300000, { loanBalance: 100000 });
  svc.repayLoan(a, 40000);
  assert.strictEqual(a.loanBalance, 60000);
});

test('AssetService.repayLoan: floors loanBalance at 0 on overpayment', () => {
  const a = new Asset('House', 800000, 300000, { loanBalance: 30000 });
  svc.repayLoan(a, 50000);
  assert.strictEqual(a.loanBalance, 0);
});

test('AssetService.repayLoan: full repayment clears the balance', () => {
  const a = new Asset('House', 800000, 300000, { loanBalance: 100000 });
  svc.repayLoan(a, 100000);
  assert.strictEqual(a.loanBalance, 0);
});

// ── takeLoan / repayLoan work on InvestmentAccount too (duck-typed) ───────────

test('AssetService.takeLoan and repayLoan work on any object with loanBalance', () => {
  // InvestmentAccount also has loanBalance — service is duck-typed
  const obj = { loanBalance: 0, value: 0 }; // minimal duck
  svc.takeLoan(obj, 20000);
  assert.strictEqual(obj.loanBalance, 20000);
  svc.repayLoan(obj, 5000);
  assert.strictEqual(obj.loanBalance, 15000);
});
