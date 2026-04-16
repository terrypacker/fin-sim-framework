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
