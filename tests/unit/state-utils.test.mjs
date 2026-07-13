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
import { diffStates, MutationTracker } from "../../src/simulation-framework/state-utils.js";

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

test('diffStates: structural sharing — shared sub-object reference reports no change', () => {
  const shared = { balance: 1000, transactions: [1, 2, 3] };
  const prev = { cash: 100, account: shared };
  const next  = { cash: 200, account: shared };  // same reference
  const changes = diffStates(prev, next);
  assert.strictEqual(changes.length, 1, 'only cash should be reported changed');
  assert.strictEqual(changes[0].field, 'cash');
});

test('diffStates: structural sharing — same primitive reference short-circuits correctly', () => {
  const prev = { a: 1, b: 2 };
  const next  = { a: 1, b: 2 };
  // identical by value — no changes expected
  assert.deepEqual(diffStates(prev, next), []);
});

// ─── Journal immutability: recorded leaves are frozen so mutation is forbidden ──
//
// Regression for the holdings-activity bug: a holding rescaled in place on a later
// event used to silently rewrite every past journal `after` to the final value —
// making the Holdings "Activity" ledger show wrong deltas / BUY-vs-SELL kinds.
//
// The real fix made the holdings mutation paths copy-on-write; state-utils now
// ENFORCES that invariant. In STRICT mode (dev + test) _snapshot deep-freezes the
// recorded object/array leaf, so ANY later in-place write throws a TypeError at
// the culprit site instead of corrupting the record. These tests exercise the
// tripwire directly. (In a FAST production build _snapshot is identity — the
// invariant is trusted, proven by this STRICT test run.)

test('diffStates: a recorded object/array leaf is frozen against later in-place mutation', () => {
  const prev = { acct: { holdings: [{ id: 'h1', marketValue: 100 }] } };
  const liveHolding = { id: 'h1', marketValue: 200 };
  const next = { acct: { holdings: [liveHolding] } };   // `next.acct.holdings` is live state

  const diff = diffStates(prev, next).find(c => c.field === 'acct.holdings');
  assert.ok(diff, 'holdings change is recorded');
  assert.strictEqual(diff.after[0].marketValue, 200, 'after reflects value at diff time');

  // The recorded leaf is frozen: a later in-place rewrite throws at the mutation
  // site (strict mode), and structural mutation of the array is likewise rejected.
  assert.throws(() => { liveHolding.marketValue = 999; }, TypeError, 'in-place holding write is forbidden');
  assert.throws(() => { next.acct.holdings.push({ id: 'h2', marketValue: 1 }); }, TypeError, 'array growth is forbidden');

  // The durable record is therefore unchanged.
  assert.strictEqual(diff.after.length, 1);
  assert.strictEqual(diff.after[0].marketValue, 200, 'after value is frozen at diff time');
});

test('diffStates: the recorded `before` leaf is frozen too', () => {
  const liveBefore = { balance: 100, holdings: [{ id: 'h1', marketValue: 100 }] };
  const prev = { acct: liveBefore };
  const next = { acct: { balance: 200, holdings: [{ id: 'h1', marketValue: 200 }] } };

  const diff = diffStates(prev, next).find(c => c.field === 'acct.holdings');
  assert.ok(diff);
  assert.throws(() => { liveBefore.holdings[0].marketValue = 777; }, TypeError);
  assert.strictEqual(diff.before[0].marketValue, 100, 'before is frozen at diff time');
});

// ─── MutationTracker ────────────────────────────────────────────────────────────

test('MutationTracker: recorded object leaves are frozen against later mutation', () => {
  MutationTracker.begin();
  const before = [{ id: 'h1', marketValue: 100 }];
  const after  = [{ id: 'h1', marketValue: 200 }];
  MutationTracker.record('acct.holdings', before, after);
  // A later in-place write to a recorded leaf is forbidden (strict-mode throw).
  assert.throws(() => { after[0].marketValue = 999; }, TypeError);
  assert.throws(() => { before[0].marketValue = 777; }, TypeError);
  const sd = MutationTracker.flush();

  assert.strictEqual(sd[0].after[0].marketValue, 200, 'after value is frozen at record time');
  assert.strictEqual(sd[0].before[0].marketValue, 100, 'before value is frozen at record time');
});

test('MutationTracker: primitive values pass through unchanged with delta', () => {
  MutationTracker.begin();
  MutationTracker.record('acct.balance', 100, 250);
  const sd = MutationTracker.flush();
  assert.strictEqual(sd[0].before, 100);
  assert.strictEqual(sd[0].after, 250);
  assert.strictEqual(sd[0].delta, 150);
});
