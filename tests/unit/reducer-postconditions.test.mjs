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
 * Per-reducer postcondition tests (design/37-reducer-test-framework.md).
 *
 * Each row runs one reducer through `runReducer`, which always checks I1 (no
 * input mutation) and optionally I3/I4. Rows may add a `custom` assertion for
 * I5 (money conservation), I6 (cost basis), I9 (monotonicity), etc.
 *
 * This file is the burn-down target from §6 of the design: add a row per reducer
 * until every concrete reducer is pinned. It is seeded here with the reducers
 * that need no service injection, to establish the pattern.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  runReducer,
  assertBalanceInvariant,
  assertNonNegative,
  assertConserved,
  assertNoInputMutation,
  assertStateUnchanged,
  sumHoldings,
} from '../helpers/reducer-postconditions.js';
import { makeAccountState, makeAction, makeHolding } from '../helpers/reducer-fixtures.js';

import { NoOpReducer } from '../../src/simulation-framework/reducers.js';
import {
  HoldingTransactReducer, HoldingRevalueReducer, HoldingSetBasisReducer,
} from '../../src/finance/holdings/holding-reducers.js';
import { AccumulateDeficitReducer } from '../../src/finance/reducers/accumulate-deficit-reducer.js';

// ─── Table ──────────────────────────────────────────────────────────────────
//
// row = {
//   group, name,
//   reducer:  () => <reducer instance>,
//   state:    <state tree>,
//   action:   <plain action>,
//   expect:   { balance?, nonNegative? }   // passed to runReducer
//   custom?:  (next, prev) => void         // extra invariant assertions
// }

const CASES = [
  // ── A — Framework primitives ────────────────────────────────────────────
  {
    group: 'A', name: 'NoOpReducer — identity (I1)',
    reducer: () => new NoOpReducer('noop'),
    state: makeAccountState({ balance: 1000 }),
    action: makeAction('ANYTHING'),
    expect: { balance: true, nonNegative: true },
    custom: (next, prev) => assertStateUnchanged(prev, next, 'NoOp must return state unchanged'),
  },

  // ── B — Holdings ────────────────────────────────────────────────────────
  {
    group: 'B', name: 'HoldingTransactReducer — deposit keeps I3/I4',
    reducer: () => new HoldingTransactReducer(),
    state: makeAccountState({ holdings: [{ id: 'h1', marketValue: 1000, costBasis: 1000 }] }),
    action: makeAction('HOLDING_TRANSACT', { stateKey: 'testAccount', holdingId: 'h1', marketValueDelta: 250, costBasisDelta: 250 }),
    expect: { balance: true, nonNegative: true },
    custom: (next) => assert.equal(next.testAccount.balance, 1250),
  },
  {
    group: 'B', name: 'HoldingTransactReducer — withdrawal floors at 0 (I4)',
    reducer: () => new HoldingTransactReducer(),
    state: makeAccountState({ holdings: [{ id: 'h1', marketValue: 100, costBasis: 100 }] }),
    action: makeAction('HOLDING_TRANSACT', { stateKey: 'testAccount', holdingId: 'h1', marketValueDelta: -500, costBasisDelta: -500 }),
    expect: { balance: true, nonNegative: true },
    custom: (next) => assert.equal(next.testAccount.balance, 0),
  },
  {
    group: 'B', name: 'HoldingTransactReducer — missing holding is a no-op (I7)',
    reducer: () => new HoldingTransactReducer(),
    state: makeAccountState({ holdings: [{ id: 'h1', marketValue: 100, costBasis: 100 }] }),
    action: makeAction('HOLDING_TRANSACT', { stateKey: 'testAccount', holdingId: 'NOPE', marketValueDelta: 50 }),
    expect: { balance: true, nonNegative: true },
    custom: (next, prev) => assertStateUnchanged(prev, next, 'I7: unknown holdingId must leave state unchanged'),
  },
  {
    group: 'B', name: 'HoldingRevalueReducer — -40% drawdown keeps I3/I4',
    reducer: () => new HoldingRevalueReducer(),
    state: makeAccountState({ holdings: [{ id: 'h1', marketValue: 1000, costBasis: 800 }] }),
    action: makeAction('HOLDING_REVALUE', { stateKey: 'testAccount', holdingId: 'h1', multiplier: -0.4 }),
    expect: { balance: true, nonNegative: true },
    custom: (next) => assert.equal(next.testAccount.balance, 600),
  },
  {
    group: 'B', name: 'HoldingSetBasisReducer — basis-only, balance untouched (I1/I4)',
    reducer: () => new HoldingSetBasisReducer(),
    state: makeAccountState({ holdings: [{ id: 'h1', marketValue: 1000, costBasis: 800 }] }),
    action: makeAction('HOLDING_SET_BASIS', { stateKey: 'testAccount', holdingId: 'h1', costBasis: 950 }),
    expect: { balance: true, nonNegative: true },
    custom: (next) => {
      assert.equal(next.testAccount.holdings[0].costBasis, 950);
      assert.equal(next.testAccount.balance, 1000, 'set-basis must not move balance');
    },
  },

  // ── D — Top-level finance ───────────────────────────────────────────────
  {
    group: 'D', name: 'AccumulateDeficitReducer — monotonic accumulator (I9)',
    reducer: () => new AccumulateDeficitReducer(),
    state: { cumulativeDeficit: 100, deficitMonths: 1 },
    action: makeAction('ACCUMULATE_DEFICIT', { amount: 500 }),
    expect: {}, // flat state — no holdings, so I3/I4 are vacuous
    custom: (next, prev) => {
      assert.ok(next.cumulativeDeficit >= prev.cumulativeDeficit, 'I9: deficit must not decrease');
      assert.equal(next.cumulativeDeficit, 600);
      assert.equal(next.deficitMonths, 2);
    },
  },
];

