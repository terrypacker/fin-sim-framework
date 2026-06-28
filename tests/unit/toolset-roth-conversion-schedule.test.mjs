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
 * toolset-roth-conversion-schedule.test.mjs
 *
 * Unit tests for design 39 §12 / Step 8 — wiring the per-year income-target
 * `rothConversionSchedule` into US_ROTH_CONVERSION.schedules().
 *
 * schedules() is a pure function of `context`, so these tests build a minimal
 * context and assert the emitted ROTH_CONVERSION_POLICY_EVALUATE events directly
 * (no full toolset/sim setup needed).
 *
 * Run with: node --test tests/unit/toolset-roth-conversion-schedule.test.mjs
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import { US_ROTH_CONVERSION }          from '../../src/scenarios/toolsets/us-roth-conversion-toolset.js';
import { ACCOUNT_ROLES }               from '../../src/finance/state/account-roles.js';
import { usBracketGrossIncomeCeiling } from '../../src/finance/tax/us/us-tax-rates-2025.js';

const BRACKET_BASE_YEAR = 2025;

/** Build a minimal schedules() context with a primary IRA + Roth pair. */
function makeContext(parameters) {
  return {
    parameters,
    people: [{ id: 'p1', name: 'Pat', birthDate: '1965-01-01', retirementDate: '2030-01-01' }],
    accounts: [
      { role: ACCOUNT_ROLES.IRA,  ownerId: 'p1', stateKey: 'iraAccount'  },
      { role: ACCOUNT_ROLES.ROTH, ownerId: 'p1', stateKey: 'rothAccount' },
    ],
    startDate: new Date(Date.UTC(2026, 0, 1)),
  };
}

const baseParams = {
  rothConversionEnabled: true,
  rothConversionOwner:   'primary',
  rothConversionMonth:   12,
  rothConversionDay:     1,
  inflationRate:         0.03,
};

const targetOf = (e) => e.data.targetIncome;
const yearOf   = (e) => new Date(e.date).getUTCFullYear();

test('disabled master switch emits nothing', () => {
  const events = US_ROTH_CONVERSION.schedules(makeContext({ ...baseParams, rothConversionEnabled: false }));
  assert.equal(events.length, 0);
});

test('per-year incomeTarget schedule emits one event per scheduled year, compounded from base year', () => {
  const schedule = [
    { year: 2031, incomeTarget: 100_000 },
    { year: 2033, incomeTarget: 150_000 },
  ];
  const events = US_ROTH_CONVERSION.schedules(makeContext({ ...baseParams, rothConversionSchedule: schedule }));

  assert.equal(events.length, 2, 'one event per scheduled year');
  assert.deepEqual(events.map(yearOf), [2031, 2033]);
  assert.equal(events.every(e => e.type === 'ROTH_CONVERSION_POLICY_EVALUATE'), true);

  // incomeTarget is REAL base-year (2025) USD, compounded to the year's nominal.
  const expect2031 = 100_000 * Math.pow(1.03, 2031 - BRACKET_BASE_YEAR);
  const expect2033 = 150_000 * Math.pow(1.03, 2033 - BRACKET_BASE_YEAR);
  assert.ok(Math.abs(targetOf(events[0]) - expect2031) < 1e-6);
  assert.ok(Math.abs(targetOf(events[1]) - expect2033) < 1e-6);

  // Carries the IRA/Roth state keys for the policy handler.
  assert.equal(events[0].data.iraKey,  'iraAccount');
  assert.equal(events[0].data.rothKey, 'rothAccount');
});

test('skip-years: years absent from the schedule are not converted', () => {
  const schedule = [
    { year: 2031, incomeTarget: 100_000 },
    { year: 2035, incomeTarget: 100_000 },
  ];
  const events = US_ROTH_CONVERSION.schedules(makeContext({ ...baseParams, rothConversionSchedule: schedule }));
  assert.deepEqual(events.map(yearOf), [2031, 2035], '2032–2034 are skipped, not filled');
});

test('OFF / non-finite targets are dropped (no event)', () => {
  const schedule = [
    { year: 2031, incomeTarget: 100_000 },
    { year: 2032 },                           // neither incomeTarget nor bracketCeiling
    { year: 2033, incomeTarget: null },       // explicit OFF
    { year: 2034, incomeTarget: -5_000 },     // negative → dropped
  ];
  const events = US_ROTH_CONVERSION.schedules(makeContext({ ...baseParams, rothConversionSchedule: schedule }));
  assert.deepEqual(events.map(yearOf), [2031], 'only the finite, non-negative target survives');
});

test('legacy bracketCeiling entries are still accepted and resolved via the bracket ceiling', () => {
  const schedule = [{ year: 2031, bracketCeiling: 0.22 }];
  const events = US_ROTH_CONVERSION.schedules(makeContext({ ...baseParams, rothConversionSchedule: schedule }));
  assert.equal(events.length, 1);
  assert.equal(targetOf(events[0]), usBracketGrossIncomeCeiling(0.22, 2031, 0.03));
});

test('empty schedule falls back to the legacy start/end/maxBracket window (back-compat)', () => {
  const windowParams = {
    ...baseParams,
    rothConversionSchedule: [],
    rothConversionStartYear: 2030,
    rothConversionEndYear:   2032,
    rothConversionMaxBracket: 0.24,
  };
  const events = US_ROTH_CONVERSION.schedules(makeContext(windowParams));

  assert.deepEqual(events.map(yearOf), [2030, 2031, 2032], 'one event per year in [start, end]');
  for (const e of events) {
    assert.equal(targetOf(e), usBracketGrossIncomeCeiling(0.24, yearOf(e), 0.03));
  }
});

test('a non-empty schedule overrides the window entirely', () => {
  const params = {
    ...baseParams,
    rothConversionStartYear: 2030,
    rothConversionEndYear:   2040,
    rothConversionMaxBracket: 0.24,
    rothConversionSchedule:  [{ year: 2031, incomeTarget: 100_000 }],
  };
  const events = US_ROTH_CONVERSION.schedules(makeContext(params));
  assert.deepEqual(events.map(yearOf), [2031], 'window is ignored when a schedule is present');
});
