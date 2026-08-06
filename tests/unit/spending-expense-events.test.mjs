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
 * spending-expense-events.test.mjs
 *
 * Design 86 G8/G9 — the EXPENSE_EVENTS strategy, generalized from design/26's
 * HEALTHCARE. Two halves:
 *
 *   EE-1..6   ExpenseEventApplyReducer: per-category accumulation, no slice
 *             modification, and the capitalization leg into the linked property.
 *   EE-7..17  ExpenseEventHandler: the residency default (the pre-G9 behaviour,
 *             which must be reproduced exactly), currency resolution, and the
 *             G9 `fundFrom` funding contract including the partial-cover fallback.
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import { ExpenseEventApplyReducer } from '../../src/finance/spending/strategies/expense-event-apply-reducer.js';
import { ExpenseEventHandler, buildExpenseEventSchedule }
  from '../../src/finance/spending/strategies/expense-event-handler.js';

// ── ExpenseEventApplyReducer ──────────────────────────────────────────────────

const applyReducer = new ExpenseEventApplyReducer();

function baseState(overrides = {}) {
  return {
    expenses: { essential: 7_000, discretionary: 3_000 },
    monthlyExpenses: 10_000,
    expenseEventSpendingByCategory: {},
    expenseEventSpendingTotal: 0,
    ...overrides,
  };
}

test('EE-1: accumulates the running total', () => {
  const next = applyReducer.reduce(baseState(),
    { type: 'EXPENSE_EVENT_APPLY', amount: 5_000, category: 'surgery', personId: 'primary' });
  assert.strictEqual(next.expenseEventSpendingTotal, 5_000);
});

test('EE-2: accumulates PER CATEGORY, keeping kinds of event separable', () => {
  let s = baseState();
  s = applyReducer.reduce(s, { type: 'EXPENSE_EVENT_APPLY', amount: 5_000, category: 'healthcare' });
  s = applyReducer.reduce(s, { type: 'EXPENSE_EVENT_APPLY', amount: 8_000, category: 'property' });
  s = applyReducer.reduce(s, { type: 'EXPENSE_EVENT_APPLY', amount: 2_000, category: 'healthcare' });
  assert.deepStrictEqual(s.expenseEventSpendingByCategory, { healthcare: 7_000, property: 8_000 });
  assert.strictEqual(s.expenseEventSpendingTotal, 15_000);
});

test('EE-3: an absent category files under "other" rather than undefined', () => {
  const next = applyReducer.reduce(baseState(), { type: 'EXPENSE_EVENT_APPLY', amount: 1_000 });
  assert.deepStrictEqual(next.expenseEventSpendingByCategory, { other: 1_000 });
});

test('EE-4: does NOT modify the recurring expense slices or monthlyExpenses', () => {
  const next = applyReducer.reduce(baseState(),
    { type: 'EXPENSE_EVENT_APPLY', amount: 5_000, category: 'healthcare' });
  assert.ok(Math.abs(next.expenses.essential    - 7_000)  < 0.01);
  assert.ok(Math.abs(next.expenses.discretionary - 3_000) < 0.01);
  assert.ok(Math.abs(next.monthlyExpenses        - 10_000) < 0.01);
});

test('EE-5: capitalizeAmount lifts the linked property\'s capitalizedImprovements', () => {
  const s = baseState({ auHouseProperty: { value: 1_000_000, capitalizedImprovements: 2_000 } });
  const next = applyReducer.reduce(s, {
    type: 'EXPENSE_EVENT_APPLY', amount: 50_000, category: 'property',
    propertyKey: 'auHouseProperty', capitalizeAmount: 35_000,
  });
  assert.strictEqual(next.auHouseProperty.capitalizedImprovements, 37_000);
  // The tracking total stays the FULL cost — capitalization is a basis question,
  // not a spending one.
  assert.strictEqual(next.expenseEventSpendingTotal, 50_000);
});

test('EE-6: zero capitalizeAmount leaves the property untouched (inert by default)', () => {
  const s = baseState({ auHouseProperty: { value: 1_000_000, capitalizedImprovements: 2_000 } });
  const next = applyReducer.reduce(s, {
    type: 'EXPENSE_EVENT_APPLY', amount: 50_000, propertyKey: 'auHouseProperty', capitalizeAmount: 0,
  });
  assert.strictEqual(next.auHouseProperty.capitalizedImprovements, 2_000);
});

// ── ExpenseEventHandler ───────────────────────────────────────────────────────