for (const c of CASES) {
  test(`reducer-postconditions[${c.group}]: ${c.name}`, () => {
    const reducer = c.reducer();
    const prev = structuredClone(c.state);
    const next = runReducer(reducer, c.state, c.action, c.date ?? new Date('2030-01-15'), c.expect);
    if (c.custom) c.custom(next, prev);
  });
}

// ─── Harness self-tests ───────────────────────────────────────────────────────
// Prove the assertions actually fire — a silent harness covers nothing.

test('harness: assertBalanceInvariant catches a desynced balance', () => {
  const bad = makeAccountState({ holdings: [{ marketValue: 100, costBasis: 100 }] });
  bad.testAccount.balance = 999; // break §4.4
  assert.throws(() => assertBalanceInvariant(bad), /§4.4/);
});

test('harness: assertNonNegative catches a negative marketValue', () => {
  const bad = makeAccountState({ holdings: [{ marketValue: -1, costBasis: 0 }] });
  bad.testAccount.balance = -1;
  assert.throws(() => assertNonNegative(bad), /I4/);
});

test('harness: assertNoInputMutation catches an in-place write', () => {
  const state = makeAccountState({ balance: 100 });
  const before = structuredClone(state);
  state.testAccount.balance = 200; // simulate a reducer mutating its input
  assert.throws(() => assertNoInputMutation(before, state), /I1/);
});

test('harness: assertConserved validates a clean same-currency transfer', () => {
  const prev = makeAccountState([
    { stateKey: 'src', balance: 1000 }, { stateKey: 'dst', balance: 0 },
  ]);
  const next = makeAccountState([
    { stateKey: 'src', balance: 700 }, { stateKey: 'dst', balance: 300 },
  ]);
  assertConserved(prev, next, 'src', 'dst'); // no throw
  assert.throws(
    () => assertConserved(prev, next, 'src', 'dst', { fee: 50 }),
    /not conserved/,
    'a phantom fee should break conservation',
  );
});

test('harness: sumHoldings totals marketValue', () => {
  const acct = { holdings: [makeHolding({ marketValue: 10 }), makeHolding({ marketValue: 32.5 })] };
  assert.equal(sumHoldings(acct), 42.5);
});
