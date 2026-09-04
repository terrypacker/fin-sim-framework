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
 * spending-regime-aware.test.mjs
 *
 * Tests for design/26 §3 RegimeAware strategy and §6 state.regimeActions.
 *
 *   - Cut applies when ECONOMIC_STRESS regime becomes active
 *   - Cut does not compound if regime remains active across periods
 *   - Cut reverts when regime ends
 *   - Multiple ECONOMIC_STRESS regimes still fire only one cut
 *   - Regimes without the tag have no effect
 *   - state.regimeActions.spending_discretionary_cut tracks correctly
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import { RegimeAwareSpendingReducer } from '../../src/finance/spending/strategies/regime-aware-spending-reducer.js';
import { InflationAdjustReducer }     from '../../src/finance/reducers/inflation-adjust-reducer.js';
import { REGIME_TAG }                 from '../../src/finance/economic-regimes/regime-tag.js';

const US_ADV = { type: 'US_PERIOD_ADVANCE' };

function baseState({ discretionary = 3_000, essential = 7_000, activeRegimes = [], regimeActions = {} } = {}) {
  return {
    expenses: { essential, discretionary },
    monthlyExpenses: essential + discretionary,
    activeRegimes,
    regimeActions,
    people: { primary: { residency: 'US' } },
  };
}

function stressRegime(id = 'r1') {
  return { id, shockId: id, tags: [REGIME_TAG.ECONOMIC_STRESS] };
}

function noTagRegime(id = 'r2') {
  return { id, shockId: id, tags: [] };
}

const reducer = new RegimeAwareSpendingReducer({ regimeAwareCutPct: 0.20 }); // 20% cut for easy math

// ── Cut application ───────────────────────────────────────────────────────────

test('SPEND-RA-1: cut applies to discretionary when ECONOMIC_STRESS regime activates', () => {
  const s    = baseState({ activeRegimes: [stressRegime()] });
  const next = reducer.reduce(s, US_ADV);
  assert.ok(Math.abs(next.expenses.discretionary - 3_000 * 0.80) < 0.01);
  assert.ok(Math.abs(next.expenses.essential - 7_000) < 0.01); // essential unchanged
});

test('SPEND-RA-2: monthlyExpenses synced after cut', () => {
  const s    = baseState({ activeRegimes: [stressRegime()] });
  const next = reducer.reduce(s, US_ADV);
  const expected = next.expenses.essential + next.expenses.discretionary;
  assert.ok(Math.abs(next.monthlyExpenses - expected) < 0.01);
});

test('SPEND-RA-3: regimeActions.spending_discretionary_cut.active is true after cut', () => {
  const s    = baseState({ activeRegimes: [stressRegime()] });
  const next = reducer.reduce(s, US_ADV);
  assert.strictEqual(next.regimeActions.spending_discretionary_cut.active, true);
  assert.ok(Math.abs(next.regimeActions.spending_discretionary_cut.appliedMultiplier - 0.80) < 1e-10);
});

// ── No compounding ────────────────────────────────────────────────────────────

test('SPEND-RA-4: cut does NOT compound if regime remains active across periods', () => {
  let s = baseState({ activeRegimes: [stressRegime()] });
  s = reducer.reduce(s, US_ADV); // cut applied: 3000 → 2400
  const afterFirstCut = s.expenses.discretionary;

  s = reducer.reduce(s, US_ADV); // regime still active — no change
  assert.ok(Math.abs(s.expenses.discretionary - afterFirstCut) < 0.01);
});

// ── Revert ────────────────────────────────────────────────────────────────────

test('SPEND-RA-5: cut reverts when regime ends', () => {
  let s = baseState({ activeRegimes: [stressRegime()] });
  s = reducer.reduce(s, US_ADV); // cut applied
  const cutDiscretionary = s.expenses.discretionary;

  // Regime ends
  s = { ...s, activeRegimes: [] };
  s = reducer.reduce(s, US_ADV);
  assert.ok(Math.abs(s.expenses.discretionary - 3_000) < 0.01); // restored
});

test('SPEND-RA-6: regimeActions cleared after regime ends', () => {
  let s = baseState({ activeRegimes: [stressRegime()] });
  s = reducer.reduce(s, US_ADV);
  s = { ...s, activeRegimes: [] };
  s = reducer.reduce(s, US_ADV);
  assert.strictEqual(s.regimeActions.spending_discretionary_cut.active, false);
  assert.strictEqual(s.regimeActions.spending_discretionary_cut.appliedMultiplier, null);
});

