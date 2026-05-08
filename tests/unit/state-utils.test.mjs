/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

// ─── Helper ───────────────────────────────────────────────────────────────────
import assert   from 'node:assert/strict';
import { test } from 'node:test';
import { diffStates } from "../../src/simulation-framework/state-utils.js";

// ─── diffStates ───────────────────────────────────────────────────────────────

test('diffStates: returns empty array when prev is null', () => {
  assert.deepEqual(diffStates(null, { cash: 100 }), []);
});

test('diffStates: returns empty array when next is null', () => {
  assert.deepEqual(diffStates({ cash: 100 }, null), []);
});

test('diffStates: returns empty array for identical states', () => {
  const state = { cash: 1000, name: 'Alice' };
  assert.deepEqual(diffStates(state, { ...state }), []);
});

test('diffStates: detects numeric change and computes delta', () => {
  const changes = diffStates({ cash: 500 }, { cash: 750 });
  assert.strictEqual(changes.length, 1);
  assert.strictEqual(changes[0].field, 'cash');
  assert.strictEqual(changes[0].before, 500);
  assert.strictEqual(changes[0].after, 750);
  assert.strictEqual(changes[0].delta, 250);
});

test('diffStates: delta is null for non-numeric change', () => {
  const changes = diffStates({ status: 'open' }, { status: 'closed' });
  assert.strictEqual(changes.length, 1);
  assert.strictEqual(changes[0].delta, null);
});

test('diffStates: skips "credits" key', () => {
  const prev = { credits: [1, 2, 3], cash: 100 };
  const next  = { credits: [1, 2, 3, 4], cash: 100 };
  const changes = diffStates(prev, next);
  assert.ok(!changes.some(c => c.field === 'credits'), '"credits" should be skipped');
  assert.strictEqual(changes.length, 0);
});

test('diffStates: skips "debits" key', () => {
  const prev = { debits: [10], cash: 200 };
  const next  = { debits: [10, 20], cash: 200 };
  const changes = diffStates(prev, next);
  assert.ok(!changes.some(c => c.field === 'debits'), '"debits" should be skipped');
  assert.strictEqual(changes.length, 0);
});

test('diffStates: recursively walks nested objects', () => {
  const prev = { account: { balance: 1000 } };
  const next  = { account: { balance: 1200 } };
  const changes = diffStates(prev, next);
  assert.strictEqual(changes.length, 1);
  assert.strictEqual(changes[0].field, 'account.balance');
  assert.strictEqual(changes[0].delta, 200);
});

test('diffStates: detects added key (before is null)', () => {
  const changes = diffStates({ cash: 100 }, { cash: 100, bonus: 50 });
  assert.strictEqual(changes.length, 1);
  assert.strictEqual(changes[0].field, 'bonus');
  assert.strictEqual(changes[0].before, null);
  assert.strictEqual(changes[0].after, 50);
});

test('diffStates: detects removed key (after is null)', () => {
  const changes = diffStates({ cash: 100, bonus: 50 }, { cash: 100 });
  assert.strictEqual(changes.length, 1);
  assert.strictEqual(changes[0].field, 'bonus');
  assert.strictEqual(changes[0].after, null);
});

test('diffStates: multiple fields changed returns multiple records', () => {
  const prev = { a: 1, b: 2, c: 3 };
  const next  = { a: 1, b: 5, c: 9 };
  const changes = diffStates(prev, next);
  assert.strictEqual(changes.length, 2);
});
