/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { test, describe } from 'node:test';
import assert             from 'node:assert/strict';

import { resolveScheduledRate } from '../../src/finance/holdings/appreciation-schedule-utils.js';
import { computeHoldingsGrowth } from '../../src/finance/holdings/holdings-earnings.js';
import { Holding }              from '../../src/finance/holdings/holding.js';
import { ALLOCATION }           from '../../src/finance/holdings/allocation.js';

// ─── resolveScheduledRate ─────────────────────────────────────────────────────

describe('resolveScheduledRate', () => {
  const d = (y, m = 1, d_ = 1) => new Date(Date.UTC(y, m - 1, d_));

  test('returns fallbackRate when schedule is null', () => {
    assert.equal(resolveScheduledRate(null, d(2030), 0.05), 0.05);
  });

  test('returns fallbackRate when schedule is empty', () => {
    assert.equal(resolveScheduledRate([], d(2030), 0.05), 0.05);
  });

  test('returns fallbackRate when all entries are in the future', () => {
    const schedule = [{ date: d(2035), rate: 0.03 }];
    assert.equal(resolveScheduledRate(schedule, d(2030), 0.05), 0.05);
  });

  test('picks the most recent entry on or before currentDate', () => {
    const schedule = [
      { date: d(2026, 1, 1), rate: 0.06 },
      { date: d(2030, 1, 1), rate: 0.04 },
      { date: d(2035, 1, 1), rate: 0.03 },
    ];
    assert.equal(resolveScheduledRate(schedule, d(2028), 0.05), 0.06);
    assert.equal(resolveScheduledRate(schedule, d(2031), 0.05), 0.04);
    assert.equal(resolveScheduledRate(schedule, d(2036), 0.05), 0.03);
  });

  test('exact boundary date picks the entry at that date', () => {
    const schedule = [
      { date: d(2030, 1, 1), rate: 0.04 },
      { date: d(2035, 1, 1), rate: 0.03 },
    ];
    assert.equal(resolveScheduledRate(schedule, d(2030, 1, 1), 0.05), 0.04);
    assert.equal(resolveScheduledRate(schedule, d(2035, 1, 1), 0.05), 0.03);
  });

  test('works with string dates in schedule', () => {
    const schedule = [{ date: '2030-06-01', rate: 0.04 }];
    assert.equal(resolveScheduledRate(schedule, new Date('2031-01-01'), 0.05), 0.04);
  });

  test('handles unsorted input by returning the most recent applicable entry', () => {
    const schedule = [
      { date: d(2035), rate: 0.03 },
      { date: d(2026), rate: 0.06 },
      { date: d(2030), rate: 0.04 },
    ];
    assert.equal(resolveScheduledRate(schedule, d(2031), 0.05), 0.04);
  });
});

// ─── computeHoldingsGrowth with appreciationSchedule ─────────────────────────

describe('computeHoldingsGrowth with appreciationSchedule', () => {
  const d = (y) => new Date(Date.UTC(y, 0, 1));

  test('schedule overrides effective rate for the matching holding', () => {
    const h1 = new Holding({
      id: 'h1', allocation: ALLOCATION.EQUITY, marketValue: 100_000, rateKey: 'EQUITY_US',
      appreciationSchedule: [
        { date: d(2026), rate: 0.06 },
        { date: d(2030), rate: 0.04 },
      ],
    });
    h1.id = 'h1';
    const state = {
      testAccount: { balance: 100_000, holdings: [h1] },
      effectiveGrowthRates: { EQUITY_US: 0.07 },
    };
    // Before 2030 → uses 0.06 (not regime 0.07)
    const { amount } = computeHoldingsGrowth({
      state, stateKey: 'testAccount', fallbackRate: 0.07,
      fallbackRateKey: 'EQUITY_US', currentDate: d(2028),
    });
    assert.equal(amount, +(100_000 * 0.06).toFixed(2));
  });

  test('no-schedule holding uses the effective rate unchanged', () => {
    const h1 = new Holding({
      id: 'h1', allocation: ALLOCATION.EQUITY, marketValue: 100_000, rateKey: 'EQUITY_US',
    });
    const state = {
      testAccount: { balance: 100_000, holdings: [h1] },
      effectiveGrowthRates: { EQUITY_US: 0.07 },
    };
    const { amount } = computeHoldingsGrowth({
      state, stateKey: 'testAccount', fallbackRate: 0.07,
      fallbackRateKey: 'EQUITY_US', currentDate: new Date(Date.UTC(2028, 0, 1)),
    });
    assert.equal(amount, +(100_000 * 0.07).toFixed(2));
  });

  test('schedule steps at boundary: two holdings with distinct schedules', () => {
    const h1 = new Holding({
      id: 'h1', allocation: ALLOCATION.EQUITY, marketValue: 50_000, rateKey: 'EQUITY_US',
      appreciationSchedule: [{ date: new Date(Date.UTC(2030, 0, 1)), rate: 0.04 }],
    });
    const h2 = new Holding({
      id: 'h2', allocation: ALLOCATION.EQUITY, marketValue: 50_000, rateKey: 'EQUITY_US',
    });
    const state = {
      testAccount: { balance: 100_000, holdings: [h1, h2] },
      effectiveGrowthRates: { EQUITY_US: 0.07 },
    };
    const { amount } = computeHoldingsGrowth({
      state, stateKey: 'testAccount', fallbackRate: 0.07,
      fallbackRateKey: 'EQUITY_US', currentDate: new Date(Date.UTC(2031, 0, 1)),
    });
    const expected = +(50_000 * 0.04 + 50_000 * 0.07).toFixed(2);
    assert.equal(amount, expected);
  });
});
