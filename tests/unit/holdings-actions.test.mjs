/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import { Holding }    from '../../src/finance/holdings/holding.js';
import { ALLOCATION } from '../../src/finance/holdings/allocation.js';
import {
  HoldingTransactAction, HoldingRevalueAction, HoldingSetBasisAction,
  HoldingSplitAction, HoldingRetitleAction, HOLDING_ACTION_TYPES,
  HOLDING_ACTION_ENTRIES,
} from '../../src/finance/holdings/holding-actions.js';
import {
  HoldingTransactReducer, HoldingRevalueReducer, HoldingSetBasisReducer,
  HoldingSplitReducer, HoldingRetitleReducer,
} from '../../src/finance/holdings/holding-reducers.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildAccountState(holdings) {
  const balance = holdings.reduce((s, h) => s + (h.marketValue ?? 0), 0);
  const account = {
    id:       'acc1',
    stateKey: 'testAccount',
    balance,
    country:  'US',
    currency: { code: 'USD', symbol: '$' },
    role:     null,
    holdings: holdings.map(h => h instanceof Holding ? h : new Holding(h)),
  };
  return { testAccount: account };
}

function assertInvariant(state, stateKey) {
  const account = state[stateKey];
  const sum     = account.holdings.reduce((s, h) => s + (h.marketValue ?? 0), 0);
  assert.equal(
    +account.balance.toFixed(2),
    +sum.toFixed(2),
    `§4.4 invariant violated: balance=${account.balance}, Σholdings=${sum}`
  );
}

// ─── Action class shape ───────────────────────────────────────────────────────

test('HoldingTransactAction: shape + round-trip', () => {
  const a = new HoldingTransactAction({
    stateKey: 'k', holdingId: 'h1', marketValueDelta: 100, costBasisDelta: 100,
  });
  assert.equal(a.type, 'HOLDING_TRANSACT');
  assert.equal(a.stateKey, 'k');
  assert.equal(a.holdingId, 'h1');
  assert.equal(a.marketValueDelta, 100);
  assert.equal(a.costBasisDelta, 100);
  const restored = HoldingTransactAction.fromJSON(a.toJSON());
  assert.equal(restored.marketValueDelta, 100);
  assert.equal(restored.holdingId, 'h1');
});

test('HoldingRevalueAction: targets holdingId OR rateKey', () => {
  const byId = new HoldingRevalueAction({ stateKey: 'k', holdingId: 'h1', multiplier: -0.4 });
  assert.equal(byId.type, 'HOLDING_REVALUE');
  assert.equal(byId.holdingId, 'h1');
  assert.equal(byId.multiplier, -0.4);

  const byRate = new HoldingRevalueAction({ stateKey: 'k', rateKey: 'EQUITY_US', priceDelta: 5 });
  assert.equal(byRate.rateKey, 'EQUITY_US');
  assert.equal(byRate.priceDelta, 5);
});

test('HoldingSetBasisAction: shape', () => {
  const a = new HoldingSetBasisAction({ stateKey: 'k', holdingId: 'h1', costBasis: 500 });
  assert.equal(a.type, 'HOLDING_SET_BASIS');
  assert.equal(a.costBasis, 500);
});

test('HoldingSplitAction: shape', () => {
  const a = new HoldingSplitAction({
    stateKey: 'k', holdingId: 'h1',
    splits: [
      { marketValueDelta: 60, costBasisDelta: 60, allocation: 'EQUITY' },
      { marketValueDelta: 40, costBasisDelta: 40, allocation: 'BOND' },
    ],
  });
  assert.equal(a.type, 'HOLDING_SPLIT');
  assert.equal(a.splits.length, 2);
});

test('HoldingRetitleAction: shape', () => {
  const a = new HoldingRetitleAction({
    stateKey: 'k', holdingId: 'h1', allocation: 'BOND', rateKey: 'FIXED_INCOME_US', label: 'BND',
  });
  assert.equal(a.type, 'HOLDING_RETITLE');
  assert.equal(a.allocation, 'BOND');
});

// ─── Reducer behavior — HoldingTransactReducer ────────────────────────────────

test('HoldingTransactReducer: contribution adds to value + basis, syncs balance', () => {
  const r = new HoldingTransactReducer();
  const state = buildAccountState([{ id: 'h1', allocation: 'EQUITY', marketValue: 1000, costBasis: 1000 }]);
  const action = new HoldingTransactAction({
    stateKey: 'testAccount', holdingId: 'h1', marketValueDelta: 250, costBasisDelta: 250,
  });
  const next = r.reduce(state, action);
  assert.equal(next.testAccount.holdings[0].marketValue, 1250);
  assert.equal(next.testAccount.holdings[0].costBasis,   1250);
  assert.equal(next.testAccount.balance, 1250);
  assertInvariant(next, 'testAccount');
});

