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
 * spending-healthcare.test.mjs
 *
 * Tests for design/26 Increment 2 — HealthcareEventDriven strategy.
 *
 *   - HealthcareExpenseApplyReducer: accumulates YTD + total, no slice modification
 *   - HealthcareEventHandler: emits EXPENSE_DEBIT + HEALTHCARE_EXPENSE_APPLY
 *   - REPLENISH_SAVINGS prepended when balance would go below minimum
 *   - state.expenses.essential NOT permanently modified (one-off, not recurring)
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import { HealthcareExpenseApplyReducer } from '../../src/finance/spending/strategies/healthcare-expense-apply-reducer.js';
import { HealthcareEventHandler }        from '../../src/finance/spending/strategies/healthcare-event-handler.js';

// ── HealthcareExpenseApplyReducer ─────────────────────────────────────────────

const applyReducer = new HealthcareExpenseApplyReducer();

function baseState(overrides = {}) {
  return {
    expenses: { essential: 7_000, discretionary: 3_000 },
    monthlyExpenses: 10_000,
    healthcareSpendingYTD:   0,
    healthcareSpendingTotal: 0,
    ...overrides,
  };
}

test('HC-1: HealthcareExpenseApplyReducer accumulates healthcareSpendingYTD', () => {
  const s    = baseState();
  const next = applyReducer.reduce(s, { type: 'HEALTHCARE_EXPENSE_APPLY', amount: 5_000, category: 'surgery', personId: 'primary' });
  assert.strictEqual(next.healthcareSpendingYTD, 5_000);
});

test('HC-2: HealthcareExpenseApplyReducer accumulates healthcareSpendingTotal', () => {
  const s    = baseState({ healthcareSpendingTotal: 10_000 });
  const next = applyReducer.reduce(s, { type: 'HEALTHCARE_EXPENSE_APPLY', amount: 3_000 });
  assert.strictEqual(next.healthcareSpendingTotal, 13_000);
});

test('HC-3: HealthcareExpenseApplyReducer does NOT modify state.expenses.essential', () => {
  const s    = baseState();
  const next = applyReducer.reduce(s, { type: 'HEALTHCARE_EXPENSE_APPLY', amount: 5_000 });
  assert.ok(Math.abs(next.expenses.essential - 7_000) < 0.01);
  assert.ok(Math.abs(next.expenses.discretionary - 3_000) < 0.01);
});

test('HC-4: HealthcareExpenseApplyReducer does NOT modify state.monthlyExpenses', () => {
  const s    = baseState();
  const next = applyReducer.reduce(s, { type: 'HEALTHCARE_EXPENSE_APPLY', amount: 5_000 });
  assert.ok(Math.abs(next.monthlyExpenses - 10_000) < 0.01);
});

test('HC-5: HealthcareExpenseApplyReducer multiple events accumulate correctly', () => {
  let s = baseState();
  s = applyReducer.reduce(s, { type: 'HEALTHCARE_EXPENSE_APPLY', amount: 2_000 });
  s = applyReducer.reduce(s, { type: 'HEALTHCARE_EXPENSE_APPLY', amount: 3_500 });
  assert.strictEqual(s.healthcareSpendingYTD, 5_500);
  assert.strictEqual(s.healthcareSpendingTotal, 5_500);
});

// ── HealthcareEventHandler ────────────────────────────────────────────────────

function makeStateRegistry(usKey = 'usSavings', auKey = 'auSavings') {
  return {
    getStateKey(role, ownerId) {
      if (role === 'us-savings') return usKey;
      if (role === 'au-savings') return auKey;
      return null;
    },
  };
}

const handler = new HealthcareEventHandler({
  stateRegistry: makeStateRegistry(),
  usRole: 'us-savings', usOwnerId: 'primary',
  auRole: 'au-savings', auOwnerId: 'primary',
});

function stateWithAccounts(usBalance = 100_000, auBalance = 50_000) {
  return {
    people: { primary: { residency: 'US' } },
    usSavings: { balance: usBalance, minimumBalance: 0, stateKey: 'usSavings' },
    auSavings: { balance: auBalance, minimumBalance: 0, stateKey: 'auSavings' },
    expenses: { essential: 7_000, discretionary: 3_000 },
    monthlyExpenses: 10_000,
  };
}

test('HC-6: HealthcareEventHandler emits EXPENSE_DEBIT for US-resident', () => {
  const state   = stateWithAccounts();
  const actions = handler.call({ state, data: { amount: 5_000, category: 'surgery', personId: 'primary' } });
  const debit   = actions.find(a => a.type === 'EXPENSE_DEBIT');
  assert.ok(debit, 'EXPENSE_DEBIT should be emitted');
  assert.strictEqual(debit.amount, 5_000);
  assert.strictEqual(debit.targetKey, 'usSavings');
});

test('HC-7: HealthcareEventHandler emits HEALTHCARE_EXPENSE_APPLY', () => {
  const state   = stateWithAccounts();
  const actions = handler.call({ state, data: { amount: 5_000, category: 'hospital' } });
  const apply   = actions.find(a => a.type === 'HEALTHCARE_EXPENSE_APPLY');
  assert.ok(apply, 'HEALTHCARE_EXPENSE_APPLY should be emitted');
  assert.strictEqual(apply.amount, 5_000);
  assert.strictEqual(apply.category, 'hospital');
});

test('HC-8: HealthcareEventHandler emits REPLENISH_SAVINGS when balance would fall below minimum', () => {
  const state = {
    ...stateWithAccounts(),
    usSavings: { balance: 4_000, minimumBalance: 1_000, stateKey: 'usSavings' },
  };
  // debit = 5_000; post-debit = -1_000; deficit = 1_000 - (-1_000) = 2_000
  const actions  = handler.call({ state, data: { amount: 5_000, category: 'surgery' } });
  const replenish = actions.find(a => a.type === 'REPLENISH_SAVINGS');
  assert.ok(replenish, 'REPLENISH_SAVINGS should be emitted');
  assert.ok(replenish.deficit > 0);
});

test('HC-9: HealthcareEventHandler uses AU savings for AU-resident person', () => {
  const state = {
    ...stateWithAccounts(),
    people: { primary: { residency: 'AU' } },
  };
  const actions = handler.call({ state, data: { amount: 3_000, category: 'physio' } });
  const debit   = actions.find(a => a.type === 'EXPENSE_DEBIT');
  assert.ok(debit);
  assert.strictEqual(debit.targetKey, 'auSavings');
});

test('HC-10: HealthcareEventHandler returns empty array when amount is 0', () => {
  const state   = stateWithAccounts();
  const actions = handler.call({ state, data: { amount: 0 } });
  assert.strictEqual(actions.length, 0);
});
