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
 * golden-sync-invariant.test.mjs — the §4.4 checker itself.
 *
 * `golden-scenarios.test.mjs` runs `findOutOfSync` over every golden's end state; these
 * hold the checker to its own contract, because a gate that silently stops catching things
 * is worse than no gate. The two that matter most are the scoping decisions: an EMPTY
 * holdings array must be checked (it is the exact shape of design 106 §4b's F7), and a
 * LOAN must not be (its balance is debt owed, design 54 §8).
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import { findOutOfSync, syncTolerance } from '../helpers/golden-harness.js';

const keys = (state) => findOutOfSync(state).map(f => f.stateKey);

test('SYNC-1: an account whose balance matches its lots is not reported', () => {
  assert.deepEqual(keys({ a: { balance: 100, holdings: [{ marketValue: 100 }] } }), []);
});

test('SYNC-2: a dime adrift on a single lot IS reported', () => {
  // The old flat ±$1.00 tolerance in holdings-invariant.test.mjs would pass this.
  assert.deepEqual(keys({ a: { balance: 100.1, holdings: [{ marketValue: 100 }] } }), ['a']);
});

test('SYNC-3: accumulated cent-rounding across many lots is tolerated', () => {
  // Half a cent per lot is what rounding each `marketValue` to the cent can produce; the
  // largest real drift measured across the goldens is 2c on a 13-lot super account.
  const lots = Array.from({ length: 13 }, () => ({ marketValue: 100 / 13 }));
  assert.deepEqual(keys({ a: { balance: 100.02, holdings: lots } }), []);
  assert.ok(syncTolerance(13) > 0.02 && syncTolerance(13) < 0.1,
    'the slack must cover measured rounding without hiding a dime');
});

test('SYNC-4: a balance with NO lots behind it is reported — the F7 shape', () => {
  // `holdingsOutOfSync` in holding-utils.js returns false here, correctly for the load
  // path it serves. Reusing it would have skipped the defect this check exists to find.
  assert.deepEqual(keys({ a: { balance: 31797.61, holdings: [] } }), ['a']);
});

test('SYNC-5: a liability is not a violation', () => {
  // A loan's balance is debt owed and it holds nothing (design 54 §8), so Σ 0 is correct.
  assert.deepEqual(keys({ a: { type: 'loan', balance: 249669.02, holdings: [] } }), []);
});

test('SYNC-6: understatement is caught as well as invention', () => {
  // The two known violations point in opposite directions: F7 invents money, while
  // us-single-homeowner's drained cash account hides $3,000 in a sleeve.
  assert.deepEqual(keys({ a: { balance: 0, holdings: [{ marketValue: 3000 }] } }), ['a']);
});

test('SYNC-7: non-account state entries are ignored', () => {
  assert.deepEqual(keys({
    a: { balance: 5 },                 // no holdings array — not holdings-bearing
    b: 7, c: null, d: 'x',             // scalars and nulls share the state namespace
    e: { holdings: [{ marketValue: 9 }] }, // no numeric balance
  }), []);
});

test('SYNC-8: the report says what moved, by how much, and over how many lots', () => {
  const [f] = findOutOfSync({ auStockAccount: { balance: 31797.61, holdings: [] } });
  assert.match(f.line, /auStockAccount: balance 31797\.61 vs Σ holdings 0\.00 \(\+31797\.61, 0 lot\(s\)\)/);
  assert.equal(f.delta, 31797.61);
  assert.equal(f.lots, 0);
});
