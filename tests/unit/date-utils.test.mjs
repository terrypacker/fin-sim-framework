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
 * date-utils.test.mjs
 * Tests for DateUtils
 * Run with: node --test tests/date-utils.test.mjs
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import { DateUtils } from '../../src/simulation-framework/date-utils.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function ymd(d) {
  return { y: d.getUTCFullYear(), m: d.getUTCMonth(), d: d.getUTCDate() };
}

function assertDate(actual, expectedYear, expectedMonth, expectedDay) {
  const { y, m, d } = ymd(actual);
  assert.strictEqual(y, expectedYear,  `year: expected ${expectedYear}, got ${y}`);
  assert.strictEqual(m, expectedMonth, `month (0-indexed): expected ${expectedMonth}, got ${m}`);
  assert.strictEqual(d, expectedDay,   `day: expected ${expectedDay}, got ${d}`);
}

// ─── addDays ─────────────────────────────────────────────────────────────────

test('addDays: adds positive days within the same month', () => {
  const result = DateUtils.addDays(new Date(2025, 0, 10), 5);
  assertDate(result, 2025, 0, 15);
});

test('addDays: crossing a month boundary', () => {
  const result = DateUtils.addDays(new Date(2025, 0, 28), 5);
  assertDate(result, 2025, 1, 2);  // Jan 28 + 5 = Feb 2
});

test('addDays: crossing a year boundary', () => {
  const result = DateUtils.addDays(new Date(2025, 11, 30), 5);
  assertDate(result, 2026, 0, 4);  // Dec 30 + 5 = Jan 4
});

test('addDays: adding zero days returns same date', () => {
  const result = DateUtils.addDays(new Date(2025, 5, 15), 0);
  assertDate(result, 2025, 5, 15);
});

test('addDays: negative days subtracts into previous month', () => {
  const result = DateUtils.addDays(new Date(2025, 1, 3), -5);
  assertDate(result, 2025, 0, 29);  // Feb 3 - 5 = Jan 29
});

test('addDays: does not mutate the input date', () => {
  const input  = new Date(2025, 0, 10);
  const before = input.getTime();
  DateUtils.addDays(input, 10);
  assert.strictEqual(input.getTime(), before, 'input date should not be mutated');
});

// ─── addMonths ────────────────────────────────────────────────────────────────

test('addMonths: adds months within the same year', () => {
  const result = DateUtils.addMonths(new Date(2025, 0, 1), 3);
  assertDate(result, 2025, 3, 1);  // Jan → Apr
});

test('addMonths: crossing a year boundary', () => {
  const result = DateUtils.addMonths(new Date(2025, 9, 1), 3);
  assertDate(result, 2026, 0, 1);  // Oct + 3 = Jan next year
});

test('addMonths: adding 12 months advances by one year', () => {
  const result = DateUtils.addMonths(new Date(2025, 5, 15), 12);
  assertDate(result, 2026, 5, 15);
});

test('addMonths: adding zero months returns same date', () => {
  const result = DateUtils.addMonths(new Date(2025, 3, 10), 0);
  assertDate(result, 2025, 3, 10);
});

test('addMonths: negative months moves to previous year', () => {
  const result = DateUtils.addMonths(new Date(2025, 1, 1), -3);
  assertDate(result, 2024, 10, 1);  // Feb 2025 - 3 = Nov 2024
});

test('addMonths: does not mutate the input date', () => {
  const input  = new Date(2025, 0, 1);
  const before = input.getTime();
  DateUtils.addMonths(input, 6);
  assert.strictEqual(input.getTime(), before, 'input date should not be mutated');
});

// ─── addYears ────────────────────────────────────────────────────────────────

test('addYears: adds a single year', () => {
  const result = DateUtils.addYears(new Date(2025, 0, 1), 1);
  assertDate(result, 2026, 0, 1);
});

test('addYears: adds multiple years', () => {
  const result = DateUtils.addYears(new Date(2025, 6, 4), 10);
  assertDate(result, 2035, 6, 4);
});

test('addYears: adding zero years returns same date', () => {
  const result = DateUtils.addYears(new Date(2025, 3, 15), 0);
  assertDate(result, 2025, 3, 15);
});

test('addYears: negative years moves backwards', () => {
  const result = DateUtils.addYears(new Date(2025, 0, 1), -5);
  assertDate(result, 2020, 0, 1);
});

test('addYears: preserves month and day', () => {
  const result = DateUtils.addYears(new Date(2025, 11, 25), 3);
  assertDate(result, 2028, 11, 25);
});

test('addYears: does not mutate the input date', () => {
  const input  = new Date(2025, 0, 1);
  const before = input.getTime();
  DateUtils.addYears(input, 5);
  assert.strictEqual(input.getTime(), before, 'input date should not be mutated');
});