test('HoldingTransactReducer: appreciation adds value but NOT basis', () => {
  const r = new HoldingTransactReducer();
  const state = buildAccountState([{ id: 'h1', allocation: 'EQUITY', marketValue: 1000, costBasis: 900 }]);
  const action = new HoldingTransactAction({
    stateKey: 'testAccount', holdingId: 'h1', marketValueDelta: 70, costBasisDelta: 0,
  });
  const next = r.reduce(state, action);
  assert.equal(next.testAccount.holdings[0].marketValue, 1070);
  assert.equal(next.testAccount.holdings[0].costBasis,    900);  // unchanged
  assert.equal(next.testAccount.balance, 1070);
  assertInvariant(next, 'testAccount');
});

test('HoldingTransactReducer: withdrawal subtracts value + basis', () => {
  const r = new HoldingTransactReducer();
  const state = buildAccountState([{ id: 'h1', allocation: 'EQUITY', marketValue: 1000, costBasis: 800 }]);
  const action = new HoldingTransactAction({
    stateKey: 'testAccount', holdingId: 'h1', marketValueDelta: -200, costBasisDelta: -160,
  });
  const next = r.reduce(state, action);
  assert.equal(next.testAccount.holdings[0].marketValue, 800);
  assert.equal(next.testAccount.holdings[0].costBasis,   640);
  assert.equal(next.testAccount.balance, 800);
  assertInvariant(next, 'testAccount');
});

test('HoldingTransactReducer: missing holding is a no-op', () => {
  const r = new HoldingTransactReducer();
  const state = buildAccountState([{ id: 'h1', allocation: 'EQUITY', marketValue: 1000, costBasis: 1000 }]);
  const action = new HoldingTransactAction({
    stateKey: 'testAccount', holdingId: 'bogus', marketValueDelta: 100,
  });
  const next = r.reduce(state, action);
  assert.equal(next.testAccount.balance, 1000);
  assertInvariant(next, 'testAccount');
});

// ─── HoldingRevalueReducer ────────────────────────────────────────────────────

test('HoldingRevalueReducer: multiplier shocks one holding by id', () => {
  const r = new HoldingRevalueReducer();
  const state = buildAccountState([
    { id: 'h1', allocation: 'EQUITY', marketValue: 1000, costBasis: 1000, rateKey: 'EQUITY_US' },
    { id: 'h2', allocation: 'BOND',   marketValue:  500, costBasis: 500,  rateKey: 'FIXED_INCOME_US' },
  ]);
  const action = new HoldingRevalueAction({ stateKey: 'testAccount', holdingId: 'h1', multiplier: -0.4 });
  const next = r.reduce(state, action);
  assert.equal(next.testAccount.holdings[0].marketValue, 600);   // 1000 × 0.6
  assert.equal(next.testAccount.holdings[1].marketValue, 500);   // unchanged
  assert.equal(next.testAccount.balance, 1100);
  assertInvariant(next, 'testAccount');
});

test('HoldingRevalueReducer: multiplier shocks every holding under rateKey', () => {
  const r = new HoldingRevalueReducer();
  const state = buildAccountState([
    { id: 'h1', allocation: 'EQUITY', marketValue: 1000, costBasis: 1000, rateKey: 'EQUITY_US' },
    { id: 'h2', allocation: 'EQUITY', marketValue:  500, costBasis: 500,  rateKey: 'EQUITY_US' },
    { id: 'h3', allocation: 'BOND',   marketValue:  300, costBasis: 300,  rateKey: 'FIXED_INCOME_US' },
  ]);
  const action = new HoldingRevalueAction({ stateKey: 'testAccount', rateKey: 'EQUITY_US', multiplier: 0.10 });
  const next = r.reduce(state, action);
  assert.equal(next.testAccount.holdings[0].marketValue, 1100);
  assert.equal(next.testAccount.holdings[1].marketValue, 550);
  assert.equal(next.testAccount.holdings[2].marketValue, 300);   // unchanged
  assertInvariant(next, 'testAccount');
});

test('HoldingRevalueReducer: priceDelta adds an absolute amount', () => {
  const r = new HoldingRevalueReducer();
  const state = buildAccountState([{ id: 'h1', allocation: 'EQUITY', marketValue: 1000, costBasis: 1000, rateKey: 'EQUITY_US' }]);
  const action = new HoldingRevalueAction({ stateKey: 'testAccount', holdingId: 'h1', priceDelta: -250 });
  const next = r.reduce(state, action);
  assert.equal(next.testAccount.holdings[0].marketValue, 750);
  assertInvariant(next, 'testAccount');
});

test('HoldingRevalueReducer: marketValue clamps at zero', () => {
  const r = new HoldingRevalueReducer();
  const state = buildAccountState([{ id: 'h1', allocation: 'EQUITY', marketValue: 100, costBasis: 100, rateKey: 'EQUITY_US' }]);
  const action = new HoldingRevalueAction({ stateKey: 'testAccount', holdingId: 'h1', priceDelta: -500 });
  const next = r.reduce(state, action);
  assert.equal(next.testAccount.holdings[0].marketValue, 0);
  assertInvariant(next, 'testAccount');
});

