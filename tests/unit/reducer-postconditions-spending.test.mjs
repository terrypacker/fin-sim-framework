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
 * Group H — spending reducer postconditions (design 37 §6 H).
 *
 * All 8 are I1-PURE budget-slice / tracking reducers — none move cash or
 * holdings (the recurring debit is ExpenseDebitReducer's job, group D), so there
 * is no I3/I4/I5 here. They operate on state.expenses {essential, discretionary}
 * + state.monthlyExpenses, or on a tracking accumulator. Asserted I1 + I2
 * (determinism) + I7 (no-op) where tagged, plus I9 monotonicity for the
 * expense-event accumulator and the apply/revert round-trip for the multiplier
 * reducers (late-life care, regime-aware).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { runReducer, assertStateUnchanged } from '../helpers/reducer-postconditions.js';
import { makeAction } from '../helpers/reducer-fixtures.js';
import { REGIME_TAG } from '../../src/finance/economic-regimes/regime-tag.js';

import { SpendingStrategyApplyReducer } from '../../src/finance/spending/spending-strategy-apply-reducer.js';
import { AgeBandedSpendingReducer, DEFAULT_AGE_BANDS } from '../../src/finance/spending/strategies/age-banded-spending-reducer.js';
import { ageSpendingFactor } from '../../src/finance/spending/age-spending-factor.js';
import { GuardrailBaselineApplyReducer } from '../../src/finance/spending/strategies/guardrail-baseline-apply-reducer.js';
import { GuardrailAnnualCheckReducer } from '../../src/finance/spending/strategies/guardrail-annual-check-reducer.js';
import { GuardrailAdjustApplyReducer } from '../../src/finance/spending/strategies/guardrail-adjust-apply-reducer.js';
import { ExpenseEventApplyReducer } from '../../src/finance/spending/strategies/expense-event-apply-reducer.js';
import { LateLifeCareApplyReducer } from '../../src/finance/spending/strategies/late-life-care-apply-reducer.js';
import { RegimeAwareSpendingReducer } from '../../src/finance/spending/strategies/regime-aware-spending-reducer.js';

const DATE = new Date('2030-06-15');
const expenses = () => ({ essential: 3000, discretionary: 2000 });
const regime = (tag) => ({ id: 'r1', tags: [tag] });

// ─── SpendingStrategyApplyReducer (I1/I2/I7) ───────────────────────────────────

test('SpendingStrategyApplyReducer: applies delta to one slice, syncs monthlyExpenses (I1)', () => {
  const r = new SpendingStrategyApplyReducer();
  const next = runReducer(r, { expenses: expenses() }, makeAction('SPENDING_STRATEGY_APPLY', { delta: -500, slice: 'discretionary' }), DATE);
  assert.equal(next.expenses.discretionary, 1500);
  assert.equal(next.expenses.essential, 3000, 'other slice untouched');
  assert.equal(next.monthlyExpenses, 4500);
});

test('SpendingStrategyApplyReducer: no expenses / null delta / missing slice is a no-op (I7); deterministic (I2)', () => {
  const r = new SpendingStrategyApplyReducer();
  const noExpenses = { foo: 1 };
  assertStateUnchanged(noExpenses, runReducer(r, structuredClone(noExpenses), makeAction('SPENDING_STRATEGY_APPLY', { delta: -500, slice: 'discretionary' }), DATE));

  const prev = { expenses: expenses() };
  assertStateUnchanged(prev, runReducer(r, structuredClone(prev), makeAction('SPENDING_STRATEGY_APPLY', { delta: null, slice: 'discretionary' }), DATE));
  assertStateUnchanged(prev, runReducer(r, structuredClone(prev), makeAction('SPENDING_STRATEGY_APPLY', { delta: -500 }), DATE));

  const a = r.reduce({ expenses: expenses() }, makeAction('SPENDING_STRATEGY_APPLY', { delta: -500, slice: 'discretionary' }), DATE);
  const b = r.reduce({ expenses: expenses() }, makeAction('SPENDING_STRATEGY_APPLY', { delta: -500, slice: 'discretionary' }), DATE);
  assert.deepEqual(a, b);
});

// ─── AgeBandedSpendingReducer (I1/I2/I7) ───────────────────────────────────────

test('AgeBandedSpendingReducer: bends discretionary by the age-band real multiplier (I1)', () => {
  const r = new AgeBandedSpendingReducer();
  // Age 75 as of action.date → slow-go band, factor 0.90 (no within-band drift at startAge).
  const state = {
    expenses: expenses(),
    people: { p1: { residency: 'US', birthDate: new Date('1955-01-01') } },
  };
  const next = runReducer(r, state, makeAction('US_PERIOD_ADVANCE', { date: DATE }), DATE);
  const target = ageSpendingFactor(75, DEFAULT_AGE_BANDS);
  assert.equal(target, 0.90);
  assert.equal(+next.expenses.discretionary.toFixed(2), +(2000 * target).toFixed(2)); // 1800
  assert.equal(next.ageBandSpending.appliedFactor, target);
  assert.equal(next.expenses.essential, 3000, 'default slice=discretionary leaves essential');
});

test('AgeBandedSpendingReducer: off-residence advance and no-expenses are no-ops (I7); idempotent within a year', () => {
  const r = new AgeBandedSpendingReducer();
  const state = {
    expenses: expenses(),
    people: { p1: { residency: 'US', birthDate: new Date('1955-01-01') } },
  };
  // AU advance for a US resident — gated out.
  assertStateUnchanged(state, runReducer(r, structuredClone(state), makeAction('AU_PERIOD_ADVANCE', { date: DATE }), DATE));
  // No expenses slice.
  assertStateUnchanged({ people: state.people }, runReducer(r, { people: state.people }, makeAction('US_PERIOD_ADVANCE', { date: DATE }), DATE));
  // Idempotent: re-running once the factor is already applied is a no-op.
  const once  = r.reduce(structuredClone(state), makeAction('US_PERIOD_ADVANCE', { date: DATE }), DATE);
  const twice = r.reduce(once, makeAction('US_PERIOD_ADVANCE', { date: DATE }), DATE);
  assert.equal(+twice.expenses.discretionary.toFixed(2), +once.expenses.discretionary.toFixed(2));
});

// ─── GuardrailBaselineApplyReducer (I1) ────────────────────────────────────────

test('GuardrailBaselineApplyReducer: captures the baseline and initializes guardrail shape (I1)', () => {
  const r = new GuardrailBaselineApplyReducer();
  const next = runReducer(r, { foo: 1 }, makeAction('GUARDRAIL_BASELINE_APPLY', {
    initialWithdrawalRate: 0.04, portfolioValue: 1_000_000, annualSpending: 40_000, date: DATE,
  }), DATE);
  assert.equal(next.guardrail.initialWithdrawalRate, 0.04);
  assert.equal(next.guardrail.currentAdjustmentMultiplier, 1.0);
  assert.equal(next.guardrail.baselineDate, DATE);
  assert.equal(next.guardrail.lastAdjustmentDate, null);
});

// ─── GuardrailAnnualCheckReducer (I1/I2/I7) ────────────────────────────────────

test('GuardrailAnnualCheckReducer: fires a CUT when the withdrawal rate breaches the upper band (I1)', () => {
  const r = new GuardrailAnnualCheckReducer();
  const state = {
    guardrail: { initialWithdrawalRate: 0.04 },
    expenses: expenses(),                    // 5000/mo → 60k/yr
    portfolio: { drawdownPriority: 0, balance: 1_000_000 }, // rate 0.06 > 0.048 cut band
  };
  const next = runReducer(r, state, makeAction('US_PERIOD_ADVANCE', { date: DATE }), DATE);
  const adj = next.next.find(a => a.type === 'GUARDRAIL_ADJUST_APPLY');
  assert.ok(adj);
  assert.equal(adj.cause, 'cut');
  assert.equal(adj.multiplier, 0.9);
});

test('GuardrailAnnualCheckReducer: within-band rate and no baseline are no-ops (I7); deterministic (I2)', () => {
  const r = new GuardrailAnnualCheckReducer();
  // rate 60k/1.5M = 0.04 == initial → within band → no action.
  const within = { guardrail: { initialWithdrawalRate: 0.04 }, expenses: expenses(), portfolio: { drawdownPriority: 0, balance: 1_500_000 } };
  assert.equal(runReducer(r, within, makeAction('US_PERIOD_ADVANCE', { date: DATE }), DATE).next.length, 0);
  // No baseline captured yet.
  const noBaseline = { expenses: expenses(), portfolio: { drawdownPriority: 0, balance: 1_000_000 } };
  assert.equal(runReducer(r, noBaseline, makeAction('US_PERIOD_ADVANCE', { date: DATE }), DATE).next.length, 0);

  const s = { guardrail: { initialWithdrawalRate: 0.04 }, expenses: expenses(), portfolio: { drawdownPriority: 0, balance: 1_000_000 } };
  assert.deepEqual(
    r.reduce(structuredClone(s), makeAction('US_PERIOD_ADVANCE', { date: DATE }), DATE),
    r.reduce(structuredClone(s), makeAction('US_PERIOD_ADVANCE', { date: DATE }), DATE),
  );
});

// ─── GuardrailAdjustApplyReducer (I1/I7) ───────────────────────────────────────

test('GuardrailAdjustApplyReducer: applies the multiplier to discretionary and compounds the tracker (I1)', () => {
  const r = new GuardrailAdjustApplyReducer();
  const state = { expenses: expenses(), guardrail: { currentAdjustmentMultiplier: 1.0 } };
  const next = runReducer(r, state, makeAction('GUARDRAIL_ADJUST_APPLY', { multiplier: 0.9, cause: 'cut', date: DATE }), DATE);
  assert.equal(next.expenses.discretionary, 1800);
  assert.equal(next.monthlyExpenses, 4800);
  assert.equal(next.guardrail.currentAdjustmentMultiplier, 0.9);
  assert.equal(next.guardrail.lastAdjustmentCause, 'cut');
});

test('GuardrailAdjustApplyReducer: no expenses / null multiplier is a no-op (I7)', () => {
  const r = new GuardrailAdjustApplyReducer();
  assertStateUnchanged({ foo: 1 }, runReducer(r, { foo: 1 }, makeAction('GUARDRAIL_ADJUST_APPLY', { multiplier: 0.9 }), DATE));
  const prev = { expenses: expenses() };
  assertStateUnchanged(prev, runReducer(r, structuredClone(prev), makeAction('GUARDRAIL_ADJUST_APPLY', { multiplier: null }), DATE));
});

// ─── ExpenseEventApplyReducer (I1/I9 monotonic accumulator) ────────────────────

test('ExpenseEventApplyReducer: accumulates per-category + lifetime totals; monotonic (I9)', () => {
  const r = new ExpenseEventApplyReducer();
  const first = runReducer(r, { expenseEventSpendingByCategory: { ACUTE: 1000 }, expenseEventSpendingTotal: 5000 },
    makeAction('EXPENSE_EVENT_APPLY', { amount: 2000, category: 'ACUTE' }), DATE);
  assert.equal(first.expenseEventSpendingByCategory.ACUTE, 3000);
  assert.equal(first.expenseEventSpendingTotal, 7000);
  // I9 — re-applying only grows the cumulative total, and a new category cannot
  // disturb an existing one.
  const second = runReducer(r, first, makeAction('EXPENSE_EVENT_APPLY', { amount: 500, category: 'ROOF' }), DATE);
  assert.ok(second.expenseEventSpendingTotal >= first.expenseEventSpendingTotal);
  assert.equal(second.expenseEventSpendingTotal, 7500);
  assert.equal(second.expenseEventSpendingByCategory.ACUTE, 3000);
  assert.equal(second.expenseEventSpendingByCategory.ROOF, 500);
});

// ─── LateLifeCareApplyReducer (I1/I7 apply+revert round-trip) ──────────────────

test('LateLifeCareApplyReducer: apply multiplies both slices; revert restores them exactly (I1)', () => {
  const r = new LateLifeCareApplyReducer();
  const applied = runReducer(r, { expenses: expenses() },
    makeAction('LATE_LIFE_CARE_APPLY', { active: true, factor: 2.0, personId: 'p1' }), DATE);
  assert.equal(applied.expenses.essential, 6000);
  assert.equal(applied.expenses.discretionary, 4000);
  assert.equal(applied.lateLifeCare.p1.appliedFactor, 2.0);

  const reverted = runReducer(r, applied,
    makeAction('LATE_LIFE_CARE_APPLY', { active: false, personId: 'p1' }), DATE);
  assert.equal(reverted.expenses.essential, 3000, 'revert divides by the stored factor');
  assert.equal(reverted.expenses.discretionary, 2000);
  assert.equal(reverted.lateLifeCare.p1, undefined, 'entry cleared on revert');
});

test('LateLifeCareApplyReducer: no expenses is a no-op (I7)', () => {
  const r = new LateLifeCareApplyReducer();
  assertStateUnchanged({ foo: 1 }, runReducer(r, { foo: 1 }, makeAction('LATE_LIFE_CARE_APPLY', { active: true, factor: 2 }), DATE));
});

// ─── RegimeAwareSpendingReducer (I1/I2/I7 apply+revert) ────────────────────────

test('RegimeAwareSpendingReducer: cuts discretionary on stress entry; reverts on exit (I1)', () => {
  const r = new RegimeAwareSpendingReducer(); // default 15% cut
  const onEntry = runReducer(r, { expenses: expenses(), activeRegimes: [regime(REGIME_TAG.ECONOMIC_STRESS)] },
    makeAction('US_PERIOD_ADVANCE'), DATE);
  assert.equal(onEntry.expenses.discretionary, 1700); // 2000 × 0.85
  assert.equal(onEntry.regimeActions.spending_discretionary_cut.active, true);

  // Regime ended: entry active, regime gone → divide back out.
  const onExit = runReducer(r, { expenses: { essential: 3000, discretionary: 1700 }, activeRegimes: [], regimeActions: { spending_discretionary_cut: { active: true, appliedMultiplier: 0.85 } } },
    makeAction('US_PERIOD_ADVANCE'), DATE);
  assert.equal(+onExit.expenses.discretionary.toFixed(2), 2000);
  assert.equal(onExit.regimeActions.spending_discretionary_cut.active, false);
});

test('RegimeAwareSpendingReducer: state matching the regime is a no-op (I7); deterministic (I2)', () => {
  const r = new RegimeAwareSpendingReducer();
  // No stress + already inactive → no change.
  const prev = { expenses: expenses(), activeRegimes: [], regimeActions: { spending_discretionary_cut: { active: false, appliedMultiplier: null } } };
  assertStateUnchanged(prev, runReducer(r, structuredClone(prev), makeAction('US_PERIOD_ADVANCE'), DATE));

  const s = { expenses: expenses(), activeRegimes: [regime(REGIME_TAG.ECONOMIC_STRESS)] };
  assert.deepEqual(
    r.reduce(structuredClone(s), makeAction('US_PERIOD_ADVANCE'), DATE),
    r.reduce(structuredClone(s), makeAction('US_PERIOD_ADVANCE'), DATE),
  );
});