test('SPEND-RA-7: monthlyExpenses correct after revert', () => {
  let s = baseState({ activeRegimes: [stressRegime()] });
  s = reducer.reduce(s, US_ADV);
  s = { ...s, activeRegimes: [] };
  s = reducer.reduce(s, US_ADV);
  assert.ok(Math.abs(s.monthlyExpenses - 10_000) < 0.01);
});

// ── Multiple ECONOMIC_STRESS regimes ─────────────────────────────────────────

test('SPEND-RA-8: two ECONOMIC_STRESS regimes result in only one cut', () => {
  const s    = baseState({ activeRegimes: [stressRegime('r1'), stressRegime('r2')] });
  const next = reducer.reduce(s, US_ADV);
  // Cut should fire once (20%), not twice (which would be 0.8 * 0.8 = 0.64)
  assert.ok(Math.abs(next.expenses.discretionary - 3_000 * 0.80) < 0.01);
});

// ── Non-stress regimes ────────────────────────────────────────────────────────

test('SPEND-RA-9: regime without ECONOMIC_STRESS tag has no effect', () => {
  const s    = baseState({ activeRegimes: [noTagRegime()] });
  const next = reducer.reduce(s, US_ADV);
  assert.ok(Math.abs(next.expenses.discretionary - 3_000) < 0.01);
  assert.ok(Math.abs(next.monthlyExpenses - 10_000) < 0.01);
});

test('SPEND-RA-10: no-op when no active regimes', () => {
  const s    = baseState({ activeRegimes: [] });
  const next = reducer.reduce(s, US_ADV);
  assert.ok(Math.abs(next.expenses.discretionary - 3_000) < 0.01);
});

// ── State.expenses absent (guard) ─────────────────────────────────────────────

test('SPEND-RA-11: no-op when state.expenses absent', () => {
  const s = {
    monthlyExpenses: 6_000,
    activeRegimes:   [stressRegime()],
    regimeActions:   {},
  };
  const next = reducer.reduce(s, US_ADV);
  assert.strictEqual(next.monthlyExpenses, 6_000);
  assert.strictEqual(next.expenses, undefined);
});

// ── Apply/revert cycle with inflation in between ──────────────────────────────

test('SPEND-RA-12: cut and revert correct when inflation ran while regime was active', () => {
  const inflationReducer = new InflationAdjustReducer();

  let s = baseState({ activeRegimes: [stressRegime()], discretionary: 3_000, essential: 7_000 });
  s = { ...s, inflationRates: { US: 0.03, AU: 0.03 }, inflationAccumulator: { US: 1.0, AU: 1.0 } };

  // Year 1: regime activates, cut applied (before inflation for simplicity here)
  s = reducer.reduce(s, US_ADV);         // cut: 3000 → 2400, essential 7000
  s = inflationReducer.reduce(s, US_ADV); // inflate slices 3%

  const afterInflation = {
    essential: 7_000 * 1.03,
    discretionary: 2_400 * 1.03,
  };
  assert.ok(Math.abs(s.expenses.essential - afterInflation.essential) < 0.01);
  assert.ok(Math.abs(s.expenses.discretionary - afterInflation.discretionary) < 0.01);

  // Year 2: regime ends — revert via stored multiplier (0.80)
  s = { ...s, activeRegimes: [] };
  s = reducer.reduce(s, US_ADV);
  // Revert: discretionary /= 0.80
  const reverted = afterInflation.discretionary / 0.80;
  assert.ok(Math.abs(s.expenses.discretionary - reverted) < 0.01);
});

// ── Full cut (regimeAwareCutPct = 1) ─────────────────────────────────────────
//
// A 100% cut multiplies the slice by zero. Dividing zero back out produced NaN,
// which propagated into monthlyExpenses and never washed out — the run spent
// NaN for the rest of its life. These pin the recovery path.

test('SPEND-RA-13: a full cut zeroes discretionary and leaves essential spending intact', () => {
  const full = new RegimeAwareSpendingReducer({ regimeAwareCutPct: 1.0 });
  const next = full.reduce(baseState({ activeRegimes: [stressRegime()] }), US_ADV);

  assert.strictEqual(next.expenses.discretionary, 0);
  assert.ok(Math.abs(next.expenses.essential - 7_000) < 0.01);
  assert.ok(Math.abs(next.monthlyExpenses - 7_000) < 0.01);
});