// ─── HoldingSetBasisReducer ───────────────────────────────────────────────────

test('HoldingSetBasisReducer: overwrites costBasis without touching value', () => {
  const r = new HoldingSetBasisReducer();
  const state = buildAccountState([{ id: 'h1', allocation: 'EQUITY', marketValue: 1000, costBasis: 800 }]);
  const action = new HoldingSetBasisAction({ stateKey: 'testAccount', holdingId: 'h1', costBasis: 950 });
  const next = r.reduce(state, action);
  assert.equal(next.testAccount.holdings[0].costBasis,   950);
  assert.equal(next.testAccount.holdings[0].marketValue, 1000);
  assert.equal(next.testAccount.balance, 1000);
  assertInvariant(next, 'testAccount');
});

// ─── HoldingSplitReducer ──────────────────────────────────────────────────────

test('HoldingSplitReducer: splits one holding into N preserving balance invariant', () => {
  const r = new HoldingSplitReducer();
  const state = buildAccountState([{ id: 'h1', allocation: 'EQUITY', marketValue: 1000, costBasis: 1000, rateKey: 'EQUITY_US' }]);
  const action = new HoldingSplitAction({
    stateKey: 'testAccount', holdingId: 'h1',
    splits: [
      { marketValueDelta: 600, costBasisDelta: 600, allocation: 'EQUITY', rateKey: 'EQUITY_US' },
      { marketValueDelta: 400, costBasisDelta: 400, allocation: 'BOND',   rateKey: 'FIXED_INCOME_US' },
    ],
  });
  const next = r.reduce(state, action);
  assert.equal(next.testAccount.holdings.length, 2);
  assert.equal(next.testAccount.holdings[0].marketValue, 600);
  assert.equal(next.testAccount.holdings[0].allocation, 'EQUITY');
  assert.equal(next.testAccount.holdings[1].marketValue, 400);
  assert.equal(next.testAccount.holdings[1].allocation, 'BOND');
  assert.equal(next.testAccount.balance, 1000);
  assertInvariant(next, 'testAccount');
});

test('HoldingSplitReducer: inherits source metadata when split entry omits fields', () => {
  const r = new HoldingSplitReducer();
  const state = buildAccountState([{
    id: 'h1', allocation: 'EQUITY', marketValue: 1000, costBasis: 1000,
    rateKey: 'EQUITY_US', label: 'ITOT',
  }]);
  const action = new HoldingSplitAction({
    stateKey: 'testAccount', holdingId: 'h1',
    splits: [
      { marketValueDelta: 500, costBasisDelta: 500 },
      { marketValueDelta: 500, costBasisDelta: 500 },
    ],
  });
  const next = r.reduce(state, action);
  assert.equal(next.testAccount.holdings[0].allocation, 'EQUITY');
  assert.equal(next.testAccount.holdings[0].rateKey, 'EQUITY_US');
  assert.equal(next.testAccount.holdings[0].label, 'ITOT');
});

// ─── HoldingRetitleReducer ────────────────────────────────────────────────────

test('HoldingRetitleReducer: patches metadata without moving value', () => {
  const r = new HoldingRetitleReducer();
  const state = buildAccountState([{ id: 'h1', allocation: 'EQUITY', marketValue: 1000, costBasis: 800, rateKey: 'EQUITY_US' }]);
  const action = new HoldingRetitleAction({
    stateKey: 'testAccount', holdingId: 'h1', allocation: 'BOND', rateKey: 'FIXED_INCOME_US', label: 'BND',
  });
  const next = r.reduce(state, action);
  assert.equal(next.testAccount.holdings[0].allocation, 'BOND');
  assert.equal(next.testAccount.holdings[0].rateKey, 'FIXED_INCOME_US');
  assert.equal(next.testAccount.holdings[0].label, 'BND');
  assert.equal(next.testAccount.holdings[0].marketValue, 1000);  // untouched
  assert.equal(next.testAccount.balance, 1000);
});

// ─── HOLDING_ACTION_ENTRIES coverage ──────────────────────────────────────────

test('HOLDING_ACTION_ENTRIES: covers all 5 action types with family=HOLDING', () => {
  assert.equal(HOLDING_ACTION_ENTRIES.length, 5);
  for (const e of HOLDING_ACTION_ENTRIES) {
    assert.equal(e.family, 'HOLDING');
    assert.equal(e.cc, null);
    assert.ok(e.fields, 'every entry declares fields');
  }
  const types = HOLDING_ACTION_ENTRIES.map(e => e.type).sort();
  assert.deepEqual(types, Object.values(HOLDING_ACTION_TYPES).sort());
});
