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
 * evt-expense-fx.test.mjs
 *
 * EVT-EXPENSE-FX — a USD-denominated expense debited from an AUD savings account
 * after a change of residency must leave the *converted* AUD magnitude
 * (e.g. $6k @ 1.5 → A$9k), not the raw native number. Pre-move (USD→USD) and
 * post-move (USD→AUD) are both covered, for monthly and healthcare expenses.
 * The RECORD_METRIC value stays native in both cases.
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import { MonthlyExpensesHandler } from '../../src/finance/handlers/monthly-expenses-handler.js';
import { HealthcareEventHandler } from '../../src/finance/spending/strategies/healthcare-event-handler.js';

const US_ROLE = 'US_SAVINGS';
const AU_ROLE = 'AU_SAVINGS';

// Minimal StateRegistry stub: maps role → state key.
const stateRegistry = {
  getStateKey(role) {
    return role === AU_ROLE ? 'auSavingsAccount' : 'usSavingsAccount';
  },
};

function makeState({ residency, fxRate = 1.5 } = {}) {
  return {
    monthlyExpenses: 6_000, // native (USD)
    effectiveExchangeRates: { USD_AUD: fxRate },
    people: { primary: { id: 'primary', residency } },
    usSavingsAccount: { stateKey: 'usSavingsAccount', balance: 1_000_000, minimumBalance: 0, currency: { code: 'USD', symbol: '$' } },
    auSavingsAccount: { stateKey: 'auSavingsAccount', balance: 1_000_000, minimumBalance: 0, currency: { code: 'AUD', symbol: 'A$' } },
  };
}

function debitOf(actions)  { return actions.find(a => a.type === 'EXPENSE_DEBIT'); }
function metricOf(actions) { return actions.find(a => a.type === 'RECORD_METRIC'); }

// ── MonthlyExpensesHandler ───────────────────────────────────────────────────

test('EVT-EXPENSE-FX-1: pre-move, USD expense debits US savings at native magnitude', () => {
  const h = new MonthlyExpensesHandler({
    stateRegistry, monthlyExpenses: 6_000, expensesCurrency: 'USD',
    usRole: US_ROLE, auRole: AU_ROLE,
  });
  const actions = h.call({ data: {}, state: makeState({ residency: 'US' }) });
  const debit = debitOf(actions);
  assert.strictEqual(debit.targetKey, 'usSavingsAccount');
  assert.strictEqual(debit.amount, 6_000); // USD → USD, no conversion
  assert.strictEqual(metricOf(actions).value, 6_000); // metric stays native
});

test('EVT-EXPENSE-FX-2: post-move, USD expense debits AU savings at converted (AUD) magnitude', () => {
  const h = new MonthlyExpensesHandler({
    stateRegistry, monthlyExpenses: 6_000, expensesCurrency: 'USD',
    usRole: US_ROLE, auRole: AU_ROLE,
  });
  const actions = h.call({ data: {}, state: makeState({ residency: 'AU', fxRate: 1.5 }) });
  const debit = debitOf(actions);
  assert.strictEqual(debit.targetKey, 'auSavingsAccount');
  assert.ok(Math.abs(debit.amount - 9_000) < 1e-6, `expected A$9000, got ${debit.amount}`);
  assert.strictEqual(metricOf(actions).value, 6_000); // metric stays native USD
});

test('EVT-EXPENSE-FX-3: post-move deficit/replenish uses the converted amount', () => {
  const h = new MonthlyExpensesHandler({
    stateRegistry, monthlyExpenses: 6_000, expensesCurrency: 'USD',
    usRole: US_ROLE, auRole: AU_ROLE,
  });
  const state = makeState({ residency: 'AU', fxRate: 1.5 });
  // AU savings just above the native figure but below the converted one →
  // a deficit must be detected against the converted A$9k, not the native $6k.
  state.auSavingsAccount.balance        = 8_000;
  state.auSavingsAccount.minimumBalance = 0;
  const actions = h.call({ data: {}, state });
  const replenish = actions.find(a => a.type === 'REPLENISH_SAVINGS');
  assert.ok(replenish != null, 'expected REPLENISH_SAVINGS for the converted shortfall');
  assert.ok(Math.abs(replenish.deficit - 1_000) < 1e-6, `expected 1000 deficit, got ${replenish.deficit}`);
});

// ── HealthcareEventHandler ───────────────────────────────────────────────────

test('EVT-EXPENSE-FX-4: post-move healthcare expense debits AU savings at converted magnitude', () => {
  const h = new HealthcareEventHandler({
    stateRegistry, expensesCurrency: 'USD', usRole: US_ROLE, auRole: AU_ROLE,
  });
  const actions = h.call({
    state: makeState({ residency: 'AU', fxRate: 1.5 }),
    data:  { amount: 6_000, category: 'healthcare', personId: 'primary' },
  });
  const debit = debitOf(actions);
  assert.strictEqual(debit.targetKey, 'auSavingsAccount');
  assert.ok(Math.abs(debit.amount - 9_000) < 1e-6, `expected A$9000, got ${debit.amount}`);
  // Tracking + metric stay native.
  const apply = actions.find(a => a.type === 'HEALTHCARE_EXPENSE_APPLY');
  assert.strictEqual(apply.amount, 6_000);
  assert.strictEqual(metricOf(actions).value, 6_000);
});

test('EVT-EXPENSE-FX-5: pre-move healthcare expense debits US savings at native magnitude', () => {
  const h = new HealthcareEventHandler({
    stateRegistry, expensesCurrency: 'USD', usRole: US_ROLE, auRole: AU_ROLE,
  });
  const actions = h.call({
    state: makeState({ residency: 'US' }),
    data:  { amount: 6_000, category: 'healthcare', personId: 'primary' },
  });
  const debit = debitOf(actions);
  assert.strictEqual(debit.targetKey, 'usSavingsAccount');
  assert.strictEqual(debit.amount, 6_000);
});