test('SPEND-RA-14: a full cut reverts to the pre-cut level, not NaN', () => {
  const full = new RegimeAwareSpendingReducer({ regimeAwareCutPct: 1.0 });

  let s = full.reduce(baseState({ activeRegimes: [stressRegime()] }), US_ADV);
  s = full.reduce({ ...s, activeRegimes: [] }, US_ADV);

  assert.ok(Number.isFinite(s.expenses.discretionary));
  assert.ok(Math.abs(s.expenses.discretionary - 3_000) < 0.01);
  assert.ok(Math.abs(s.monthlyExpenses - 10_000) < 0.01);
});

test('SPEND-RA-15: a full cut reverts to the INFLATED pre-cut level', () => {
  const full             = new RegimeAwareSpendingReducer({ regimeAwareCutPct: 1.0 });
  const inflationReducer = new InflationAdjustReducer();

  let s = baseState({ activeRegimes: [stressRegime()] });
  s = { ...s, inflationRates: { US: 0.03, AU: 0.03 }, inflationAccumulator: { US: 1.0, AU: 1.0 } };

  s = full.reduce(s, US_ADV);              // discretionary → 0, essential 7000
  s = inflationReducer.reduce(s, US_ADV);  // essential → 7210, discretionary stays 0

  s = full.reduce({ ...s, activeRegimes: [] }, US_ADV);

  // Both slices inflate at the same residence rate, so essential's growth is an
  // exact stand-in for the discretionary growth the zeroed slice never got.
  assert.ok(Math.abs(s.expenses.discretionary - 3_000 * 1.03) < 0.01);
  assert.ok(Math.abs(s.monthlyExpenses - 10_000 * 1.03) < 0.01);
});

test('SPEND-RA-16: a full cut survives a second regime cycle', () => {
  const full = new RegimeAwareSpendingReducer({ regimeAwareCutPct: 1.0 });

  let s = baseState({ activeRegimes: [stressRegime()] });
  for (const regimes of [[stressRegime()], [], [stressRegime()], []]) {
    s = full.reduce({ ...s, activeRegimes: regimes }, US_ADV);
  }

  assert.ok(Math.abs(s.expenses.discretionary - 3_000) < 0.01);
  assert.ok(Math.abs(s.monthlyExpenses - 10_000) < 0.01);
});

// ── Trigger timing (the one-year lag) ────────────────────────────────────────
//
// Listening only to the annual period advance made the cut land late by the gap
// to the next boundary — 1 Jan (US) or 1 Jul (AU). A shock dated 1 Jan pushes
// its regime via ADD_REGIME_APPLY from its own event, which shares that date and
// `order: 0` with PERIOD_ADVANCE_US, so which ran first was a queue tiebreak.
// When the advance won, the household spent its pre-crash budget for six months.

test('SPEND-RA-17: the cut fires on ADD_REGIME_APPLY, not only on a period advance', () => {
  const s    = baseState({ activeRegimes: [stressRegime()] });
  const next = reducer.reduce(s, { type: 'ADD_REGIME_APPLY' });

  assert.ok(Math.abs(next.expenses.discretionary - 3_000 * 0.80) < 0.01);
  assert.strictEqual(next.regimeActions.spending_discretionary_cut.active, true);
});

test('SPEND-RA-18: the revert fires on the recovery tick that drops the regime', () => {
  let s = reducer.reduce(baseState({ activeRegimes: [stressRegime()] }), { type: 'ADD_REGIME_APPLY' });

  // RegimeApplyReducer has already dropped the recovered regime by the time this
  // reducer sees the same RECOMPUTE_REGIMES — it owns the stack two priorities up.
  s = reducer.reduce({ ...s, activeRegimes: [] }, { type: 'RECOMPUTE_REGIMES' });

  assert.ok(Math.abs(s.expenses.discretionary - 3_000) < 0.01);
  assert.strictEqual(s.regimeActions.spending_discretionary_cut.active, false);
});

test('SPEND-RA-19: the regime actions are declared as reduced action types', () => {
  for (const t of ['ADD_REGIME_APPLY', 'REMOVE_REGIME_APPLY', 'RECOMPUTE_REGIMES']) {
    assert.ok(reducer.reducedActionTypes.includes(t), `missing ${t}`);
  }
});

test('SPEND-RA-20: mixing regime actions and period advances still cuts exactly once', () => {
  let s = baseState({ activeRegimes: [stressRegime()] });
  s = reducer.reduce(s, { type: 'ADD_REGIME_APPLY' });   // cut
  s = reducer.reduce(s, { type: 'RECOMPUTE_REGIMES' });  // still active — no-op
  s = reducer.reduce(s, US_ADV);                          // still active — no-op

  assert.ok(Math.abs(s.expenses.discretionary - 3_000 * 0.80) < 0.01);
});