function makeStateRegistry(usKey = 'usSavings', auKey = 'auSavings') {
  return {
    getStateKey(role) {
      if (role === 'us-savings') return usKey;
      if (role === 'au-savings') return auKey;
      return null;
    },
  };
}

const handler = new ExpenseEventHandler({
  stateRegistry: makeStateRegistry(),
  usRole: 'us-savings', usOwnerId: 'primary',
  auRole: 'au-savings', auOwnerId: 'primary',
});

function stateWithAccounts(usBalance = 100_000, auBalance = 50_000, extra = {}) {
  return {
    people: { primary: { residency: 'US' } },
    usSavings: { balance: usBalance, minimumBalance: 0, stateKey: 'usSavings', currency: { code: 'USD' } },
    auSavings: { balance: auBalance, minimumBalance: 0, stateKey: 'auSavings', currency: { code: 'AUD' } },
    expenses: { essential: 7_000, discretionary: 3_000 },
    monthlyExpenses: 10_000,
    ...extra,
  };
}

test('EE-7: debits the US savings account for a US-resident (pre-G9 default)', () => {
  const actions = handler.call({
    state: stateWithAccounts(),
    data:  { amount: 5_000, category: 'healthcare', personId: 'primary' },
  });
  const debit = actions.find(a => a.type === 'EXPENSE_DEBIT');
  assert.ok(debit, 'EXPENSE_DEBIT should be emitted');
  assert.strictEqual(debit.amount, 5_000);
  assert.strictEqual(debit.targetKey, 'usSavings');
});

test('EE-8: emits EXPENSE_EVENT_APPLY carrying the category', () => {
  const actions = handler.call({
    state: stateWithAccounts(),
    data:  { amount: 5_000, category: 'hospital' },
  });
  const apply = actions.find(a => a.type === 'EXPENSE_EVENT_APPLY');
  assert.ok(apply);
  assert.strictEqual(apply.amount, 5_000);
  assert.strictEqual(apply.category, 'hospital');
});

test('EE-9: prepends REPLENISH_SAVINGS when the debit would breach the minimum', () => {
  const state = stateWithAccounts();
  state.usSavings = { balance: 4_000, minimumBalance: 1_000, stateKey: 'usSavings', currency: { code: 'USD' } };
  const actions   = handler.call({ state, data: { amount: 5_000, category: 'healthcare' } });
  const replenish = actions.find(a => a.type === 'REPLENISH_SAVINGS');
  assert.ok(replenish, 'REPLENISH_SAVINGS should be emitted');
  assert.strictEqual(replenish.deficit, 2_000);   // 1_000 − (4_000 − 5_000)
  assert.ok(actions.indexOf(replenish) < actions.findIndex(a => a.type === 'EXPENSE_DEBIT'),
    'replenish must precede its own debit');
});

test('EE-10: uses AU savings for an AU-resident person', () => {
  const state = { ...stateWithAccounts(), people: { primary: { residency: 'AU' } } };
  const debit = handler.call({ state, data: { amount: 3_000, category: 'physio' } })
    .find(a => a.type === 'EXPENSE_DEBIT');
  assert.strictEqual(debit.targetKey, 'auSavings');
});

test('EE-11: a zero amount emits nothing at all', () => {
  const actions = handler.call({ state: stateWithAccounts(), data: { amount: 0 } });
  assert.strictEqual(actions.length, 0);
});

// ── G9: the fundFrom funding contract ─────────────────────────────────────────

function stateWithOffset(offsetBalance = 500_000) {
  return stateWithAccounts(100_000, 50_000, {
    people: { primary: { residency: 'AU' } },
    auOffsetAccount: {
      balance: offsetBalance, minimumBalance: 0,
      stateKey: 'auOffsetAccount', currency: { code: 'AUD' }, drawdownPriority: null,
    },
  });
}

test('EE-12: fundFrom debits the nominated account directly, not the residency default', () => {
  const actions = handler.call({
    state: stateWithOffset(),
    data:  { amount: 200_000, currency: 'AUD', category: 'property', fundFrom: 'auOffsetAccount' },
  });
  const debits = actions.filter(a => a.type === 'EXPENSE_DEBIT');
  assert.strictEqual(debits.length, 1, 'a fully-covered event debits exactly one account');
  assert.strictEqual(debits[0].targetKey, 'auOffsetAccount');
  assert.strictEqual(debits[0].amount, 200_000);
  assert.strictEqual(actions.find(a => a.type === 'REPLENISH_SAVINGS'), undefined,
    'a covered direct debit must not touch the drawdown queue');
});

