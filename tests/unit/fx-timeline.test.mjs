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
 * fx-timeline.test.mjs — the run's FX path, recovered from the journal.
 *
 * The reporting layer had exactly one rate available to it: `taxFxRate`, stamped once a
 * year at the settlement. Its own header says that is a year-end benchmark and not what
 * each item accrued at — so a January foreign disposal reached Form 8949 restated at a
 * December rate that never applied to it.
 *
 * Run with: node --test tests/unit/fx-timeline.test.mjs
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import { FxTimeline, convertAtRate } from '../../src/finance/tax/fx-timeline.js';

const FIELD = 'effectiveExchangeRates.USD_AUD';

/** A journal entry that moves the rate. */
const move = (dateMs, before, after) => ({
  date:      new Date(dateMs),
  action:    { type: 'RECOMPUTE_REGIMES' },
  stateDiff: [{ field: FIELD, before, after }],
});

/** A journal entry that does not. */
const plain = dateMs => ({ date: new Date(dateMs), action: { type: 'STOCK_WITHDRAWAL_TAX' } });

test('FX-1: the rate a run never moves is still recoverable, from the first diff’s `before`', () => {
  // The journal records only CHANGES. Without seeding from `before`, a scenario whose
  // rate is pinned — the common case — would have every disposal fall off the front of
  // the timeline and take the null path.
  const fx = new FxTimeline([plain(Date.UTC(2032, 0, 1)), move(Date.UTC(2032, 5, 1), 1.55, 1.55)]);
  assert.strictEqual(fx.at(0), 1.55, 'in force before the recorded move');
  assert.strictEqual(fx.at(1), 1.55);
});

test('FX-2: `at` returns the last move at or before a journal position', () => {
  const fx = new FxTimeline([
    move(Date.UTC(2032, 0, 1), 1.55, 1.60),   // 0
    plain(Date.UTC(2032, 2, 1)),              // 1
    move(Date.UTC(2032, 5, 1), 1.60, 1.20),   // 2
    plain(Date.UTC(2032, 8, 1)),              // 3
  ]);
  assert.strictEqual(fx.at(-1), 1.55, 'the seeded opening rate');
  assert.strictEqual(fx.at(0),  1.60);
  assert.strictEqual(fx.at(1),  1.60, 'unchanged between moves');
  assert.strictEqual(fx.at(2),  1.20);
  assert.strictEqual(fx.at(3),  1.20);
});

test('FX-3: several moves on one date resolve by POSITION, and `onDate` reports the close', () => {
  // Real journals do this every 1 January: FxRefreshReducer mirrors base → effective,
  // then RegimeApplyReducer overwrites it. "The rate on that date" is ambiguous; "the
  // rate at position i" is not, which is why the disposal register keys on position.
  const d  = Date.UTC(2032, 0, 1);
  const fx = new FxTimeline([
    move(d, 1.63, 1.55),   // 0 — the period-advance mirror
    move(d, 1.55, 1.63),   // 1 — the regime overwrite
    plain(d),              // 2
  ]);
  assert.strictEqual(fx.at(0), 1.55, 'mid-day, between the two reducers');
  assert.strictEqual(fx.at(1), 1.63);
  assert.strictEqual(fx.onDate(new Date(d)), 1.63, 'the value the day came to rest on');
});

test('FX-4: a run that records no rate answers null, never a silent 1.0', () => {
  // A single-country scenario. Reporting 1.0 would assert parity between two currencies
  // the run never priced against each other — the failure mode `taxFxRate` documents.
  const fx = new FxTimeline([plain(Date.UTC(2032, 0, 1))]);
  assert.ok(fx.isEmpty);
  assert.strictEqual(fx.at(0), null);
  assert.strictEqual(fx.onDate(new Date(Date.UTC(2032, 0, 1))), null);
});

test('FX-5: `onDate` tolerates the date forms a journal actually carries', () => {
  const fx = new FxTimeline([move(Date.UTC(2032, 5, 1), 1.55, 1.40)]);
  for (const d of [new Date(Date.UTC(2032, 7, 1)), Date.UTC(2032, 7, 1), '2032-08-01']) {
    assert.strictEqual(fx.onDate(d), 1.40, `accepts ${typeof d}`);
  }
  assert.strictEqual(fx.onDate('not a date'), null);
  assert.strictEqual(fx.onDate(null),         null);
});

test('FX-6: convertAtRate crosses in both directions and refuses to guess', () => {
  assert.strictEqual(convertAtRate(1_550, 'AUD', 'USD', 1.55), 1_000);
  assert.strictEqual(convertAtRate(1_000, 'USD', 'AUD', 1.55), 1_550);
  assert.strictEqual(convertAtRate(1_000, 'USD', 'USD', 1.55), 1_000, 'same currency is a no-op');
  // No rate ⇒ the amount is returned untouched rather than scaled by a fabricated one.
  // The caller decides what an unpriced foreign figure means; this must not decide for it.
  assert.strictEqual(convertAtRate(1_550, 'AUD', 'USD', null), 1_550);
  assert.strictEqual(convertAtRate(1_550, 'AUD', 'USD', 0),    1_550);
  assert.strictEqual(convertAtRate(null,  'AUD', 'USD', 1.55), null);
});
