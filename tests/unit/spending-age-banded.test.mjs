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
 * spending-age-banded.test.mjs
 *
 * Tests for design/33 AGE_BANDED spending strategy.
 *
 *   - ageSpendingFactor pure-function table: pre-band → 1.0; band-boundary step;
 *     intra-band drift; pure-drift and pure-step degenerate configs.
 *   - reducer pins the target factor on a period advance and does NOT compound
 *     across consecutive years (the key correctness assertion).
 *   - composes with inflation: nominal = inflation × age-factor; real = age-factor.
 *   - discretionary-only by default; 'both' touches essential too.
 *   - state.monthlyExpenses derived sum stays consistent.
 *   - residence gate: a US+AU couple is not adjusted twice per year.
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import { ageSpendingFactor }            from '../../src/finance/spending/age-spending-factor.js';
import { AgeBandedSpendingReducer, DEFAULT_AGE_BANDS } from '../../src/finance/spending/strategies/age-banded-spending-reducer.js';
import { InflationAdjustReducer }       from '../../src/finance/reducers/inflation-adjust-reducer.js';

const close = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

// ── ageSpendingFactor (pure) ─────────────────────────────────────────────────

test('SPEND-AB-1: age below the first band returns 1.0 baseline', () => {
  const bands = [{ startAge: 65, multiplier: 0.9, annualRealDrift: -0.01 }];
  assert.ok(close(ageSpendingFactor(50, bands), 1.0));
  assert.ok(close(ageSpendingFactor(64, bands), 1.0));
});

test('SPEND-AB-2: default table — boundary step + cumulative product', () => {
  // At 65: cumulative 1.0, no drift offset → 1.0
  assert.ok(close(ageSpendingFactor(65, DEFAULT_AGE_BANDS), 1.0));
  // At 75: cumulative 1.0 * 1.0 * 0.90 = 0.90
  assert.ok(close(ageSpendingFactor(75, DEFAULT_AGE_BANDS), 0.90));
  // At 85: cumulative 0.90 * 0.90 = 0.81 (no-go plateau, drift 0)
  assert.ok(close(ageSpendingFactor(85, DEFAULT_AGE_BANDS), 0.81));
  assert.ok(close(ageSpendingFactor(92, DEFAULT_AGE_BANDS), 0.81)); // plateau holds
});

test('SPEND-AB-3: intra-band drift compounds from the band start', () => {
  // Go-go band: 1.0 cumulative, -1%/yr drift. Age 70 = 0.99^5.
  assert.ok(close(ageSpendingFactor(70, DEFAULT_AGE_BANDS), Math.pow(0.99, 5)));
});

test('SPEND-AB-4: pure-drift config (all multiplier 1.0) reproduces ~1%/yr decline', () => {
  const bands = [
    { startAge: 0,  multiplier: 1.0, annualRealDrift:  0.0  },
    { startAge: 65, multiplier: 1.0, annualRealDrift: -0.01 },
  ];
  assert.ok(close(ageSpendingFactor(75, bands), Math.pow(0.99, 10)));
  assert.ok(close(ageSpendingFactor(85, bands), Math.pow(0.99, 20)));
});

test('SPEND-AB-5: pure-step config (all drift 0) is flat within a band', () => {
  const bands = [
    { startAge: 0,  multiplier: 1.0,  annualRealDrift: 0 },
    { startAge: 65, multiplier: 1.0,  annualRealDrift: 0 },
    { startAge: 75, multiplier: 0.85, annualRealDrift: 0 },
  ];
  assert.ok(close(ageSpendingFactor(75, bands), 0.85));
  assert.ok(close(ageSpendingFactor(80, bands), 0.85)); // flat within band
  assert.ok(close(ageSpendingFactor(74, bands), 1.0));
});

// ── Reducer ──────────────────────────────────────────────────────────────────

// Simple 10%/yr decline band for clean assertions.
const DECLINE_BANDS = [
  { startAge: 0,  multiplier: 1.0, annualRealDrift:  0.0  },
  { startAge: 65, multiplier: 1.0, annualRealDrift: -0.10 },
];

function baseState({ discretionary = 3_000, essential = 7_000, birthDate = new Date(Date.UTC(1950, 0, 1)) } = {}) {
  return {
    expenses: { essential, discretionary },
    monthlyExpenses: essential + discretionary,
    people: { primary: { residency: 'US', birthDate } },
    ageBandSpending: { appliedFactor: 1.0, currentBandStartAge: null },
  };
}

// Advance whose date makes the primary (born 1950-01-01) exactly `age` years old.
const advAtAge = (age, cc = 'US') => ({ type: `${cc}_PERIOD_ADVANCE`, date: new Date(Date.UTC(1950 + age, 0, 2)) });

