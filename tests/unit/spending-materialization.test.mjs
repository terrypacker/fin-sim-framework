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
 * spending-materialization.test.mjs
 *
 * Tests for design/26 §4.2 — state.expenses materialization.
 *
 *   - state.expenses.{essential, discretionary} boot math
 *   - state.monthlyExpenses kept as sum after InflationAdjustReducer
 *   - InflationAdjustReducer inflates both slices correctly
 *   - Legacy state (no state.expenses) still works via scalar fallback
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import { InflationAdjustReducer }        from '../../src/finance/reducers/inflation-adjust-reducer.js';
import { SpendingStrategyApplyReducer }  from '../../src/finance/spending/spending-strategy-apply-reducer.js';

const US_ADV = { type: 'US_PERIOD_ADVANCE' };
const AU_ADV = { type: 'AU_PERIOD_ADVANCE' };

function stateWithExpenses({ monthlyExpenses = 10_000, discretionarySharePct = 0.30, residency = 'US', rate = 0.05 } = {}) {
  return {
    inflationRates:       { US: rate, AU: rate },
    inflationAccumulator: { US: 1.0, AU: 1.0 },
    people: { primary: { residency } },
    monthlyExpenses,
    expenses: {
      essential:     monthlyExpenses * (1 - discretionarySharePct),
      discretionary: monthlyExpenses * discretionarySharePct,
    },
  };
}

const reducer = new InflationAdjustReducer();

// ── Boot math ─────────────────────────────────────────────────────────────────

test('SPEND-MAT-1: essential + discretionary equal monthlyExpenses at boot', () => {
  const s = stateWithExpenses({ monthlyExpenses: 8_000, discretionarySharePct: 0.25 });
  assert.ok(Math.abs(s.expenses.essential     - 6_000) < 0.01);
  assert.ok(Math.abs(s.expenses.discretionary - 2_000) < 0.01);
  assert.ok(Math.abs(s.expenses.essential + s.expenses.discretionary - 8_000) < 0.01);
});

test('SPEND-MAT-2: default 30% split materializes correctly', () => {
  const s = stateWithExpenses({ monthlyExpenses: 6_000 });
  assert.ok(Math.abs(s.expenses.essential     - 4_200) < 0.01);
  assert.ok(Math.abs(s.expenses.discretionary - 1_800) < 0.01);
});

// ── InflationAdjustReducer: slice path ────────────────────────────────────────

test('SPEND-MAT-3: InflationAdjustReducer inflates both slices on US advance (US resident)', () => {
  const s    = stateWithExpenses({ monthlyExpenses: 10_000, discretionarySharePct: 0.30, rate: 0.05 });
  const next = reducer.reduce(s, US_ADV);
  assert.ok(Math.abs(next.expenses.essential     - 7_000 * 1.05) < 0.01);
  assert.ok(Math.abs(next.expenses.discretionary - 3_000 * 1.05) < 0.01);
});

test('SPEND-MAT-4: monthlyExpenses equals slice sum after inflation', () => {
  const s    = stateWithExpenses({ monthlyExpenses: 10_000, rate: 0.05 });
  const next = reducer.reduce(s, US_ADV);
  const expected = next.expenses.essential + next.expenses.discretionary;
  assert.ok(Math.abs(next.monthlyExpenses - expected) < 0.01);
});

test('SPEND-MAT-5: InflationAdjustReducer does NOT inflate slices on AU advance (US resident)', () => {
  const s    = stateWithExpenses({ monthlyExpenses: 10_000, rate: 0.05 });
  const next = reducer.reduce(s, AU_ADV);
  // Residence is US — AU advance should leave expenses unchanged
  assert.ok(Math.abs(next.expenses.essential     - 7_000) < 0.01);
  assert.ok(Math.abs(next.expenses.discretionary - 3_000) < 0.01);
  assert.ok(Math.abs(next.monthlyExpenses - 10_000) < 0.01);
});

test('SPEND-MAT-6: InflationAdjustReducer inflates slices on AU advance (AU resident)', () => {
  const s    = stateWithExpenses({ monthlyExpenses: 10_000, rate: 0.04, residency: 'AU' });
  const next = reducer.reduce(s, AU_ADV);
  assert.ok(Math.abs(next.expenses.essential     - 7_000 * 1.04) < 0.01);
  assert.ok(Math.abs(next.expenses.discretionary - 3_000 * 1.04) < 0.01);
  assert.ok(Math.abs(next.monthlyExpenses - 10_000 * 1.04) < 0.01);
});

test('SPEND-MAT-7: slices compound correctly over multiple years', () => {
  let s = stateWithExpenses({ monthlyExpenses: 6_000, discretionarySharePct: 0.30, rate: 0.03 });
  for (let i = 0; i < 5; i++) s = reducer.reduce(s, US_ADV);
  const factor = 1.03 ** 5;
  assert.ok(Math.abs(s.expenses.essential     - 4_200 * factor) < 0.01);
  assert.ok(Math.abs(s.expenses.discretionary - 1_800 * factor) < 0.01);
  assert.ok(Math.abs(s.monthlyExpenses - 6_000 * factor) < 0.01);
});

// ── Legacy fallback (no state.expenses) ──────────────────────────────────────

test('SPEND-MAT-8: legacy state without state.expenses still inflates monthlyExpenses scalar', () => {
  const s = {
    inflationRates: { US: 0.03, AU: 0.03 },
    inflationAccumulator: { US: 1.0, AU: 1.0 },
    people: { primary: { residency: 'US' } },
    monthlyExpenses: 6_000,
    // No expenses field — pre-design-26 state
  };
  const next = reducer.reduce(s, US_ADV);
  assert.ok(Math.abs(next.monthlyExpenses - 6_000 * 1.03) < 0.01);
  assert.strictEqual(next.expenses, undefined);
});

// ── SpendingStrategyApplyReducer ─────────────────────────────────────────────

const applyReducer = new SpendingStrategyApplyReducer();

test('SPEND-MAT-9: SpendingStrategyApplyReducer adds delta to discretionary slice', () => {
  const s = stateWithExpenses({ monthlyExpenses: 10_000 });
  const next = applyReducer.reduce(s, { type: 'SPENDING_STRATEGY_APPLY', slice: 'discretionary', delta: -300, reason: 'test' });
  assert.ok(Math.abs(next.expenses.discretionary - (3_000 - 300)) < 0.01);
  assert.ok(Math.abs(next.expenses.essential - 7_000) < 0.01);
  assert.ok(Math.abs(next.monthlyExpenses - 9_700) < 0.01);
});

test('SPEND-MAT-10: SpendingStrategyApplyReducer adds delta to essential slice', () => {
  const s = stateWithExpenses({ monthlyExpenses: 10_000 });
  const next = applyReducer.reduce(s, { type: 'SPENDING_STRATEGY_APPLY', slice: 'essential', delta: 500, reason: 'test' });
  assert.ok(Math.abs(next.expenses.essential - 7_500) < 0.01);
  assert.ok(Math.abs(next.monthlyExpenses - 10_500) < 0.01);
});

test('SPEND-MAT-11: SpendingStrategyApplyReducer no-ops when state.expenses absent', () => {
  const s = { monthlyExpenses: 6_000 };
  const next = applyReducer.reduce(s, { type: 'SPENDING_STRATEGY_APPLY', slice: 'discretionary', delta: -100 });
  assert.strictEqual(next.monthlyExpenses, 6_000);
});
