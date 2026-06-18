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
 * residency-utils.test.mjs
 * Run with: node --test tests/unit/residency-utils.test.mjs
 */

import { test }  from 'node:test';
import assert    from 'node:assert/strict';

import {
  getResidency,
  isResident,
  residentsOf,
  getBirthDate,
} from '../../src/finance/residency-utils.js';

const BD = new Date(Date.UTC(1966, 0, 1));

function makeState(overrides = {}) {
  return {
    people: {
      primary: { residency: 'US', birthDate: BD },
      spouse:  { residency: 'AU', birthDate: new Date(Date.UTC(1970, 5, 15)) },
    },
    ...overrides,
  };
}

// ── getResidency ──────────────────────────────────────────────────────────────

test('getResidency: returns country code for known personKey', () => {
  const state = makeState();
  assert.strictEqual(getResidency(state, 'primary'), 'US');
  assert.strictEqual(getResidency(state, 'spouse'),  'AU');
});

test('getResidency: returns null for unknown personKey', () => {
  const state = makeState();
  assert.strictEqual(getResidency(state, 'unknown'), null);
});

test('getResidency: returns null when state.people is missing', () => {
  assert.strictEqual(getResidency({}, 'primary'), null);
});

// ── isResident ────────────────────────────────────────────────────────────────

test('isResident: true when residency matches country', () => {
  const state = makeState();
  assert.ok(isResident(state, 'spouse', 'AU'));
  assert.ok(isResident(state, 'primary', 'US'));
});

test('isResident: false when residency does not match country', () => {
  const state = makeState();
  assert.ok(!isResident(state, 'primary', 'AU'));
  assert.ok(!isResident(state, 'spouse',  'US'));
});

test('isResident: false for unknown personKey', () => {
  const state = makeState();
  assert.ok(!isResident(state, 'child', 'AU'));
});

// ── residentsOf ───────────────────────────────────────────────────────────────

test('residentsOf: returns keys of all persons with matching residency', () => {
  const state = makeState();
  assert.deepStrictEqual(residentsOf(state, 'AU'), ['spouse']);
  assert.deepStrictEqual(residentsOf(state, 'US'),  ['primary']);
});

test('residentsOf: returns empty array when no one matches', () => {
  const state = makeState();
  assert.deepStrictEqual(residentsOf(state, 'GBR'), []);
});

test('residentsOf: returns empty array when state.people is missing', () => {
  assert.deepStrictEqual(residentsOf({}, 'AU'), []);
});

test('residentsOf: multiple residents of same country', () => {
  const state = {
    people: {
      primary: { residency: 'AU' },
      spouse:  { residency: 'AU' },
    },
  };
  const keys = residentsOf(state, 'AU').sort();
  assert.deepStrictEqual(keys, ['primary', 'spouse']);
});

// ── getBirthDate ──────────────────────────────────────────────────────────────

test('getBirthDate: returns Date when person.birthDate is a Date', () => {
  const state = makeState();
  const bd = getBirthDate(state, 'primary');
  assert.ok(bd instanceof Date);
  assert.strictEqual(bd.getTime(), BD.getTime());
});

test('getBirthDate: parses string birthDate to Date', () => {
  const state = {
    people: { primary: { residency: 'US', birthDate: '1966-01-01T00:00:00.000Z' } },
  };
  const bd = getBirthDate(state, 'primary');
  assert.ok(bd instanceof Date);
  assert.strictEqual(bd.getUTCFullYear(), 1966);
});

test('getBirthDate: returns null for unknown personKey', () => {
  const state = makeState();
  assert.strictEqual(getBirthDate(state, 'unknown'), null);
});

test('getBirthDate: returns null when state.people is missing', () => {
  assert.strictEqual(getBirthDate({}, 'primary'), null);
});