const reducer = new AgeBandedSpendingReducer({ bands: DECLINE_BANDS });

test('SPEND-AB-6: applies the target factor on a period advance (discretionary only)', () => {
  const s    = baseState();
  const next = reducer.reduce(s, advAtAge(66)); // factor 0.90^1 = 0.90
  assert.ok(close(next.expenses.discretionary, 3_000 * 0.90, 1e-6));
  assert.ok(close(next.expenses.essential, 7_000, 1e-6)); // essential untouched
  assert.ok(close(next.ageBandSpending.appliedFactor, 0.90, 1e-9));
  assert.strictEqual(next.ageBandSpending.currentBandStartAge, 65);
});

test('SPEND-AB-7: monthlyExpenses derived sum stays consistent', () => {
  const next = reducer.reduce(baseState(), advAtAge(66));
  assert.ok(close(next.monthlyExpenses, next.expenses.essential + next.expenses.discretionary, 1e-6));
});

test('SPEND-AB-8: does NOT compound when re-applied within the same year', () => {
  let s = reducer.reduce(baseState(), advAtAge(66)); // 3000 → 2700
  const afterFirst = s.expenses.discretionary;
  s = reducer.reduce(s, advAtAge(66)); // same age → no-op
  assert.ok(close(s.expenses.discretionary, afterFirst, 1e-9));
});

test('SPEND-AB-9: tracks the absolute factor across years (no ratchet)', () => {
  let s = baseState();
  s = reducer.reduce(s, advAtAge(66)); // factor 0.90 → discretionary 2700
  s = reducer.reduce(s, advAtAge(67)); // factor 0.81 → discretionary should be 3000 * 0.81
  assert.ok(close(s.expenses.discretionary, 3_000 * 0.81, 1e-6));
  assert.ok(close(s.ageBandSpending.appliedFactor, 0.81, 1e-9));
});

test('SPEND-AB-10: composes with inflation — nominal = inflation × age-factor; real = age-factor', () => {
  const inflation = new InflationAdjustReducer();
  let s = baseState();
  s = { ...s, inflationRates: { US: 0.03 }, inflationAccumulator: { US: 1.0 } };

  // Year 1 (age 66): inflate slices 3%, then apply age factor 0.90.
  s = inflation.reduce(s, advAtAge(66));
  s = reducer.reduce(s, advAtAge(66));

  const nominalDisc = 3_000 * 1.03 * 0.90;
  assert.ok(close(s.expenses.discretionary, nominalDisc, 1e-6));

  // Real discretionary = nominal / inflationAccumulator = original × age-factor.
  const realDisc = s.expenses.discretionary / s.inflationAccumulator.US;
  assert.ok(close(realDisc, 3_000 * 0.90, 1e-6));
});

test("SPEND-AB-11: slice 'both' bends essential too", () => {
  const both = new AgeBandedSpendingReducer({ bands: DECLINE_BANDS, slice: 'both' });
  const next = both.reduce(baseState(), advAtAge(66)); // factor 0.90
  assert.ok(close(next.expenses.discretionary, 3_000 * 0.90, 1e-6));
  assert.ok(close(next.expenses.essential,     7_000 * 0.90, 1e-6));
});

test('SPEND-AB-12: residence gate — AU advance is a no-op for a US-resident household', () => {
  const next = reducer.reduce(baseState(), advAtAge(66, 'AU'));
  assert.ok(close(next.expenses.discretionary, 3_000, 1e-9)); // unchanged
  assert.ok(close(next.ageBandSpending.appliedFactor, 1.0, 1e-9));
});

test('SPEND-AB-13: US+AU couple is not adjusted twice in one year', () => {
  let s = baseState(); // US resident
  s = reducer.reduce(s, advAtAge(66, 'US')); // applies → 2700
  s = reducer.reduce(s, advAtAge(66, 'AU')); // gated out → no second cut
  assert.ok(close(s.expenses.discretionary, 3_000 * 0.90, 1e-6));
});

test('SPEND-AB-14: no-op when state.expenses absent', () => {
  const s = { monthlyExpenses: 6_000, people: { primary: { residency: 'US', birthDate: new Date(Date.UTC(1950, 0, 1)) } } };
  const next = reducer.reduce(s, advAtAge(66));
  assert.strictEqual(next.monthlyExpenses, 6_000);
  assert.strictEqual(next.expenses, undefined);
});

test('SPEND-AB-15: no-op before the primary reaches the first band age', () => {
  const next = reducer.reduce(baseState(), advAtAge(60)); // below 65
  assert.ok(close(next.expenses.discretionary, 3_000, 1e-9));
  assert.ok(close(next.ageBandSpending.appliedFactor, 1.0, 1e-9));
});