test('EE-13: a nominated account that cannot cover it falls through for the remainder', () => {
  const actions = handler.call({
    state: stateWithOffset(120_000),
    data:  { amount: 200_000, currency: 'AUD', category: 'property', fundFrom: 'auOffsetAccount' },
  });
  const debits = actions.filter(a => a.type === 'EXPENSE_DEBIT');
  assert.strictEqual(debits.length, 2);
  assert.strictEqual(debits[0].targetKey, 'auOffsetAccount');
  assert.strictEqual(debits[0].amount, 120_000);
  assert.strictEqual(debits[1].targetKey, 'auSavings');
  assert.strictEqual(debits[1].amount, 80_000);
  // The two legs must total the event amount — a part-funded event must not
  // silently under-spend.
  assert.strictEqual(debits[0].amount + debits[1].amount, 200_000);
});

test('EE-14: fundFrom respects the nominated account\'s minimumBalance', () => {
  const state = stateWithOffset(120_000);
  state.auOffsetAccount.minimumBalance = 20_000;
  const debits = handler.call({
    state,
    data: { amount: 200_000, currency: 'AUD', fundFrom: 'auOffsetAccount' },
  }).filter(a => a.type === 'EXPENSE_DEBIT');
  assert.strictEqual(debits[0].amount, 100_000);   // 120k balance − 20k floor
  assert.strictEqual(debits[1].amount, 100_000);
});

test('EE-15: an unknown fundFrom key degrades to the residency default', () => {
  const debits = handler.call({
    state: stateWithOffset(),
    data:  { amount: 10_000, currency: 'AUD', fundFrom: 'noSuchAccount' },
  }).filter(a => a.type === 'EXPENSE_DEBIT');
  assert.strictEqual(debits.length, 1);
  assert.strictEqual(debits[0].targetKey, 'auSavings');
});

test('EE-16: an event inherits its linked property\'s currency when none is stated', () => {
  const state = stateWithOffset();
  state.auHouseProperty = { value: 1_200_000, currency: { code: 'AUD' }, capitalizedImprovements: 0 };
  const apply = handler.call({
    state,
    data: { amount: 50_000, category: 'property', propertyKey: 'auHouseProperty', capitalize: 0.7 },
  }).find(a => a.type === 'EXPENSE_EVENT_APPLY');
  assert.strictEqual(apply.currency, 'AUD');
  // Same currency ⇒ no conversion, so capitalizeAmount is the plain fraction.
  assert.ok(Math.abs(apply.capitalizeAmount - 35_000) < 0.01);
});

test('EE-17: an explicit currency overrides the property and the household default', () => {
  const state = stateWithOffset();
  state.auHouseProperty = { value: 1_200_000, currency: { code: 'AUD' }, capitalizedImprovements: 0 };
  const apply = handler.call({
    state,
    data: { amount: 50_000, currency: 'USD', propertyKey: 'auHouseProperty' },
  }).find(a => a.type === 'EXPENSE_EVENT_APPLY');
  assert.strictEqual(apply.currency, 'USD');
});

// ── The scheduling helper ─────────────────────────────────────────────────────

test('EE-18: buildExpenseEventSchedule carries every authored field onto the event', () => {
  const evt = buildExpenseEventSchedule({
    date: '2035-06-01', amount: 250_000, currency: 'AUD', category: 'property',
    fundFrom: 'auOffsetAccount', propertyKey: 'auHouseProperty', capitalize: 0.7,
    personId: 'primary', label: 'roof',
  });
  assert.strictEqual(evt.type, 'EXPENSE_EVENT');
  assert.deepStrictEqual(evt.data, {
    amount: 250_000, currency: 'AUD', category: 'property', personId: 'primary',
    fundFrom: 'auOffsetAccount', propertyKey: 'auHouseProperty', capitalize: 0.7,
  });
});

test('EE-19: a minimal entry defaults its optional fields to the nullish contract', () => {
  const evt = buildExpenseEventSchedule({ date: '2030-01-01', amount: 1_000 });
  // null, NOT '' — the handler resolves currency with `?? property ?? household`,
  // and an empty string would win that chain.
  assert.strictEqual(evt.data.currency, null);
  assert.strictEqual(evt.data.fundFrom, null);
  assert.strictEqual(evt.data.category, 'other');
  assert.strictEqual(evt.data.capitalize, 0);
});
