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
 * asset.test.mjs
 * Tests for Asset
 * Run with: node --test tests/asset.test.mjs
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import { Asset } from '../assets/js/finance/asset.js';

test('Asset: constructor assigns name, value, and costBasis', () => {
  const a = new Asset('AAPL', 15000, 10000);
  assert.strictEqual(a.name,      'AAPL');
  assert.strictEqual(a.value,     15000);
  assert.strictEqual(a.costBasis, 10000);
});

test('Asset: default values are empty string and zero', () => {
  const a = new Asset();
  assert.strictEqual(a.name,      '');
  assert.strictEqual(a.value,     0);
  assert.strictEqual(a.costBasis, 0);
});

test('Asset: partial defaults — name only', () => {
  const a = new Asset('MSFT');
  assert.strictEqual(a.name,      'MSFT');
  assert.strictEqual(a.value,     0);
  assert.strictEqual(a.costBasis, 0);
});

test('Asset: fields are writable after construction', () => {
  const a = new Asset('X', 100, 50);
  a.value = 200;
  assert.strictEqual(a.value, 200);
});

test('Asset: realized gain can be derived as value minus costBasis', () => {
  const a = new Asset('TSLA', 9200, 1200);
  assert.strictEqual(a.value - a.costBasis, 8000);
});

test('Asset: zero gain when value equals costBasis', () => {
  const a = new Asset('FLAT', 5000, 5000);
  assert.strictEqual(a.value - a.costBasis, 0);
});

test('Asset: negative gain (loss) is representable', () => {
  const a = new Asset('LOSS', 500, 1000);
  assert.strictEqual(a.value - a.costBasis, -500);
});

// ─── Asset opts (ownership, drawdown, residency, loan) ───────────────────────

test('Asset: default ownershipType is sole', () => {
  assert.strictEqual(new Asset('X', 1000, 500).ownershipType, 'sole');
});

test('Asset: opts.ownershipType sets joint ownership', () => {
  const a = new Asset('X', 1000, 500, { ownershipType: 'joint' });
  assert.strictEqual(a.ownershipType, 'joint');
});

test('Asset: default ownerId is null', () => {
  assert.strictEqual(new Asset().ownerId, null);
});

test('Asset: default drawdownPriority is null', () => {
  assert.strictEqual(new Asset().drawdownPriority, null);
});

test('Asset: opts.drawdownPriority is set correctly', () => {
  const a = new Asset('House', 800000, 300000, { drawdownPriority: 10 });
  assert.strictEqual(a.drawdownPriority, 10);
});

test('Asset: default balanceAtResidencyChange is null', () => {
  assert.strictEqual(new Asset().balanceAtResidencyChange, null);
});

test('Asset: default loanBalance is 0', () => {
  assert.strictEqual(new Asset().loanBalance, 0);
});

test('Asset: opts.loanBalance is set correctly', () => {
  const a = new Asset('House', 800000, 300000, { loanBalance: 200000 });
  assert.strictEqual(a.loanBalance, 200000);
});

test('Asset: is structuredClone-safe with all opts fields', () => {
  const a  = new Asset('House', 800000, 300000, {
    ownershipType: 'joint',
    ownerId: 'p1',
    drawdownPriority: 10,
    loanBalance: 150000,
  });
  const a2 = structuredClone(a);
  assert.strictEqual(a2.name,             'House');
  assert.strictEqual(a2.value,            800000);
  assert.strictEqual(a2.costBasis,        300000);
  assert.strictEqual(a2.ownershipType,    'joint');
  assert.strictEqual(a2.drawdownPriority, 10);
  assert.strictEqual(a2.loanBalance,      150000);
  assert.strictEqual(a2.balanceAtResidencyChange, null);
});
