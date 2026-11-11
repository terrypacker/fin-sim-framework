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

import { US_ROTH_CONVERSION, BRACKET_BASE_YEAR, ROTH_CONVERSION_ORDER, rothConversionDate } from '../../src/scenarios/toolsets/us-roth-conversion-toolset.js';
import { ACCOUNT_ROLES }               from '../../src/finance/state/account-roles.js';
import { usBracketGrossIncomeCeiling, usLtcgZeroBandGrossCeiling } from '../../src/finance/tax-settle-service.js';
import { RothConversionPolicyHandler, ltcgBandRoom } from '../../src/finance/account-rules/us/roth-conversion-classes.js';



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

  // incomeTarget is REAL base-year USD, compounded to the year's nominal.
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

test('the policy always fires on 31 Dec at the year-end order band (Roth study F6)', () => {
  const events = US_ROTH_CONVERSION.schedules(makeContext({ ...baseParams,
    rothConversionStartYear: 2031, rothConversionEndYear: 2032, rothConversionMaxBracket: 0.12 }));
  assert.deepEqual(events.map(e => new Date(e.date).toISOString().slice(0, 10)), ['2031-12-31', '2032-12-31']);
  // After 31 Dec's order-0 income (accretion), before harvest / inherited RA (50) and settle (100).
  assert.ok(events.every(e => e.order === ROTH_CONVERSION_ORDER));
  assert.ok(ROTH_CONVERSION_ORDER > 0 && ROTH_CONVERSION_ORDER < 50);
  assert.equal(rothConversionDate(2032).toISOString().slice(0, 10), '2032-12-31');
});

test('the month/day inputs are gone from the schema (retired on load)', () => {
  const keys = US_ROTH_CONVERSION.paramSchema({}).map(p => p.key);
  assert.ok(!keys.includes('rothConversionMonth') && !keys.includes('rothConversionDay'), keys.join(','));
});

// ── Gain-aware fill (rothConversionLtcgAware, Roth study F3) ─────────────────────

test('gain-aware: events carry the 0% band ceiling only when the switch is on', () => {
  const win = { ...baseParams, rothConversionStartYear: 2031, rothConversionEndYear: 2031, rothConversionMaxBracket: 0.12 };
  const [off] = US_ROTH_CONVERSION.schedules(makeContext(win));
  const [on]  = US_ROTH_CONVERSION.schedules(makeContext({ ...win, rothConversionLtcgAware: true }));
  assert.equal(off.data.ltcgCeiling, undefined, 'off ⇒ the event is unchanged');
  assert.ok(Math.abs(on.data.ltcgCeiling - usLtcgZeroBandGrossCeiling(2031, 0.03)) < 1e-6);
  // 2026 MFJ: 0% band to 98,900 taxable + 32,200 standard deduction.
  assert.equal(usLtcgZeroBandGrossCeiling(2026, 0.03), 131_100);
});

test('gain-aware: the band room nets ordinary, short-term and long-term gains', () => {
  assert.equal(ltcgBandRoom({ usOrdinaryIncomeYTD: 40_000, usCapitalGainsYTD: 50_000 }, 131_100), 41_100);
  // a short-term gain is ordinary; a short-term loss nets the long-term gain first
  assert.equal(ltcgBandRoom({ usOrdinaryIncomeYTD: 40_000, usShortTermCapitalGainsYTD: 10_000, usCapitalGainsYTD: 50_000 }, 131_100), 31_100);
  assert.equal(ltcgBandRoom({ usOrdinaryIncomeYTD: 40_000, usShortTermCapitalGainsYTD: -10_000, usCapitalGainsYTD: 50_000 }, 131_100), 51_100);
  assert.equal(ltcgBandRoom({ usOrdinaryIncomeYTD: 40_000, usCapitalGainsYTD: 200_000 }, 131_100), 0);
});

test('gain-aware: the policy converts the smaller of the bracket room and the band room', () => {
  const h = new RothConversionPolicyHandler();
  const state = { usOrdinaryIncomeYTD: 40_000, usCapitalGainsYTD: 80_000, iraAccount: { balance: 500_000 }, people: {} };
  const amt = (data) => (h.call({ state, data: { iraKey: 'iraAccount', rothKey: 'rothAccount', ...data } })
    .find(a => a.type === 'ROTH_CONVERSION_APPLY')?.amount) ?? 0;
  assert.equal(amt({ targetIncome: 133_000 }), 93_000, 'bracket room alone');
  assert.equal(amt({ targetIncome: 133_000, ltcgCeiling: 131_100 }), 11_100, 'capped where the gains would leave the 0% band');
  assert.equal(amt({ targetIncome: 50_000, ltcgCeiling: 131_100 }), 10_000, 'bracket room is still the cap when smaller');
  state.usCapitalGainsYTD = 150_000;
  assert.equal(amt({ targetIncome: 133_000, ltcgCeiling: 131_100 }), 0, 'gains already past the band ⇒ no conversion');
});

test('default window end is the year before the primary\'s RMD age (75 if born 1960+, else 73)', () => {
  const window = { ...baseParams, rothConversionStartYear: 2030, rothConversionEndYear: null, rothConversionMaxBracket: 0.12 };
  const lastYear = (birthDate) => {
    const ctx = makeContext(window);
    ctx.people = [{ ...ctx.people[0], birthDate }];
    const ev = US_ROTH_CONVERSION.schedules(ctx);
    return Math.max(...ev.map(yearOf));
  };
  assert.equal(lastYear('1965-01-01'), 1965 + 74, 'born 1965 → RMDs at 75 → last conversion year at 74');
  assert.equal(lastYear('1958-06-01'), 1958 + 72, 'born 1958 → RMDs at 73 → last conversion year at 72');
});
