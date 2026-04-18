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
 * person.test.mjs
 * Tests for Person and PersonService
 * Run with: node --test tests/person.test.mjs
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import { Person, PersonService } from '../assets/js/finance/person.js';

const svc = new PersonService();

// ── Person construction ───────────────────────────────────────────────────────

test('Person: sets id and birthDate', () => {
  const p = new Person('p1', new Date(1966, 0, 1));
  assert.strictEqual(p.id, 'p1');
  assert.deepStrictEqual(p.birthDate, new Date(1966, 0, 1));
});

test('Person: defaults name to empty string and isAuResident to false', () => {
  const p = new Person('p1', new Date(1966, 0, 1));
  assert.strictEqual(p.name, '');
  assert.strictEqual(p.isAuResident, false);
});

test('Person: opts override name and isAuResident', () => {
  const p = new Person('p2', new Date(1970, 5, 15), { name: 'Alice', isAuResident: true });
  assert.strictEqual(p.name, 'Alice');
  assert.strictEqual(p.isAuResident, true);
});

test('Person: is structuredClone-safe (plain data, no prototype methods)', () => {
  const p  = new Person('p1', new Date(1966, 0, 1), { name: 'Bob', isAuResident: true });
  const p2 = structuredClone(p);
  assert.strictEqual(p2.id,           'p1');
  assert.strictEqual(p2.name,         'Bob');
  assert.strictEqual(p2.isAuResident, true);
  assert.deepStrictEqual(p2.birthDate, p.birthDate);
});

// ── PersonService.getAge ──────────────────────────────────────────────────────

test('PersonService.getAge: returns correct whole years', () => {
  const p = new Person('p1', new Date(1966, 0, 1));
  assert.strictEqual(svc.getAge(p, new Date(2026, 0, 1)), 60); // exact birthday
  assert.strictEqual(svc.getAge(p, new Date(2026, 6, 1)), 60); // mid-year
});

test('PersonService.getAge: one day before birthday is still the previous year', () => {
  // Born Jan 1, 1966 — Dec 31, 2025 is still age 59
  const p = new Person('p1', new Date(1966, 0, 1));
  assert.strictEqual(svc.getAge(p, new Date(2025, 11, 31)), 59);
});

test('PersonService.getAge: exact birthday returns the new age', () => {
  const p = new Person('p1', new Date(1966, 6, 15)); // July 15
  assert.strictEqual(svc.getAge(p, new Date(2026, 6, 15)), 60); // exact
  assert.strictEqual(svc.getAge(p, new Date(2026, 6, 14)), 59); // one day before
});

test('PersonService.getAge: younger person (born 1990) returns 36 in 2026', () => {
  const p = new Person('p1', new Date(1990, 0, 1));
  assert.strictEqual(svc.getAge(p, new Date(2026, 3, 1)), 36);
});

// ── PersonService.getAgeDecimal ───────────────────────────────────────────────

test('PersonService.getAgeDecimal: returns decimal age above 59.5 for 401k gate', () => {
  // Born July 1, 1966 → exactly 59.5 on Jan 1, 2026
  const p = new Person('p1', new Date(1966, 6, 1));
  const age = svc.getAgeDecimal(p, new Date(2026, 6, 1)); // age 60.0
  assert.ok(age >= 59.5, `expected age >= 59.5, got ${age}`);
});

test('PersonService.getAgeDecimal: returns age below 59.5 before the gate', () => {
  // Born 1990 — well under 59.5 in 2026
  const p = new Person('p1', new Date(1990, 0, 1));
  const age = svc.getAgeDecimal(p, new Date(2026, 0, 15));
  assert.ok(age < 59.5, `expected age < 59.5, got ${age}`);
});
